/**
 * PurchaseService.gs
 * Phase 13 deliverable. Purchase order CRUD. Job cards are created against
 * an existing PO (JobCardService.createJobCard derives buyer/style/article
 * from it, per DATA_MODEL.md) - so a PO's order_qty/buyer/style are
 * effectively load-bearing for every job card raised against it and, like
 * JobCardService.updateJobCard's treatment of order_qty, are not editable
 * once set; only target_delivery_date/remarks and status are.
 *
 * ES5 only.
 */

var PurchaseService = (function () {

  var STATUS_VALUES = ['Open', 'In Production', 'Completed', 'Closed', 'Cancelled'];
  // Forward-only transitions; Cancelled/Closed/Completed are terminal.
  var ALLOWED_TRANSITIONS = {
    'Open': ['In Production', 'Cancelled'],
    'In Production': ['Completed', 'Cancelled'],
    'Completed': ['Closed'],
    'Closed': [],
    'Cancelled': []
  };

  function generatePoNumber_(conn, year) {
    var rows = DatabaseService.executeQuery(
      "SELECT COUNT(*) AS cnt FROM purchase_orders WHERE po_number LIKE ?",
      ['PO-' + year + '-%'],
      conn
    );
    var seq = Number(rows[0].cnt) + 1;
    return 'PO-' + year + '-' + ('000' + seq).slice(-3);
  }

  function getPurchaseOrder_(poId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT po.*, b.buyer_name, s.style_no, s.style_name, ' +
      '  (SELECT COUNT(*) FROM job_cards jc WHERE jc.po_id = po.po_id) AS job_card_count, ' +
      '  (SELECT COALESCE(SUM(jc.order_qty), 0) FROM job_cards jc WHERE jc.po_id = po.po_id AND jc.status != "Cancelled") AS job_carded_qty ' +
      'FROM purchase_orders po ' +
      'JOIN buyers b ON b.buyer_id = po.buyer_id ' +
      'JOIN styles s ON s.style_id = po.style_id ' +
      'WHERE po.po_id = ? LIMIT 1',
      [poId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------

  function createPurchaseOrder(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'purchase.edit')) {
      return errorResponse_('You do not have permission to create purchase orders.');
    }
    if (!input || !isPositiveInteger_(input.buyerId) || !isPositiveInteger_(input.styleId)) {
      return errorResponse_('buyerId and styleId are required.');
    }
    if (!isPositiveInteger_(input.orderQty)) { return errorResponse_('orderQty must be a positive integer.'); }

    var buyerRows = DatabaseService.executeQuery('SELECT buyer_id FROM buyers WHERE buyer_id = ? AND is_active = 1', [input.buyerId]);
    if (buyerRows.length === 0) { return errorResponse_('Buyer not found or is inactive.'); }
    var styleRows = DatabaseService.executeQuery('SELECT style_id, buyer_id FROM styles WHERE style_id = ? AND is_active = 1', [input.styleId]);
    if (styleRows.length === 0) { return errorResponse_('Style not found or is inactive.'); }
    if (Number(styleRows[0].buyer_id) !== Number(input.buyerId)) {
      return errorResponse_('This style does not belong to the selected buyer.');
    }

    var poDate = input.poDate || formatDateForMySQL_(new Date());
    var year = poDate.substring(0, 4);

    var newPoId = DatabaseService.executeTransaction(function (conn) {
      var poNumber = generatePoNumber_(conn, year);
      var poId = DatabaseService.executeInsert(
        "INSERT INTO purchase_orders (po_number, buyer_id, style_id, order_qty, po_date, target_delivery_date, remarks, created_by, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open')",
        [poNumber, input.buyerId, input.styleId, input.orderQty, poDate, input.targetDeliveryDate || null, input.remarks || null, user.userId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Purchase', ?, ?)",
        [user.userId, String(poId), JSON.stringify({ poNumber: poNumber, buyerId: input.buyerId, styleId: input.styleId, orderQty: input.orderQty })],
        conn
      );
      return poId;
    });

    return successResponse_(getPurchaseOrder_(newPoId, null), 'Purchase order created.');
  }

  /**
   * Whitelisted fields only: targetDeliveryDate, remarks. orderQty/buyerId/
   * styleId are immutable once created (see file header).
   */
  function updatePurchaseOrder(sessionId, poId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'purchase.edit')) {
      return errorResponse_('You do not have permission to update purchase orders.');
    }
    var po = getPurchaseOrder_(poId, null);
    if (!po) { return errorResponse_('Purchase order not found.'); }
    if (po.status === 'Closed' || po.status === 'Cancelled') {
      return errorResponse_('This purchase order is ' + po.status + ' and cannot be edited.');
    }
    if (!input || (typeof input.targetDeliveryDate === 'undefined' && typeof input.remarks === 'undefined')) {
      return errorResponse_('Nothing to update - provide targetDeliveryDate and/or remarks.');
    }

    var setClauses = [];
    var params = [];
    if (typeof input.targetDeliveryDate !== 'undefined') { setClauses.push('target_delivery_date = ?'); params.push(input.targetDeliveryDate || null); }
    if (typeof input.remarks !== 'undefined') { setClauses.push('remarks = ?'); params.push(input.remarks || null); }
    params.push(poId);

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('UPDATE purchase_orders SET ' + setClauses.join(', ') + ' WHERE po_id = ?', params, conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Update', 'Purchase', ?, ?, ?)",
        [user.userId, String(poId), JSON.stringify({ targetDeliveryDate: po.target_delivery_date, remarks: po.remarks }), JSON.stringify(input)],
        conn
      );
      return null;
    });

    return successResponse_(getPurchaseOrder_(poId, null), 'Purchase order updated.');
  }

  function updatePurchaseOrderStatus(sessionId, poId, newStatus) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'purchase.edit')) {
      return errorResponse_('You do not have permission to update purchase orders.');
    }
    if (!isValidEnum_(newStatus, STATUS_VALUES)) { return errorResponse_('status must be one of: ' + STATUS_VALUES.join(', ')); }

    var po = getPurchaseOrder_(poId, null);
    if (!po) { return errorResponse_('Purchase order not found.'); }
    var allowed = ALLOWED_TRANSITIONS[po.status] || [];
    if (allowed.indexOf(newStatus) === -1) {
      return errorResponse_('Cannot move a ' + po.status + ' purchase order to ' + newStatus + '.');
    }
    if (newStatus === 'Cancelled' && Number(po.job_card_count) > 0) {
      return errorResponse_('Cannot cancel a purchase order that already has job cards raised against it.');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('UPDATE purchase_orders SET status = ? WHERE po_id = ?', [newStatus, poId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Purchase', ?, ?, ?)",
        [user.userId, String(poId), JSON.stringify({ status: po.status }), JSON.stringify({ status: newStatus })],
        conn
      );
      return null;
    });

    return successResponse_(getPurchaseOrder_(poId, null), 'Purchase order status updated.');
  }

  function getPurchaseOrder(sessionId, poId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'purchase.view')) {
      return errorResponse_('You do not have permission to view purchase orders.');
    }
    if (!isPositiveInteger_(poId)) { return errorResponse_('A valid poId is required.'); }
    var po = getPurchaseOrder_(poId, null);
    if (!po) { return errorResponse_('Purchase order not found.'); }
    return successResponse_(po);
  }

  function listPurchaseOrders(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'purchase.view')) {
      return errorResponse_('You do not have permission to view purchase orders.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.buyerId)) { where.push('po.buyer_id = ?'); params.push(filters.buyerId); }
    if (isNonEmptyString_(filters.status) && isValidEnum_(filters.status, STATUS_VALUES)) {
      where.push('po.status = ?'); params.push(filters.status);
    }
    if (isNonEmptyString_(filters.search)) {
      where.push('po.po_number LIKE ?'); params.push('%' + filters.search + '%');
    }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM purchase_orders po ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT po.*, b.buyer_name, s.style_no ' +
      'FROM purchase_orders po ' +
      'JOIN buyers b ON b.buyer_id = po.buyer_id ' +
      'JOIN styles s ON s.style_id = po.style_id ' +
      whereSql + ' ORDER BY po.po_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  return {
    createPurchaseOrder: withErrorHandling_(createPurchaseOrder),
    updatePurchaseOrder: withErrorHandling_(updatePurchaseOrder),
    updatePurchaseOrderStatus: withErrorHandling_(updatePurchaseOrderStatus),
    getPurchaseOrder: withErrorHandling_(getPurchaseOrder),
    listPurchaseOrders: withErrorHandling_(listPurchaseOrders)
  };
})();
