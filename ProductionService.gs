/**
 * ProductionService.gs
 * Phase 9 deliverable. Production-bundle tracking on the shop floor: create
 * a bundle against a job card/line/operator, start it, record completed/
 * rejected/rework quantities as work progresses, hold/resume, cancel.
 *
 * ES5 only.
 *
 * production_bundles.chk_bundle_qty (completed_qty + rejected_qty +
 * rework_qty <= issued_qty) is enforced by the DB - this file still checks
 * it up front for an immediate, specific message (same rationale as
 * FMSService's status-shape checks; see that file's header comment).
 */

var ProductionService = (function () {

  var BUNDLE_STATUS_VALUES = ['Pending', 'In Progress', 'Completed', 'Hold', 'Cancelled'];

  function generateBundleNo_(conn, jobCardId) {
    var rows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS cnt FROM production_bundles WHERE job_card_id = ?',
      [jobCardId],
      conn
    );
    var seq = Number(rows[0].cnt) + 1;
    return 'BND-' + ('000' + seq).slice(-3);
  }

  function getBundle_(bundleId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT pb.*, jc.job_card_no, pl.line_name, e.full_name AS operator_name ' +
      'FROM production_bundles pb ' +
      'JOIN job_cards jc ON jc.job_card_id = pb.job_card_id ' +
      'LEFT JOIN production_lines pl ON pl.line_id = pb.line_id ' +
      'LEFT JOIN employees e ON e.employee_id = pb.operator_id ' +
      'WHERE pb.bundle_id = ? LIMIT 1',
      [bundleId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------

  function createBundle(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to create production bundles.');
    }
    if (!input || !isPositiveInteger_(input.jobCardId)) { return errorResponse_('A valid jobCardId is required.'); }
    if (!isPositiveInteger_(input.issuedQty)) { return errorResponse_('issuedQty must be a positive integer.'); }

    var jcRows = DatabaseService.executeQuery('SELECT job_card_id FROM job_cards WHERE job_card_id = ?', [input.jobCardId]);
    if (jcRows.length === 0) { return errorResponse_('Job card not found.'); }
    if (input.lineId && !isPositiveInteger_(input.lineId)) { return errorResponse_('lineId must be a positive integer.'); }
    if (input.operatorId && !isPositiveInteger_(input.operatorId)) { return errorResponse_('operatorId must be a positive integer.'); }

    var newBundleId = DatabaseService.executeTransaction(function (conn) {
      var bundleNo = generateBundleNo_(conn, input.jobCardId);
      var bundleId = DatabaseService.executeInsert(
        "INSERT INTO production_bundles (bundle_no, job_card_id, line_id, operator_id, issued_qty, status) " +
        "VALUES (?, ?, ?, ?, ?, 'Pending')",
        [bundleNo, input.jobCardId, input.lineId || null, input.operatorId || null, input.issuedQty],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Production', ?, ?)",
        [user.userId, String(bundleId), JSON.stringify({ bundleNo: bundleNo, jobCardId: input.jobCardId, issuedQty: input.issuedQty })],
        conn
      );
      return bundleId;
    });

    return successResponse_(getBundle_(newBundleId, null), 'Bundle created.');
  }

  function startBundle(sessionId, bundleId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to update production bundles.');
    }
    if (!isPositiveInteger_(bundleId)) { return errorResponse_('A valid bundleId is required.'); }

    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    if (bundle.status !== 'Pending') { return errorResponse_('Only a Pending bundle can be started (current status: ' + bundle.status + ').'); }

    var now = new Date();
    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        "UPDATE production_bundles SET status = 'In Progress', start_time = ? WHERE bundle_id = ?",
        [formatDateTimeForMySQL_(now), bundleId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Status Change', 'Production', ?, ?)",
        [user.userId, String(bundleId), JSON.stringify({ status: 'In Progress' })],
        conn
      );
      return null;
    });

    return successResponse_(getBundle_(bundleId, null), 'Bundle started.');
  }

  /**
   * Records (cumulative, not delta) completed/rejected/rework quantities.
   * Auto-transitions to Completed (and sets end_time) once the three add up
   * to issued_qty.
   */
  function recordBundleProgress(sessionId, bundleId, completedQty, rejectedQty, reworkQty, remarks) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to update production bundles.');
    }
    if (!isPositiveInteger_(bundleId)) { return errorResponse_('A valid bundleId is required.'); }
    completedQty = Number(completedQty) || 0;
    rejectedQty = Number(rejectedQty) || 0;
    reworkQty = Number(reworkQty) || 0;
    if (completedQty < 0 || rejectedQty < 0 || reworkQty < 0) {
      return errorResponse_('Quantities cannot be negative.');
    }

    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    if (bundle.status === 'Pending') { return errorResponse_('Start this bundle before recording progress.'); }
    if (bundle.status === 'Completed' || bundle.status === 'Cancelled') {
      return errorResponse_('This bundle is already ' + bundle.status + ' and cannot be updated.');
    }
    if (bundle.status === 'Hold') { return errorResponse_('This bundle is on hold - resume it before recording progress.'); }

    var total = completedQty + rejectedQty + reworkQty;
    if (total > Number(bundle.issued_qty)) {
      return errorResponse_('completed + rejected + rework (' + total + ') cannot exceed issued qty (' + bundle.issued_qty + ').');
    }

    var isDone = total === Number(bundle.issued_qty);
    var newStatus = isDone ? 'Completed' : 'In Progress';
    var now = new Date();

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE production_bundles SET completed_qty = ?, rejected_qty = ?, rework_qty = ?, status = ?' +
        (isDone ? ', end_time = ?' : '') +
        ' WHERE bundle_id = ?',
        isDone
          ? [completedQty, rejectedQty, reworkQty, newStatus, formatDateTimeForMySQL_(now), bundleId]
          : [completedQty, rejectedQty, reworkQty, newStatus, bundleId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, ?, 'Production', ?, ?)",
        [
          user.userId,
          isDone ? 'Production Completion' : 'Update',
          String(bundleId),
          JSON.stringify({ completedQty: completedQty, rejectedQty: rejectedQty, reworkQty: reworkQty, status: newStatus, remarks: remarks || null })
        ],
        conn
      );
      return null;
    });

    return successResponse_(getBundle_(bundleId, null), isDone ? 'Bundle completed.' : 'Progress recorded.');
  }

  function holdBundle(sessionId, bundleId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to update production bundles.');
    }
    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    if (bundle.status !== 'In Progress') {
      return errorResponse_('Only an In Progress bundle can be put on hold (current status: ' + bundle.status + ').');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate("UPDATE production_bundles SET status = 'Hold' WHERE bundle_id = ?", [bundleId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Production', ?, ?, ?)",
        [user.userId, String(bundleId), JSON.stringify({ status: bundle.status }), JSON.stringify({ status: 'Hold' })],
        conn
      );
      return null;
    });

    return successResponse_(getBundle_(bundleId, null), 'Bundle put on hold.');
  }

  function resumeBundle(sessionId, bundleId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to update production bundles.');
    }
    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    if (bundle.status !== 'Hold') { return errorResponse_('This bundle is not on hold (current status: ' + bundle.status + ').'); }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate("UPDATE production_bundles SET status = 'In Progress' WHERE bundle_id = ?", [bundleId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Production', ?, ?, ?)",
        [user.userId, String(bundleId), JSON.stringify({ status: 'Hold' }), JSON.stringify({ status: 'In Progress' })],
        conn
      );
      return null;
    });

    return successResponse_(getBundle_(bundleId, null), 'Bundle resumed.');
  }

  function cancelBundle(sessionId, bundleId, reason) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.edit')) {
      return errorResponse_('You do not have permission to update production bundles.');
    }
    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    if (bundle.status === 'Completed' || bundle.status === 'Cancelled') {
      return errorResponse_('This bundle is already ' + bundle.status + '.');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate("UPDATE production_bundles SET status = 'Cancelled' WHERE bundle_id = ?", [bundleId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Production', ?, ?, ?)",
        [user.userId, String(bundleId), JSON.stringify({ status: bundle.status }), JSON.stringify({ status: 'Cancelled', reason: reason || null })],
        conn
      );
      return null;
    });

    return successResponse_(getBundle_(bundleId, null), 'Bundle cancelled.');
  }

  function getBundle(sessionId, bundleId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.view')) {
      return errorResponse_('You do not have permission to view production bundles.');
    }
    if (!isPositiveInteger_(bundleId)) { return errorResponse_('A valid bundleId is required.'); }
    var bundle = getBundle_(bundleId, null);
    if (!bundle) { return errorResponse_('Bundle not found.'); }
    return successResponse_(bundle);
  }

  function listBundles(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'production.view')) {
      return errorResponse_('You do not have permission to view production bundles.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('pb.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isPositiveInteger_(filters.lineId)) { where.push('pb.line_id = ?'); params.push(filters.lineId); }
    if (isPositiveInteger_(filters.operatorId)) { where.push('pb.operator_id = ?'); params.push(filters.operatorId); }
    if (isNonEmptyString_(filters.status) && isValidEnum_(filters.status, BUNDLE_STATUS_VALUES)) {
      where.push('pb.status = ?'); params.push(filters.status);
    }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM production_bundles pb ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT pb.*, jc.job_card_no, pl.line_name, e.full_name AS operator_name ' +
      'FROM production_bundles pb ' +
      'JOIN job_cards jc ON jc.job_card_id = pb.job_card_id ' +
      'LEFT JOIN production_lines pl ON pl.line_id = pb.line_id ' +
      'LEFT JOIN employees e ON e.employee_id = pb.operator_id ' +
      whereSql + ' ORDER BY pb.bundle_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  return {
    createBundle: withErrorHandling_(createBundle),
    startBundle: withErrorHandling_(startBundle),
    recordBundleProgress: withErrorHandling_(recordBundleProgress),
    holdBundle: withErrorHandling_(holdBundle),
    resumeBundle: withErrorHandling_(resumeBundle),
    cancelBundle: withErrorHandling_(cancelBundle),
    getBundle: withErrorHandling_(getBundle),
    listBundles: withErrorHandling_(listBundles)
  };
})();
