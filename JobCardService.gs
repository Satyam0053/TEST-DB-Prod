/**
 * JobCardService.gs
 * Phase 6 deliverable: the Job Card module - the golden thread (spec section 5).
 *
 * ES5 only. Every public function: validateSession -> hasPermission ->
 * validate input -> DatabaseService -> successResponse_/errorResponse_.
 *
 * Requires: Utils.gs, Config.gs, Database.gs, AuthService.gs (all already
 * delivered), plus the job_card_sequences table added to schema.sql in this
 * pass (run the updated schema.sql - it's additive, DROP DATABASE not
 * required if you already have the tables from before; just run the new
 * CREATE TABLE job_card_sequences block and the seed.sql INSERT for it,
 * or reload both files fresh).
 */

var JobCardService = (function () {

  var STATUS_VALUES = ['Pending', 'In Progress', 'Completed', 'On Hold', 'Cancelled'];
  var PRODUCTION_TYPE_VALUES = ['In-House', 'Fabricator'];

  // ---------------------------------------------------------------------
  // job_card_no generation (spec section 5: JC-2026-001 style)
  // ---------------------------------------------------------------------

  function padLeft_(num, width) {
    var s = String(num);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  /**
   * Must be called with the SAME conn as the job_cards insert that follows
   * it, inside one executeTransaction callback - the atomic
   * "INSERT ... ON DUPLICATE KEY UPDATE" is what makes this safe under
   * concurrent createJobCard() calls (see schema.sql's job_card_sequences
   * comment).
   */
  function generateJobCardNo_(conn, year) {
    DatabaseService.executeUpdate(
      'INSERT INTO job_card_sequences (year_no, last_seq) VALUES (?, 1) ' +
      'ON DUPLICATE KEY UPDATE last_seq = last_seq + 1',
      [year],
      conn
    );
    var rows = DatabaseService.executeQuery(
      'SELECT last_seq FROM job_card_sequences WHERE year_no = ?',
      [year],
      conn
    );
    var seq = rows[0].last_seq;
    return 'JC-' + year + '-' + padLeft_(seq, 3);
  }

  // ---------------------------------------------------------------------
  // Shared row-shaping
  // ---------------------------------------------------------------------

  function getJobCardDetail_(jobCardId) {
    var rows = DatabaseService.executeQuery(
      'SELECT jc.*, b.buyer_name, s.style_no, s.style_name, a.article_no, a.article_name, ' +
      '       v.vendor_name, fs.stage_name AS current_stage_name, po.po_number ' +
      'FROM job_cards jc ' +
      'JOIN buyers b ON b.buyer_id = jc.buyer_id ' +
      'JOIN styles s ON s.style_id = jc.style_id ' +
      'JOIN articles a ON a.article_id = jc.article_id ' +
      'JOIN purchase_orders po ON po.po_id = jc.po_id ' +
      'LEFT JOIN vendors v ON v.vendor_id = jc.vendor_id ' +
      'LEFT JOIN fms_stages fs ON fs.stage_id = jc.current_stage_id ' +
      'WHERE jc.job_card_id = ? LIMIT 1',
      [jobCardId]
    );
    if (rows.length === 0) { return null; }
    var jobCard = rows[0];
    jobCard.stages = DatabaseService.executeQuery(
      'SELECT fst.stage_txn_id, fst.stage_id, fs.stage_name, fst.sequence_no, fst.status, ' +
      '       fst.quantity, fst.completed_qty, fst.pending_qty, fst.planned_start, fst.planned_end, ' +
      '       fst.actual_start, fst.actual_end, fst.tat_hours, fst.assigned_to ' +
      'FROM fms_stage_transactions fst ' +
      'JOIN fms_stages fs ON fs.stage_id = fst.stage_id ' +
      'WHERE fst.job_card_id = ? ' +
      'ORDER BY fst.sequence_no ASC',
      [jobCardId]
    );
    return jobCard;
  }

  // ---------------------------------------------------------------------
  // createJobCard
  // ---------------------------------------------------------------------

  function createJobCard(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.edit')) {
      return errorResponse_('You do not have permission to create job cards.');
    }
    if (!input || typeof input !== 'object') {
      return errorResponse_('Job card details are required.');
    }

    if (!isPositiveInteger_(input.poId)) {
      return errorResponse_('A valid purchase order (poId) is required.');
    }
    if (!isPositiveInteger_(input.orderQty)) {
      return errorResponse_('orderQty must be a positive whole number.');
    }
    var productionType = input.productionType || 'In-House';
    if (!isValidEnum_(productionType, PRODUCTION_TYPE_VALUES)) {
      return errorResponse_('productionType must be one of: ' + PRODUCTION_TYPE_VALUES.join(', ') + '.');
    }
    if (productionType === 'Fabricator' && !isPositiveInteger_(input.vendorId)) {
      return errorResponse_('vendorId is required when productionType is Fabricator.');
    }
    if (productionType === 'In-House' && input.vendorId) {
      return errorResponse_('vendorId must not be set when productionType is In-House.');
    }

    var poRows = DatabaseService.executeQuery(
      'SELECT po_id, buyer_id, style_id, order_qty, status FROM purchase_orders WHERE po_id = ? LIMIT 1',
      [input.poId]
    );
    if (poRows.length === 0) {
      return errorResponse_('Purchase order not found.');
    }
    var po = poRows[0];
    if (po.status === 'Cancelled' || po.status === 'Closed') {
      return errorResponse_('Cannot create a job card against a ' + po.status + ' purchase order.');
    }
    if (input.orderQty > po.order_qty) {
      return errorResponse_('orderQty (' + input.orderQty + ') cannot exceed the purchase order quantity (' + po.order_qty + ').');
    }

    var styleRows = DatabaseService.executeQuery(
      'SELECT style_id, article_id, sam_value FROM styles WHERE style_id = ? LIMIT 1',
      [po.style_id]
    );
    if (styleRows.length === 0) {
      return errorResponse_('The style linked to this purchase order no longer exists.');
    }
    var style = styleRows[0];

    var articleRows = DatabaseService.executeQuery(
      'SELECT article_id, garment_type FROM articles WHERE article_id = ? LIMIT 1',
      [style.article_id]
    );
    var garmentType = articleRows.length > 0 ? articleRows[0].garment_type : null;

    if (productionType === 'Fabricator') {
      var vendorRows = DatabaseService.executeQuery(
        "SELECT vendor_id FROM vendors WHERE vendor_id = ? AND vendor_type = 'Fabricator' AND is_active = 1 LIMIT 1",
        [input.vendorId]
      );
      if (vendorRows.length === 0) {
        return errorResponse_('vendorId must reference an active Fabricator vendor.');
      }
    }

    var samValue = (typeof input.samValue === 'number') ? input.samValue : style.sam_value;
    var targetDate = isNonEmptyString_(input.targetDate) ? input.targetDate : null;
    var year = new Date().getFullYear();

    var newJobCardId = DatabaseService.executeTransaction(function (conn) {
      var jobCardNo = generateJobCardNo_(conn, year);

      var jcId = DatabaseService.executeInsert(
        'INSERT INTO job_cards ' +
        '(job_card_no, po_id, buyer_id, style_id, article_id, garment_type, order_qty, target_date, ' +
        ' sam_value, production_type, vendor_id, status, created_by, created_date) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, CURRENT_DATE)",
        [
          jobCardNo, po.po_id, po.buyer_id, style.style_id, style.article_id, garmentType,
          input.orderQty, targetDate, samValue, productionType, input.vendorId || null, user.userId
        ],
        conn
      );

      // Invariant (DATA_MODEL.md section 4): every job card gets all 7 FMS
      // stage rows created here, atomically, as Pending. job_cards.current_stage_id
      // and .status are then set automatically by the AFTER INSERT triggers on
      // fms_stage_transactions (trg_fms_after_insert_refresh_jobcard) - this
      // service never writes those two columns directly.
      var stages = DatabaseService.executeQuery(
        'SELECT stage_id, sequence_no FROM fms_stages ORDER BY sequence_no ASC',
        [],
        conn
      );
      for (var i = 0; i < stages.length; i++) {
        DatabaseService.executeInsert(
          "INSERT INTO fms_stage_transactions (job_card_id, stage_id, sequence_no, quantity, completed_qty, status) " +
          "VALUES (?, ?, ?, ?, 0, 'Pending')",
          [jcId, stages[i].stage_id, stages[i].sequence_no, input.orderQty],
          conn
        );
      }

      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'JobCard', ?, ?)",
        [user.userId, String(jcId), JSON.stringify({ jobCardNo: jobCardNo, poId: po.po_id, orderQty: input.orderQty })],
        conn
      );

      return jcId;
    });

    var created = getJobCardDetail_(newJobCardId);
    return successResponse_(created, 'Job card ' + created.job_card_no + ' created.');
  }

  // ---------------------------------------------------------------------
  // getJobCard
  // ---------------------------------------------------------------------

  function getJobCard(sessionId, jobCardId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.view')) {
      return errorResponse_('You do not have permission to view job cards.');
    }
    if (!isPositiveInteger_(jobCardId)) {
      return errorResponse_('A valid jobCardId is required.');
    }
    var jobCard = getJobCardDetail_(jobCardId);
    if (!jobCard) {
      return errorResponse_('Job card not found.');
    }
    return successResponse_(jobCard);
  }

  function getJobCardByNo(sessionId, jobCardNo) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.view')) {
      return errorResponse_('You do not have permission to view job cards.');
    }
    if (!isNonEmptyString_(jobCardNo)) {
      return errorResponse_('A valid jobCardNo is required.');
    }
    var rows = DatabaseService.executeQuery(
      'SELECT job_card_id FROM job_cards WHERE job_card_no = ? LIMIT 1',
      [jobCardNo]
    );
    if (rows.length === 0) {
      return errorResponse_('Job card not found.');
    }
    return successResponse_(getJobCardDetail_(rows[0].job_card_id));
  }

  // ---------------------------------------------------------------------
  // listJobCards - filters + pagination (spec section 27)
  // ---------------------------------------------------------------------

  function listJobCards(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.view')) {
      return errorResponse_('You do not have permission to view job cards.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; } // guard against an accidental/abusive unbounded pull

    var whereClauses = [];
    var params = [];

    if (isPositiveInteger_(filters.buyerId)) {
      whereClauses.push('jc.buyer_id = ?');
      params.push(filters.buyerId);
    }
    if (isPositiveInteger_(filters.styleId)) {
      whereClauses.push('jc.style_id = ?');
      params.push(filters.styleId);
    }
    if (isNonEmptyString_(filters.status) && isValidEnum_(filters.status, STATUS_VALUES)) {
      whereClauses.push('jc.status = ?');
      params.push(filters.status);
    }
    if (isNonEmptyString_(filters.productionType) && isValidEnum_(filters.productionType, PRODUCTION_TYPE_VALUES)) {
      whereClauses.push('jc.production_type = ?');
      params.push(filters.productionType);
    }
    if (isNonEmptyString_(filters.dateFrom)) {
      whereClauses.push('jc.target_date >= ?');
      params.push(filters.dateFrom);
    }
    if (isNonEmptyString_(filters.dateTo)) {
      whereClauses.push('jc.target_date <= ?');
      params.push(filters.dateTo);
    }
    if (isNonEmptyString_(filters.search)) {
      whereClauses.push('jc.job_card_no LIKE ?');
      params.push('%' + filters.search + '%');
    }

    var whereSql = whereClauses.length > 0 ? ('WHERE ' + whereClauses.join(' AND ')) : '';

    var countRows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS total FROM job_cards jc ' + whereSql,
      params
    );
    var total = Number(countRows[0].total);

    // Reuses vw_jobcard_summary (schema.sql) for the computed columns
    // (production_pct, delay_days, current_stage) rather than re-deriving
    // that logic here - one source of truth for how those numbers are computed.
    var listSql =
      'SELECT v.* FROM vw_jobcard_summary v ' +
      'JOIN job_cards jc ON jc.job_card_id = v.job_card_id ' +
      whereSql +
      ' ORDER BY jc.job_card_id DESC LIMIT ? OFFSET ?';
    var listParams = params.concat([size, (pageNum - 1) * size]);
    var rows = DatabaseService.executeQuery(listSql, listParams);

    return successResponse_({
      rows: rows,
      page: pageNum,
      pageSize: size,
      total: total,
      totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  // ---------------------------------------------------------------------
  // updateJobCard - whitelisted, non-derived fields only. current_stage_id
  // and status are trigger-owned (see cancelJobCard for the one sanctioned
  // exception) and order_qty/buyer/style/article/po are immutable after
  // creation (recreate the job card if one of those was wrong).
  // ---------------------------------------------------------------------

  function updateJobCard(sessionId, jobCardId, patch) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.edit')) {
      return errorResponse_('You do not have permission to edit job cards.');
    }
    if (!isPositiveInteger_(jobCardId)) {
      return errorResponse_('A valid jobCardId is required.');
    }
    if (!patch || typeof patch !== 'object') {
      return errorResponse_('No changes supplied.');
    }

    var existingRows = DatabaseService.executeQuery(
      'SELECT job_card_id, production_type, status FROM job_cards WHERE job_card_id = ? LIMIT 1',
      [jobCardId]
    );
    if (existingRows.length === 0) {
      return errorResponse_('Job card not found.');
    }
    var existing = existingRows[0];
    if (existing.status === 'Cancelled') {
      return errorResponse_('This job card is cancelled and can no longer be edited.');
    }

    var setClauses = [];
    var params = [];
    var newValueForAudit = {};

    if (typeof patch.targetDate !== 'undefined') {
      if (patch.targetDate !== null && !isNonEmptyString_(patch.targetDate)) {
        return errorResponse_('targetDate must be a date string or null.');
      }
      setClauses.push('target_date = ?');
      params.push(patch.targetDate);
      newValueForAudit.targetDate = patch.targetDate;
    }
    if (typeof patch.samValue !== 'undefined') {
      if (typeof patch.samValue !== 'number' || patch.samValue <= 0) {
        return errorResponse_('samValue must be a positive number.');
      }
      setClauses.push('sam_value = ?');
      params.push(patch.samValue);
      newValueForAudit.samValue = patch.samValue;
    }
    if (typeof patch.garmentType !== 'undefined') {
      if (!isNonEmptyString_(patch.garmentType)) {
        return errorResponse_('garmentType must be a non-empty string.');
      }
      setClauses.push('garment_type = ?');
      params.push(patch.garmentType);
      newValueForAudit.garmentType = patch.garmentType;
    }
    if (typeof patch.productionType !== 'undefined' || typeof patch.vendorId !== 'undefined') {
      var newProductionType = (typeof patch.productionType !== 'undefined') ? patch.productionType : existing.production_type;
      if (!isValidEnum_(newProductionType, PRODUCTION_TYPE_VALUES)) {
        return errorResponse_('productionType must be one of: ' + PRODUCTION_TYPE_VALUES.join(', ') + '.');
      }
      if (newProductionType === 'Fabricator') {
        if (!isPositiveInteger_(patch.vendorId)) {
          return errorResponse_('vendorId is required when productionType is Fabricator.');
        }
        var vendorRows = DatabaseService.executeQuery(
          "SELECT vendor_id FROM vendors WHERE vendor_id = ? AND vendor_type = 'Fabricator' AND is_active = 1 LIMIT 1",
          [patch.vendorId]
        );
        if (vendorRows.length === 0) {
          return errorResponse_('vendorId must reference an active Fabricator vendor.');
        }
        setClauses.push('production_type = ?', 'vendor_id = ?');
        params.push(newProductionType, patch.vendorId);
        newValueForAudit.productionType = newProductionType;
        newValueForAudit.vendorId = patch.vendorId;
      } else {
        setClauses.push('production_type = ?', 'vendor_id = NULL');
        params.push(newProductionType);
        newValueForAudit.productionType = newProductionType;
        newValueForAudit.vendorId = null;
      }
    }
    if (typeof patch.orderQty !== 'undefined') {
      return errorResponse_('orderQty cannot be changed after creation (it is already baked into each FMS stage row). Cancel and recreate the job card if the order quantity was wrong.');
    }

    if (setClauses.length === 0) {
      return errorResponse_('No recognized fields to update.');
    }

    params.push(jobCardId);
    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE job_cards SET ' + setClauses.join(', ') + ' WHERE job_card_id = ?',
        params,
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'JobCard', ?, ?)",
        [user.userId, String(jobCardId), JSON.stringify(newValueForAudit)],
        conn
      );
      return null;
    });

    return successResponse_(getJobCardDetail_(jobCardId), 'Job card updated.');
  }

  // ---------------------------------------------------------------------
  // cancelJobCard - the one sanctioned direct write to job_cards.status.
  // sp_refresh_jobcard_current_stage (schema.sql) explicitly skips rows
  // already in 'Cancelled' status, so this sticks even as FMS stages change.
  // ---------------------------------------------------------------------

  function cancelJobCard(sessionId, jobCardId, reason) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'jobcard.edit')) {
      return errorResponse_('You do not have permission to cancel job cards.');
    }
    if (!isPositiveInteger_(jobCardId)) {
      return errorResponse_('A valid jobCardId is required.');
    }
    var existingRows = DatabaseService.executeQuery(
      'SELECT job_card_id, status FROM job_cards WHERE job_card_id = ? LIMIT 1',
      [jobCardId]
    );
    if (existingRows.length === 0) {
      return errorResponse_('Job card not found.');
    }
    if (existingRows[0].status === 'Completed') {
      return errorResponse_('A completed job card cannot be cancelled.');
    }
    if (existingRows[0].status === 'Cancelled') {
      return errorResponse_('This job card is already cancelled.');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        "UPDATE job_cards SET status = 'Cancelled' WHERE job_card_id = ?",
        [jobCardId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'JobCard', ?, ?, ?)",
        [
          user.userId,
          String(jobCardId),
          JSON.stringify({ status: existingRows[0].status }),
          JSON.stringify({ status: 'Cancelled', reason: reason || null })
        ],
        conn
      );
      return null;
    });

    return successResponse_(getJobCardDetail_(jobCardId), 'Job card cancelled.');
  }

  return {
    createJobCard: withErrorHandling_(createJobCard),
    getJobCard: withErrorHandling_(getJobCard),
    getJobCardByNo: withErrorHandling_(getJobCardByNo),
    listJobCards: withErrorHandling_(listJobCards),
    updateJobCard: withErrorHandling_(updateJobCard),
    cancelJobCard: withErrorHandling_(cancelJobCard)
  };
})();
