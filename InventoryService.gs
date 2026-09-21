/**
 * InventoryService.gs
 * Phase 8 deliverable. Fabric and general inventory (trims/thread/button/
 * zipper/label/packaging) movement: receive/issue/return/consume/scrap,
 * stock reconciliation, negative-stock guard (spec section 11), and
 * fabric-to-fabricator issue/return tracking.
 *
 * ES5 only.
 *
 * fabric_stock / inventory_stock hold running totals per item
 * (opening/purchase/received/issued/returned/consumed/scrap), with
 * closing_stock as a MySQL GENERATED column - this file only ever adds to
 * one of the six mutable columns per transaction and lets MySQL compute
 * closing_stock; it never writes closing_stock directly.
 *
 * Fabric and general inventory items share an identical stock/transaction
 * shape (fabric_stock/inventory_stock, fabric_transactions/
 * inventory_transactions), so both are driven through one generic internal
 * mover (recordMovement_) parameterized by table names, rather than
 * duplicating the same five txn-type branches twice. The one real
 * difference - fabric_transactions.issued_to ('In-House'/'Fabricator'/
 * 'Sample') - is passed through as an optional field that is simply ignored
 * for inventory_items.
 */

var InventoryService = (function () {

  var TXN_TYPE_VALUES = ['Purchase', 'Receive', 'Issue', 'Return', 'Consume', 'Scrap'];
  // Which stock column a given txn_type adds to, and whether it DEDUCTS from
  // available stock (and therefore needs the negative-stock guard).
  var TXN_TYPE_META = {
    'Purchase': { column: 'purchase_qty', deducts: false },
    'Receive': { column: 'received_qty', deducts: false },
    'Issue': { column: 'issued_qty', deducts: true },
    'Return': { column: 'returned_qty', deducts: false },
    'Consume': { column: 'consumed_qty', deducts: true },
    'Scrap': { column: 'scrap_qty', deducts: true }
  };
  var ISSUED_TO_VALUES = ['In-House', 'Fabricator', 'Sample'];
  var QC_STATUS_VALUES = ['Pending', 'Passed', 'Failed', 'Partial'];

  // ---------------------------------------------------------------------
  // Generic mover - shared by fabric and inventory_items
  // ---------------------------------------------------------------------

  function getClosingStock_(stockTable, idColumn, itemId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT closing_stock FROM ' + stockTable + ' WHERE ' + idColumn + ' = ? LIMIT 1',
      [itemId],
      conn
    );
    if (rows.length === 0) { return 0; }
    return Number(rows[0].closing_stock);
  }

  function ensureStockRowExists_(stockTable, idColumn, itemId, conn) {
    // fabric_stock/inventory_stock rows are 1:1 with their item and expected
    // to be created (opening_stock = 0) when the item master is created; this
    // is a defensive upsert in case a transaction ever arrives before that.
    DatabaseService.executeUpdate(
      'INSERT INTO ' + stockTable + ' (' + idColumn + ') VALUES (?) ' +
      'ON DUPLICATE KEY UPDATE ' + idColumn + ' = ' + idColumn,
      [itemId],
      conn
    );
  }

  /**
   * itemTable: 'fabric' | 'inventory_items'  idColumn: 'fabric_id' | 'item_id'
   * stockTable/txnTable: the matching *_stock / *_transactions tables.
   * input: { itemId, jobCardId, txnType, txnDate, quantity, issuedTo, vendorId, remarks }
   */
  function recordMovement_(itemTable, idColumn, stockTable, txnTable, sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.edit')) {
      return errorResponse_('You do not have permission to record inventory movements.');
    }
    if (!input || !isPositiveInteger_(input.itemId)) { return errorResponse_('A valid itemId is required.'); }
    if (!isValidEnum_(input.txnType, TXN_TYPE_VALUES)) { return errorResponse_('txnType must be one of: ' + TXN_TYPE_VALUES.join(', ')); }
    if (typeof input.quantity !== 'number' || input.quantity <= 0) { return errorResponse_('quantity must be a positive number.'); }
    if (itemTable === 'fabric' && input.issuedTo && !isValidEnum_(input.issuedTo, ISSUED_TO_VALUES)) {
      return errorResponse_('issuedTo must be one of: ' + ISSUED_TO_VALUES.join(', '));
    }

    var itemRows = DatabaseService.executeQuery(
      'SELECT * FROM ' + itemTable + ' WHERE ' + idColumn + ' = ? AND is_active = 1 LIMIT 1',
      [input.itemId]
    );
    if (itemRows.length === 0) { return errorResponse_('Item not found or is inactive.'); }

    var meta = TXN_TYPE_META[input.txnType];
    var txnDate = input.txnDate || formatDateForMySQL_(new Date());

    var newTxnId = DatabaseService.executeTransaction(function (conn) {
      ensureStockRowExists_(stockTable, idColumn, input.itemId, conn);

      if (meta.deducts) {
        var available = getClosingStock_(stockTable, idColumn, input.itemId, conn);
        if (input.quantity > available) {
          throw new Error(
            'BUSINESS_RULE: Cannot ' + input.txnType.toLowerCase() + ' ' + input.quantity +
            ' - only ' + available + ' available in stock.'
          );
        }
      }

      var txnId = DatabaseService.executeInsert(
        'INSERT INTO ' + txnTable + ' (' + idColumn + ', job_card_id, txn_type, txn_date, quantity, ' +
        (itemTable === 'fabric' ? 'issued_to, ' : '') + 'vendor_id, remarks, created_by) VALUES (?, ?, ?, ?, ?, ' +
        (itemTable === 'fabric' ? '?, ' : '') + '?, ?, ?)',
        (itemTable === 'fabric'
          ? [input.itemId, input.jobCardId || null, input.txnType, txnDate, input.quantity, input.issuedTo || null, input.vendorId || null, input.remarks || null, user.userId]
          : [input.itemId, input.jobCardId || null, input.txnType, txnDate, input.quantity, input.vendorId || null, input.remarks || null, user.userId]),
        conn
      );

      DatabaseService.executeUpdate(
        'UPDATE ' + stockTable + ' SET ' + meta.column + ' = ' + meta.column + ' + ? WHERE ' + idColumn + ' = ?',
        [input.quantity, input.itemId],
        conn
      );

      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, ?, ?, ?, ?)",
        [
          user.userId,
          meta.deducts ? 'Inventory Issue' : (input.txnType === 'Return' ? 'Inventory Return' : 'Create'),
          itemTable === 'fabric' ? 'Fabric' : 'Inventory',
          String(txnId),
          JSON.stringify({ txnType: input.txnType, quantity: input.quantity, itemId: input.itemId })
        ],
        conn
      );

      return txnId;
    });

    return successResponse_({ txnId: newTxnId }, input.txnType + ' recorded.');
  }

  function getStock_(stockTable, idColumn, masterTable, sessionId, itemId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.view')) {
      return errorResponse_('You do not have permission to view inventory.');
    }
    if (!isPositiveInteger_(itemId)) { return errorResponse_('A valid itemId is required.'); }
    var rows = DatabaseService.executeQuery(
      'SELECT m.*, st.opening_stock, st.purchase_qty, st.received_qty, st.issued_qty, ' +
      '       st.returned_qty, st.consumed_qty, st.scrap_qty, st.closing_stock ' +
      'FROM ' + masterTable + ' m LEFT JOIN ' + stockTable + ' st ON st.' + idColumn + ' = m.' + idColumn + ' ' +
      'WHERE m.' + idColumn + ' = ? LIMIT 1',
      [itemId]
    );
    if (rows.length === 0) { return errorResponse_('Item not found.'); }
    return successResponse_(rows[0]);
  }

  function listStock_(stockTable, idColumn, masterTable, sessionId, lowStockOnly) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.view')) {
      return errorResponse_('You do not have permission to view inventory.');
    }
    var sql =
      'SELECT m.*, st.opening_stock, st.purchase_qty, st.received_qty, st.issued_qty, ' +
      '       st.returned_qty, st.consumed_qty, st.scrap_qty, st.closing_stock ' +
      'FROM ' + masterTable + ' m LEFT JOIN ' + stockTable + ' st ON st.' + idColumn + ' = m.' + idColumn + ' ' +
      'WHERE m.is_active = 1';
    if (lowStockOnly) {
      // st.closing_stock (a real generated column on the joined table, not an
      // aggregate) is safe to filter in WHERE; MySQL 8's ONLY_FULL_GROUP_BY
      // rejects the equivalent HAVING form even with no GROUP BY present.
      sql += ' AND st.closing_stock IS NOT NULL AND st.closing_stock <= m.reorder_level';
    }
    sql += ' ORDER BY m.' + idColumn;
    return successResponse_(DatabaseService.executeQuery(sql, []));
  }

  function listTransactions_(txnTable, idColumn, itemTable, sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.view')) {
      return errorResponse_('You do not have permission to view inventory.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.itemId)) { where.push('t.' + idColumn + ' = ?'); params.push(filters.itemId); }
    if (isPositiveInteger_(filters.jobCardId)) { where.push('t.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isNonEmptyString_(filters.txnType) && isValidEnum_(filters.txnType, TXN_TYPE_VALUES)) {
      where.push('t.txn_type = ?'); params.push(filters.txnType);
    }
    if (isNonEmptyString_(filters.fromDate)) { where.push('t.txn_date >= ?'); params.push(filters.fromDate); }
    if (isNonEmptyString_(filters.toDate)) { where.push('t.txn_date <= ?'); params.push(filters.toDate); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM ' + txnTable + ' t ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT t.*, m.' + (itemTable === 'fabric' ? 'fabric_code AS item_code, m.design_name AS item_name' : 'item_code, m.item_name') + ' ' +
      'FROM ' + txnTable + ' t JOIN ' + itemTable + ' m ON m.' + idColumn + ' = t.' + idColumn + ' ' +
      whereSql + ' ORDER BY t.txn_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  // ---------------------------------------------------------------------
  // Fabric
  // ---------------------------------------------------------------------

  function recordFabricTransaction(sessionId, input) {
    return recordMovement_('fabric', 'fabric_id', 'fabric_stock', 'fabric_transactions', sessionId, input);
  }
  function getFabricStock(sessionId, fabricId) {
    return getStock_('fabric_stock', 'fabric_id', 'fabric', sessionId, fabricId);
  }
  function listFabricStock(sessionId, lowStockOnly) {
    return listStock_('fabric_stock', 'fabric_id', 'fabric', sessionId, lowStockOnly);
  }
  function listFabricTransactions(sessionId, filters, page, pageSize) {
    return listTransactions_('fabric_transactions', 'fabric_id', 'fabric', sessionId, filters, page, pageSize);
  }

  /**
   * Fabric issued out to a fabricator (outside vendor) for cutting/stitching -
   * a fabric_transactions 'Issue' row (issued_to='Fabricator') plus a
   * fabric_fabricator_issues tracking row (expected/actual return date, QC
   * status on return). Both must exist together, hence one transaction.
   */
  function issueFabricToFabricator(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.edit')) {
      return errorResponse_('You do not have permission to record inventory movements.');
    }
    if (!input || !isPositiveInteger_(input.fabricId) || !isPositiveInteger_(input.jobCardId) || !isPositiveInteger_(input.vendorId)) {
      return errorResponse_('fabricId, jobCardId and vendorId are required.');
    }
    if (typeof input.quantity !== 'number' || input.quantity <= 0) { return errorResponse_('quantity must be a positive number.'); }

    var issueDate = input.issueDate || formatDateForMySQL_(new Date());

    var result = DatabaseService.executeTransaction(function (conn) {
      ensureStockRowExists_('fabric_stock', 'fabric_id', input.fabricId, conn);
      var available = getClosingStock_('fabric_stock', 'fabric_id', input.fabricId, conn);
      if (input.quantity > available) {
        throw new Error('BUSINESS_RULE: Cannot issue ' + input.quantity + ' - only ' + available + ' available in stock.');
      }

      var txnId = DatabaseService.executeInsert(
        "INSERT INTO fabric_transactions (fabric_id, job_card_id, txn_type, txn_date, quantity, issued_to, vendor_id, remarks, created_by) " +
        "VALUES (?, ?, 'Issue', ?, ?, 'Fabricator', ?, ?, ?)",
        [input.fabricId, input.jobCardId, issueDate, input.quantity, input.vendorId, input.remarks || null, user.userId],
        conn
      );
      DatabaseService.executeUpdate(
        'UPDATE fabric_stock SET issued_qty = issued_qty + ? WHERE fabric_id = ?',
        [input.quantity, input.fabricId],
        conn
      );
      var issueId = DatabaseService.executeInsert(
        'INSERT INTO fabric_fabricator_issues (txn_id, job_card_id, vendor_id, issue_date, expected_return_date, status) ' +
        "VALUES (?, ?, ?, ?, ?, 'Issued')",
        [txnId, input.jobCardId, input.vendorId, issueDate, input.expectedReturnDate || null],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Inventory Issue', 'Fabric', ?, ?)",
        [user.userId, String(issueId), JSON.stringify({ fabricId: input.fabricId, quantity: input.quantity, vendorId: input.vendorId })],
        conn
      );
      return { txnId: txnId, issueId: issueId };
    });

    return successResponse_(result, 'Fabric issued to fabricator.');
  }

  /**
   * Fabricator returns (fully or partially) previously-issued fabric, with a
   * QC verdict on what came back. Records a fabric_transactions 'Return' row
   * for returnedQty and updates the fabricator_issues tracking row.
   */
  function returnFabricFromFabricator(sessionId, issueId, returnedQty, qcStatus, qcRemarks) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.edit')) {
      return errorResponse_('You do not have permission to record inventory movements.');
    }
    if (!isPositiveInteger_(issueId)) { return errorResponse_('A valid issueId is required.'); }
    if (typeof returnedQty !== 'number' || returnedQty < 0) { return errorResponse_('returnedQty must be a non-negative number.'); }
    if (!isValidEnum_(qcStatus, QC_STATUS_VALUES)) { return errorResponse_('qcStatus must be one of: ' + QC_STATUS_VALUES.join(', ')); }

    var issueRows = DatabaseService.executeQuery(
      'SELECT ffi.*, ft.fabric_id FROM fabric_fabricator_issues ffi ' +
      'JOIN fabric_transactions ft ON ft.txn_id = ffi.txn_id WHERE ffi.issue_id = ? LIMIT 1',
      [issueId]
    );
    if (issueRows.length === 0) { return errorResponse_('Fabricator issue record not found.'); }
    var issue = issueRows[0];
    if (issue.status === 'Returned' || issue.status === 'Closed') {
      return errorResponse_('This issue has already been ' + issue.status.toLowerCase() + '.');
    }

    var today = formatDateForMySQL_(new Date());
    var newStatus = qcStatus === 'Passed' || qcStatus === 'Partial' ? 'Returned' : 'Returned';

    var result = DatabaseService.executeTransaction(function (conn) {
      if (returnedQty > 0) {
        DatabaseService.executeInsert(
          "INSERT INTO fabric_transactions (fabric_id, job_card_id, txn_type, txn_date, quantity, issued_to, vendor_id, remarks, created_by) " +
          "VALUES (?, ?, 'Return', ?, ?, 'Fabricator', ?, ?, ?)",
          [issue.fabric_id, issue.job_card_id, today, returnedQty, issue.vendor_id, qcRemarks || null, user.userId],
          conn
        );
        DatabaseService.executeUpdate(
          'UPDATE fabric_stock SET returned_qty = returned_qty + ? WHERE fabric_id = ?',
          [returnedQty, issue.fabric_id],
          conn
        );
      }
      DatabaseService.executeUpdate(
        'UPDATE fabric_fabricator_issues SET actual_return_date = ?, returned_qty = returned_qty + ?, qc_status = ?, qc_remarks = ?, status = ? WHERE issue_id = ?',
        [today, returnedQty, qcStatus, qcRemarks || null, newStatus, issueId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Inventory Return', 'Fabric', ?, ?)",
        [user.userId, String(issueId), JSON.stringify({ returnedQty: returnedQty, qcStatus: qcStatus })],
        conn
      );
      return null;
    });

    return successResponse_(result, 'Fabricator return recorded.');
  }

  function listFabricatorIssues(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'inventory.view')) {
      return errorResponse_('You do not have permission to view inventory.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('ffi.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isPositiveInteger_(filters.vendorId)) { where.push('ffi.vendor_id = ?'); params.push(filters.vendorId); }
    if (isNonEmptyString_(filters.status)) { where.push('ffi.status = ?'); params.push(filters.status); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM fabric_fabricator_issues ffi ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT ffi.*, v.vendor_name, jc.job_card_no, f.fabric_code ' +
      'FROM fabric_fabricator_issues ffi ' +
      'JOIN vendors v ON v.vendor_id = ffi.vendor_id ' +
      'JOIN job_cards jc ON jc.job_card_id = ffi.job_card_id ' +
      'JOIN fabric_transactions ft ON ft.txn_id = ffi.txn_id ' +
      'JOIN fabric f ON f.fabric_id = ft.fabric_id ' +
      whereSql + ' ORDER BY ffi.issue_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  // ---------------------------------------------------------------------
  // General inventory (trims / thread / button / zipper / label / packaging)
  // ---------------------------------------------------------------------

  function recordInventoryTransaction(sessionId, input) {
    return recordMovement_('inventory_items', 'item_id', 'inventory_stock', 'inventory_transactions', sessionId, input);
  }
  function getInventoryStock(sessionId, itemId) {
    return getStock_('inventory_stock', 'item_id', 'inventory_items', sessionId, itemId);
  }
  function listInventoryStock(sessionId, lowStockOnly) {
    return listStock_('inventory_stock', 'item_id', 'inventory_items', sessionId, lowStockOnly);
  }
  function listInventoryTransactions(sessionId, filters, page, pageSize) {
    return listTransactions_('inventory_transactions', 'item_id', 'inventory_items', sessionId, filters, page, pageSize);
  }

  return {
    recordFabricTransaction: withErrorHandling_(recordFabricTransaction),
    getFabricStock: withErrorHandling_(getFabricStock),
    listFabricStock: withErrorHandling_(listFabricStock),
    listFabricTransactions: withErrorHandling_(listFabricTransactions),
    issueFabricToFabricator: withErrorHandling_(issueFabricToFabricator),
    returnFabricFromFabricator: withErrorHandling_(returnFabricFromFabricator),
    listFabricatorIssues: withErrorHandling_(listFabricatorIssues),

    recordInventoryTransaction: withErrorHandling_(recordInventoryTransaction),
    getInventoryStock: withErrorHandling_(getInventoryStock),
    listInventoryStock: withErrorHandling_(listInventoryStock),
    listInventoryTransactions: withErrorHandling_(listInventoryTransactions)
  };
})();
