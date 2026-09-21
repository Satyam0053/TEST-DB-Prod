/**
 * QualityService.gs
 * Phase 11 deliverable. QC inspections (checked/passed/rejected/rework
 * quantities) with their defect-type line items, plus a defect-summary
 * rollup for the Quality module's chart.
 *
 * ES5 only.
 *
 * quality_inspections.chk_qi_qty (passed_qty + rejected_qty + rework_qty <=
 * checked_qty) and quality_defects.chk_defect_qty (qty > 0) are enforced by
 * the DB - checked here first too for an immediate, specific message.
 */

var QualityService = (function () {

  var DEFECT_TYPE_VALUES = [
    'Loose Thread', 'Stain', 'Measurement Issue', 'Stitching Defect', 'Fabric Defect',
    'Print Defect', 'Embroidery Defect', 'Button Defect', 'Other'
  ];

  function getInspection_(inspectionId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT qi.*, jc.job_card_no, fs.stage_name, e.full_name AS inspector_name ' +
      'FROM quality_inspections qi ' +
      'JOIN job_cards jc ON jc.job_card_id = qi.job_card_id ' +
      'LEFT JOIN fms_stages fs ON fs.stage_id = qi.stage_id ' +
      'LEFT JOIN employees e ON e.employee_id = qi.inspector_id ' +
      'WHERE qi.inspection_id = ? LIMIT 1',
      [inspectionId],
      conn
    );
    if (rows.length === 0) { return null; }
    var inspection = rows[0];
    inspection.defects = DatabaseService.executeQuery(
      'SELECT defect_id, defect_type, qty, remarks FROM quality_defects WHERE inspection_id = ? ORDER BY defect_id',
      [inspectionId],
      conn
    );
    return inspection;
  }

  // ---------------------------------------------------------------------

  /**
   * input: { jobCardId, stageId, checkedQty, passedQty, rejectedQty,
   *          reworkQty, inspectorId, inspectionDate, remarks,
   *          defects: [{ defectType, qty, remarks }, ...] }
   * defects is optional (a fully-passed inspection may have none) but every
   * entry, if present, must have a positive qty and a valid defectType.
   */
  function recordInspection(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'quality.edit')) {
      return errorResponse_('You do not have permission to record QC inspections.');
    }
    if (!input || !isPositiveInteger_(input.jobCardId)) { return errorResponse_('A valid jobCardId is required.'); }
    if (!isPositiveInteger_(input.checkedQty)) { return errorResponse_('checkedQty must be a positive integer.'); }

    var passedQty = Number(input.passedQty) || 0;
    var rejectedQty = Number(input.rejectedQty) || 0;
    var reworkQty = Number(input.reworkQty) || 0;
    if (passedQty < 0 || rejectedQty < 0 || reworkQty < 0) { return errorResponse_('Quantities cannot be negative.'); }
    if (passedQty + rejectedQty + reworkQty > input.checkedQty) {
      return errorResponse_('passed + rejected + rework (' + (passedQty + rejectedQty + reworkQty) + ') cannot exceed checked qty (' + input.checkedQty + ').');
    }

    var jcRows = DatabaseService.executeQuery('SELECT job_card_id FROM job_cards WHERE job_card_id = ?', [input.jobCardId]);
    if (jcRows.length === 0) { return errorResponse_('Job card not found.'); }

    var defects = input.defects || [];
    var defectQtySum = 0;
    for (var i = 0; i < defects.length; i++) {
      var d = defects[i];
      if (!isValidEnum_(d.defectType, DEFECT_TYPE_VALUES)) {
        return errorResponse_('Each defect must have a defectType of: ' + DEFECT_TYPE_VALUES.join(', '));
      }
      if (typeof d.qty !== 'number' || d.qty <= 0) {
        return errorResponse_('Each defect line must have a positive qty.');
      }
      defectQtySum += d.qty;
    }
    if (defectQtySum > rejectedQty + reworkQty) {
      return errorResponse_('Total defect line quantity (' + defectQtySum + ') cannot exceed rejected + rework qty (' + (rejectedQty + reworkQty) + ').');
    }

    var inspectionDate = input.inspectionDate || formatDateForMySQL_(new Date());

    var newInspectionId = DatabaseService.executeTransaction(function (conn) {
      var inspectionId = DatabaseService.executeInsert(
        'INSERT INTO quality_inspections (job_card_id, stage_id, checked_qty, passed_qty, rejected_qty, rework_qty, inspector_id, inspection_date, remarks) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [input.jobCardId, input.stageId || null, input.checkedQty, passedQty, rejectedQty, reworkQty, input.inspectorId || null, inspectionDate, input.remarks || null],
        conn
      );
      for (var j = 0; j < defects.length; j++) {
        DatabaseService.executeInsert(
          'INSERT INTO quality_defects (inspection_id, defect_type, qty, remarks) VALUES (?, ?, ?, ?)',
          [inspectionId, defects[j].defectType, defects[j].qty, defects[j].remarks || null],
          conn
        );
      }
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'QC Approval', 'Quality', ?, ?)",
        [user.userId, String(inspectionId), JSON.stringify({ jobCardId: input.jobCardId, checkedQty: input.checkedQty, passedQty: passedQty, rejectedQty: rejectedQty, reworkQty: reworkQty })],
        conn
      );
      return inspectionId;
    });

    return successResponse_(getInspection_(newInspectionId, null), 'Inspection recorded.');
  }

  function getInspection(sessionId, inspectionId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'quality.view')) {
      return errorResponse_('You do not have permission to view QC inspections.');
    }
    if (!isPositiveInteger_(inspectionId)) { return errorResponse_('A valid inspectionId is required.'); }
    var inspection = getInspection_(inspectionId, null);
    if (!inspection) { return errorResponse_('Inspection not found.'); }
    return successResponse_(inspection);
  }

  function listInspections(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'quality.view')) {
      return errorResponse_('You do not have permission to view QC inspections.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('qi.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isPositiveInteger_(filters.stageId)) { where.push('qi.stage_id = ?'); params.push(filters.stageId); }
    if (isNonEmptyString_(filters.fromDate)) { where.push('qi.inspection_date >= ?'); params.push(filters.fromDate); }
    if (isNonEmptyString_(filters.toDate)) { where.push('qi.inspection_date <= ?'); params.push(filters.toDate); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM quality_inspections qi ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT qi.*, jc.job_card_no, fs.stage_name, e.full_name AS inspector_name ' +
      'FROM quality_inspections qi ' +
      'JOIN job_cards jc ON jc.job_card_id = qi.job_card_id ' +
      'LEFT JOIN fms_stages fs ON fs.stage_id = qi.stage_id ' +
      'LEFT JOIN employees e ON e.employee_id = qi.inspector_id ' +
      whereSql + ' ORDER BY qi.inspection_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  /**
   * Aggregated defect-type counts across a filtered set of inspections - the
   * data source for the Quality module's "top defects" chart.
   */
  function getDefectSummary(sessionId, filters) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'quality.view')) {
      return errorResponse_('You do not have permission to view QC inspections.');
    }
    filters = filters || {};
    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('qi.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isNonEmptyString_(filters.fromDate)) { where.push('qi.inspection_date >= ?'); params.push(filters.fromDate); }
    if (isNonEmptyString_(filters.toDate)) { where.push('qi.inspection_date <= ?'); params.push(filters.toDate); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var rows = DatabaseService.executeQuery(
      'SELECT qd.defect_type, SUM(qd.qty) AS total_qty, COUNT(*) AS occurrence_count ' +
      'FROM quality_defects qd ' +
      'JOIN quality_inspections qi ON qi.inspection_id = qd.inspection_id ' +
      whereSql +
      ' GROUP BY qd.defect_type ORDER BY total_qty DESC',
      params
    );
    return successResponse_(rows);
  }

  return {
    recordInspection: withErrorHandling_(recordInspection),
    getInspection: withErrorHandling_(getInspection),
    listInspections: withErrorHandling_(listInspections),
    getDefectSummary: withErrorHandling_(getDefectSummary)
  };
})();
