/**
 * MasterDataService.gs
 * Not one of the originally-numbered phases - added while building the HTML
 * module pages, which need somewhere to pull buyers/vendors/styles/articles/
 * employees/production lines/FMS stages for dropdowns (job card creation's
 * PO/vendor pickers, purchase order creation's buyer/style pickers, FMS
 * stage-queue selectors, and so on). None of the other *Service.gs files
 * expose this reference data, and seed.sql only seeds it - it doesn't serve
 * it - so without this file several of the module pages would have no way
 * to populate their forms. Every function here is read-only.
 *
 * ES5 only.
 *
 * Gating: there is no per-master-data permission key in seed.sql's
 * permissions table, and this data (buyer/vendor/style names, not financial
 * or personal detail) is reference lookup data needed across almost every
 * module - so these functions require only a valid session, not a specific
 * hasPermission() check, unlike every other *Service.gs file in this
 * project. This is a deliberate, narrower exception, not an oversight.
 */

var MasterDataService = (function () {

  function requireSession_(sessionId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return { error: errorResponse_('Session expired. Please log in again.') }; }
    return { user: user };
  }

  function listBuyers(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT buyer_id, buyer_code, buyer_name, country FROM buyers WHERE is_active = 1 ORDER BY buyer_name', []
    ));
  }

  function listVendors(sessionId, vendorType) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    var sql = 'SELECT vendor_id, vendor_code, vendor_name, vendor_type FROM vendors WHERE is_active = 1';
    var params = [];
    if (isNonEmptyString_(vendorType)) { sql += ' AND vendor_type = ?'; params.push(vendorType); }
    sql += ' ORDER BY vendor_name';
    return successResponse_(DatabaseService.executeQuery(sql, params));
  }

  function listStyles(sessionId, buyerId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    var sql =
      'SELECT s.style_id, s.style_no, s.style_name, s.sam_value, s.buyer_id, s.article_id, a.article_no ' +
      'FROM styles s JOIN articles a ON a.article_id = s.article_id WHERE s.is_active = 1';
    var params = [];
    if (isPositiveInteger_(buyerId)) { sql += ' AND s.buyer_id = ?'; params.push(buyerId); }
    sql += ' ORDER BY s.style_no';
    return successResponse_(DatabaseService.executeQuery(sql, params));
  }

  function listArticles(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT article_id, article_no, article_name, garment_type FROM articles WHERE is_active = 1 ORDER BY article_no', []
    ));
  }

  function listEmployees(sessionId, lineId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    var sql = 'SELECT employee_id, employee_code, full_name, designation, department, line_id FROM employees WHERE is_active = 1';
    var params = [];
    if (isPositiveInteger_(lineId)) { sql += ' AND line_id = ?'; params.push(lineId); }
    sql += ' ORDER BY full_name';
    return successResponse_(DatabaseService.executeQuery(sql, params));
  }

  function listProductionLines(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT line_id, line_code, line_name FROM production_lines WHERE is_active = 1 ORDER BY line_name', []
    ));
  }

  function listFmsStages(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT stage_id, stage_name, sequence_no FROM fms_stages WHERE is_active = 1 ORDER BY sequence_no', []
    ));
  }

  function listFabricItems(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT fabric_id, fabric_code, design_name, color, unit FROM fabric WHERE is_active = 1 ORDER BY fabric_code', []
    ));
  }

  function listInventoryItems(sessionId) {
    var access = requireSession_(sessionId);
    if (access.error) { return access.error; }
    return successResponse_(DatabaseService.executeQuery(
      'SELECT item_id, item_code, item_name, category, unit FROM inventory_items WHERE is_active = 1 ORDER BY item_code', []
    ));
  }

  return {
    listBuyers: withErrorHandling_(listBuyers),
    listVendors: withErrorHandling_(listVendors),
    listStyles: withErrorHandling_(listStyles),
    listArticles: withErrorHandling_(listArticles),
    listEmployees: withErrorHandling_(listEmployees),
    listProductionLines: withErrorHandling_(listProductionLines),
    listFmsStages: withErrorHandling_(listFmsStages),
    listFabricItems: withErrorHandling_(listFabricItems),
    listInventoryItems: withErrorHandling_(listInventoryItems)
  };
})();
