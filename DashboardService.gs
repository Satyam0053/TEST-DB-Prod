/**
 * DashboardService.gs
 * Phase 15 deliverable. Read-only KPI aggregation for the in-app Dashboard
 * module, sourced from schema.sql's vw_, fact_ and dim_ reporting layer
 * (DATA_MODEL.md section on star-schema notes) rather than re-deriving the
 * same numbers with ad hoc queries against the OLTP tables - Power BI reads
 * the same views, so the in-app dashboard and Power BI never disagree.
 *
 * ES5 only.
 *
 * Every function here is gated on the single seeded 'dashboard.view'
 * permission (there is no per-module dashboard permission in seed.sql) -
 * this file is a read-only aggregation layer, nothing here writes.
 */

var DashboardService = (function () {

  function checkAccess_(sessionId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return { error: errorResponse_('Session expired. Please log in again.') }; }
    if (!AuthService.hasPermission(user.userId, 'dashboard.view')) {
      return { error: errorResponse_('You do not have permission to view the dashboard.') };
    }
    return { user: user };
  }

  /**
   * Top-line counters for the dashboard landing screen: job-card status
   * mix, PO status mix, low-stock item count, overall OTD%, overall QC
   * reject%, and a TAT-breach count (stages already Done late, plus
   * still-running stages already past their planned_end).
   */
  function getOverviewKpis(sessionId) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }

    var jobCardStatus = DatabaseService.executeQuery('SELECT status, COUNT(*) AS cnt FROM job_cards GROUP BY status', []);
    var poStatus = DatabaseService.executeQuery('SELECT status, COUNT(*) AS cnt FROM purchase_orders GROUP BY status', []);
    var lowStockRows = DatabaseService.executeQuery('SELECT COUNT(*) AS cnt FROM vw_inventory_summary WHERE below_reorder_level = 1', []);
    var otdRows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS total_dispatched, SUM(on_time_flag) AS on_time_count FROM vw_delivery_summary WHERE delivery_date IS NOT NULL',
      []
    );
    var qualityRows = DatabaseService.executeQuery(
      'SELECT ROUND(SUM(rejected_qty) / NULLIF(SUM(checked_qty), 0) * 100, 2) AS overall_reject_pct FROM quality_inspections',
      []
    );
    var tatBreachRows = DatabaseService.executeQuery(
      "SELECT COUNT(*) AS breach_count FROM fms_stage_transactions " +
      "WHERE (status = 'Done' AND actual_end > planned_end) " +
      "   OR (status IN ('Started', 'In Progress') AND planned_end IS NOT NULL AND planned_end < NOW())",
      []
    );

    var totalDispatched = Number(otdRows[0].total_dispatched);
    var onTimeCount = Number(otdRows[0].on_time_count) || 0;

    return successResponse_({
      jobCardsByStatus: jobCardStatus,
      purchaseOrdersByStatus: poStatus,
      lowStockItemCount: Number(lowStockRows[0].cnt),
      otd: {
        totalDispatched: totalDispatched,
        onTimeCount: onTimeCount,
        otdPct: totalDispatched > 0 ? Math.round((onTimeCount / totalDispatched) * 10000) / 100 : null
      },
      overallQualityRejectPct: qualityRows[0].overall_reject_pct === null ? null : Number(qualityRows[0].overall_reject_pct),
      tatBreachCount: Number(tatBreachRows[0].breach_count)
    });
  }

  function getJobCardSummary(sessionId, filters, page, pageSize) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isNonEmptyString_(filters.status)) { where.push('current_status = ?'); params.push(filters.status); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM vw_jobcard_summary ' + whereSql, params);
    var total = Number(countRows[0].total);
    var rows = DatabaseService.executeQuery(
      'SELECT * FROM vw_jobcard_summary ' + whereSql + ' ORDER BY job_card_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  function getFmsStageSummary(sessionId) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery('SELECT * FROM vw_fms_stage_summary', []));
  }

  function getProductionSummary(sessionId, filters, page, pageSize) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('job_card_id = ?'); params.push(filters.jobCardId); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM vw_production_summary ' + whereSql, params);
    var total = Number(countRows[0].total);
    var rows = DatabaseService.executeQuery(
      'SELECT * FROM vw_production_summary ' + whereSql + ' ORDER BY job_card_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  function getInventorySummary(sessionId, lowStockOnly) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    var sql = 'SELECT * FROM vw_inventory_summary';
    if (lowStockOnly) { sql += ' WHERE below_reorder_level = 1'; }
    sql += ' ORDER BY source_type, item_code';
    return successResponse_(DatabaseService.executeQuery(sql, []));
  }

  function getArtworkSummary(sessionId) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT vs.*, v.vendor_name FROM vw_artwork_summary vs JOIN vendors v ON v.vendor_id = vs.vendor_id ORDER BY v.vendor_name, vs.artwork_type',
      []
    ));
  }

  function getQualitySummary(sessionId, filters) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    filters = filters || {};
    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('vs.job_card_id = ?'); params.push(filters.jobCardId); }
    var whereSql = 'WHERE ' + where.join(' AND ');
    return successResponse_(DatabaseService.executeQuery(
      'SELECT vs.*, jc.job_card_no FROM vw_quality_summary vs JOIN job_cards jc ON jc.job_card_id = vs.job_card_id ' +
      whereSql + ' ORDER BY vs.job_card_id DESC',
      params
    ));
  }

  function getDeliverySummary(sessionId, filters, page, pageSize) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('job_card_id = ?'); params.push(filters.jobCardId); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM vw_delivery_summary ' + whereSql, params);
    var total = Number(countRows[0].total);
    var rows = DatabaseService.executeQuery(
      'SELECT * FROM vw_delivery_summary ' + whereSql + ' ORDER BY job_card_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  /**
   * Row-level detail behind the tatBreachCount KPI - every stage that
   * finished late, or is still running past its planned_end right now.
   */
  function getTatBreaches(sessionId) {
    var access = checkAccess_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      "SELECT fst.stage_txn_id, fst.job_card_id, jc.job_card_no, fs.stage_name, fst.status, " +
      "       fst.planned_end, fst.actual_end, " +
      "       TIMESTAMPDIFF(MINUTE, fst.planned_end, COALESCE(fst.actual_end, NOW())) / 60.0 AS breach_hours " +
      "FROM fms_stage_transactions fst " +
      "JOIN job_cards jc ON jc.job_card_id = fst.job_card_id " +
      "JOIN fms_stages fs ON fs.stage_id = fst.stage_id " +
      "WHERE (fst.status = 'Done' AND fst.actual_end > fst.planned_end) " +
      "   OR (fst.status IN ('Started', 'In Progress') AND fst.planned_end IS NOT NULL AND fst.planned_end < NOW()) " +
      "ORDER BY breach_hours DESC",
      []
    ));
  }

  return {
    getOverviewKpis: withErrorHandling_(getOverviewKpis),
    getJobCardSummary: withErrorHandling_(getJobCardSummary),
    getFmsStageSummary: withErrorHandling_(getFmsStageSummary),
    getProductionSummary: withErrorHandling_(getProductionSummary),
    getInventorySummary: withErrorHandling_(getInventorySummary),
    getArtworkSummary: withErrorHandling_(getArtworkSummary),
    getQualitySummary: withErrorHandling_(getQualitySummary),
    getDeliverySummary: withErrorHandling_(getDeliverySummary),
    getTatBreaches: withErrorHandling_(getTatBreaches)
  };
})();
