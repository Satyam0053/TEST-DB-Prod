/**
 * ArtworkService.gs
 * Phase 10 deliverable. Artwork (printing/embroidery/sublimation) sent out
 * to a vendor for panels, received back with a QC verdict, plus the
 * aging/reject%/yield% figures the Artwork module screen needs.
 *
 * ES5 only.
 *
 * artwork.chk_artwork_accept_reject (accepted_qty + rejected_qty <=
 * panels_received_qty) is enforced by the DB - checked here first too, same
 * rationale as elsewhere in this project (immediate specific message before
 * a round trip).
 */

var ArtworkService = (function () {

  var ARTWORK_TYPE_VALUES = ['Printing', 'Embroidery', 'Sublimation', 'Other'];
  var ARTWORK_STATUS_VALUES = ['Issued', 'Partially Received', 'Received', 'Closed'];

  // agingDays: days between issue and (received_date, or today if still out).
  // yieldPct: accepted_qty / panels_issued_qty. rejectPct: rejected_qty /
  // panels_received_qty. NULLIF guards both against a divide-by-zero before
  // anything has been received yet (MySQL 8's strict sql_mode -
  // ERROR_FOR_DIVISION_BY_ZERO - turns an unguarded x/0 into a hard error,
  // not just a NULL, so this can't be skipped).
  var SELECT_COLUMNS =
    'aw.*, ' +
    'DATEDIFF(COALESCE(aw.received_date, CURDATE()), aw.issue_date) AS aging_days, ' +
    'ROUND(aw.accepted_qty / NULLIF(aw.panels_issued_qty, 0) * 100, 2) AS yield_pct, ' +
    'ROUND(aw.rejected_qty / NULLIF(aw.panels_received_qty, 0) * 100, 2) AS reject_pct';

  function getArtwork_(artworkId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT ' + SELECT_COLUMNS + ', jc.job_card_no, v.vendor_name ' +
      'FROM artwork aw ' +
      'JOIN job_cards jc ON jc.job_card_id = aw.job_card_id ' +
      'JOIN vendors v ON v.vendor_id = aw.vendor_id ' +
      'WHERE aw.artwork_id = ? LIMIT 1',
      [artworkId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------

  function issueArtwork(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'artwork.edit')) {
      return errorResponse_('You do not have permission to issue artwork.');
    }
    if (!input || !isPositiveInteger_(input.jobCardId) || !isPositiveInteger_(input.vendorId)) {
      return errorResponse_('jobCardId and vendorId are required.');
    }
    if (!isValidEnum_(input.artworkType, ARTWORK_TYPE_VALUES)) {
      return errorResponse_('artworkType must be one of: ' + ARTWORK_TYPE_VALUES.join(', '));
    }
    if (!isPositiveInteger_(input.panelsIssuedQty)) { return errorResponse_('panelsIssuedQty must be a positive integer.'); }

    var jcRows = DatabaseService.executeQuery('SELECT job_card_id FROM job_cards WHERE job_card_id = ?', [input.jobCardId]);
    if (jcRows.length === 0) { return errorResponse_('Job card not found.'); }
    var vRows = DatabaseService.executeQuery('SELECT vendor_id FROM vendors WHERE vendor_id = ? AND is_active = 1', [input.vendorId]);
    if (vRows.length === 0) { return errorResponse_('Vendor not found or is inactive.'); }

    var issueDate = input.issueDate || formatDateForMySQL_(new Date());

    var newArtworkId = DatabaseService.executeTransaction(function (conn) {
      var artworkId = DatabaseService.executeInsert(
        "INSERT INTO artwork (job_card_id, vendor_id, artwork_type, panels_issued_qty, issue_date, expected_date, remarks, created_by, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Issued')",
        [input.jobCardId, input.vendorId, input.artworkType, input.panelsIssuedQty, issueDate, input.expectedDate || null, input.remarks || null, user.userId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Artwork', ?, ?)",
        [user.userId, String(artworkId), JSON.stringify({ jobCardId: input.jobCardId, vendorId: input.vendorId, panelsIssuedQty: input.panelsIssuedQty })],
        conn
      );
      return artworkId;
    });

    return successResponse_(getArtwork_(newArtworkId, null), 'Artwork issued.');
  }

  /**
   * Records what came back from the vendor plus the QC split. Cumulative
   * across calls (e.g. a first partial receipt, then the remainder later) -
   * panelsReceivedQty/acceptedQty/rejectedQty are running totals, matching
   * how updateStageProgress/recordBundleProgress treat quantities elsewhere
   * in this project.
   */
  function receiveArtwork(sessionId, artworkId, panelsReceivedQty, acceptedQty, rejectedQty, remarks) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'artwork.edit')) {
      return errorResponse_('You do not have permission to update artwork.');
    }
    if (!isPositiveInteger_(artworkId)) { return errorResponse_('A valid artworkId is required.'); }
    panelsReceivedQty = Number(panelsReceivedQty) || 0;
    acceptedQty = Number(acceptedQty) || 0;
    rejectedQty = Number(rejectedQty) || 0;
    if (panelsReceivedQty < 0 || acceptedQty < 0 || rejectedQty < 0) {
      return errorResponse_('Quantities cannot be negative.');
    }

    var artwork = getArtwork_(artworkId, null);
    if (!artwork) { return errorResponse_('Artwork record not found.'); }
    if (artwork.status === 'Closed') { return errorResponse_('This artwork record is closed.'); }
    if (panelsReceivedQty > Number(artwork.panels_issued_qty)) {
      return errorResponse_('panelsReceivedQty (' + panelsReceivedQty + ') cannot exceed panels issued (' + artwork.panels_issued_qty + ').');
    }
    if (acceptedQty + rejectedQty > panelsReceivedQty) {
      return errorResponse_('accepted + rejected (' + (acceptedQty + rejectedQty) + ') cannot exceed panels received (' + panelsReceivedQty + ').');
    }

    var isFullyReceived = panelsReceivedQty >= Number(artwork.panels_issued_qty);
    var newStatus = isFullyReceived ? 'Received' : 'Partially Received';
    var today = formatDateForMySQL_(new Date());

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE artwork SET panels_received_qty = ?, accepted_qty = ?, rejected_qty = ?, status = ?, received_date = ?, remarks = ? WHERE artwork_id = ?',
        [panelsReceivedQty, acceptedQty, rejectedQty, newStatus, today, remarks || artwork.remarks, artworkId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'QC Approval', 'Artwork', ?, ?)",
        [user.userId, String(artworkId), JSON.stringify({ panelsReceivedQty: panelsReceivedQty, acceptedQty: acceptedQty, rejectedQty: rejectedQty, status: newStatus })],
        conn
      );
      return null;
    });

    return successResponse_(getArtwork_(artworkId, null), 'Artwork receipt recorded.');
  }

  function closeArtwork(sessionId, artworkId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'artwork.edit')) {
      return errorResponse_('You do not have permission to update artwork.');
    }
    var artwork = getArtwork_(artworkId, null);
    if (!artwork) { return errorResponse_('Artwork record not found.'); }
    if (artwork.status !== 'Received') {
      return errorResponse_('Only a fully Received artwork record can be closed (current status: ' + artwork.status + ').');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate("UPDATE artwork SET status = 'Closed' WHERE artwork_id = ?", [artworkId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Artwork', ?, ?, ?)",
        [user.userId, String(artworkId), JSON.stringify({ status: 'Received' }), JSON.stringify({ status: 'Closed' })],
        conn
      );
      return null;
    });

    return successResponse_(getArtwork_(artworkId, null), 'Artwork record closed.');
  }

  function getArtworkRecord(sessionId, artworkId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'artwork.view')) {
      return errorResponse_('You do not have permission to view artwork.');
    }
    if (!isPositiveInteger_(artworkId)) { return errorResponse_('A valid artworkId is required.'); }
    var artwork = getArtwork_(artworkId, null);
    if (!artwork) { return errorResponse_('Artwork record not found.'); }
    return successResponse_(artwork);
  }

  function listArtwork(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'artwork.view')) {
      return errorResponse_('You do not have permission to view artwork.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('aw.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isPositiveInteger_(filters.vendorId)) { where.push('aw.vendor_id = ?'); params.push(filters.vendorId); }
    if (isNonEmptyString_(filters.status) && isValidEnum_(filters.status, ARTWORK_STATUS_VALUES)) {
      where.push('aw.status = ?'); params.push(filters.status);
    }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM artwork aw ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT ' + SELECT_COLUMNS + ', jc.job_card_no, v.vendor_name ' +
      'FROM artwork aw ' +
      'JOIN job_cards jc ON jc.job_card_id = aw.job_card_id ' +
      'JOIN vendors v ON v.vendor_id = aw.vendor_id ' +
      whereSql + ' ORDER BY aw.artwork_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  return {
    issueArtwork: withErrorHandling_(issueArtwork),
    receiveArtwork: withErrorHandling_(receiveArtwork),
    closeArtwork: withErrorHandling_(closeArtwork),
    getArtwork: withErrorHandling_(getArtworkRecord),
    listArtwork: withErrorHandling_(listArtwork)
  };
})();
