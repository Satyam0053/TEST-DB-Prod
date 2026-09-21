/**
 * DeliveryService.gs
 * Phase 12 deliverable. Packing -> ready -> dispatch tracking per job card,
 * against order_qty, plus on-time-delivery (OTD) reporting.
 *
 * ES5 only.
 *
 * delivery.chk_delivery_qty (dispatched_qty <= order_qty) is enforced by the
 * DB; packed_qty <= order_qty and ready_qty <= packed_qty are app-level
 * checks only (the schema doesn't constrain them, but the workflow implies
 * the ordering - defense in depth still applies, so these are checked here,
 * not assumed from the client).
 */

var DeliveryService = (function () {

  var STATUS_VALUES = ['Pending', 'Ready', 'Partially Dispatched', 'Dispatched', 'Delayed'];

  /**
   * Derives delivery_status from the current quantities and today's date
   * relative to target_delivery_date - the same auto-transition pattern
   * used for fms_stage_transactions/production_bundles/artwork elsewhere in
   * this project, so status is always a function of state rather than
   * something the client sets directly.
   */
  function deriveStatus_(orderQty, readyQty, dispatchedQty, targetDeliveryDate) {
    if (dispatchedQty >= orderQty && orderQty > 0) { return 'Dispatched'; }
    if (dispatchedQty > 0) { return 'Partially Dispatched'; }
    if (readyQty >= orderQty && orderQty > 0) { return 'Ready'; }
    if (targetDeliveryDate) {
      var today = formatDateForMySQL_(new Date());
      if (today > normalizeDateOnly_(targetDeliveryDate)) { return 'Delayed'; }
    }
    return 'Pending';
  }

  function normalizeDateOnly_(value) {
    if (value === null || typeof value === 'undefined') { return null; }
    if (Object.prototype.toString.call(value) === '[object Date]') { return formatDateForMySQL_(value); }
    var str = String(value);
    if (str.indexOf(' ') > -1) { str = str.split(' ')[0]; }
    if (str.indexOf('T') > -1) { str = str.split('T')[0]; }
    return str.substring(0, 10);
  }

  function getDelivery_(deliveryId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT d.*, jc.job_card_no, b.buyer_name ' +
      'FROM delivery d ' +
      'JOIN job_cards jc ON jc.job_card_id = d.job_card_id ' +
      'JOIN buyers b ON b.buyer_id = jc.buyer_id ' +
      'WHERE d.delivery_id = ? LIMIT 1',
      [deliveryId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------

  function createDeliveryRecord(sessionId, jobCardId, targetDeliveryDate) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.edit')) {
      return errorResponse_('You do not have permission to create delivery records.');
    }
    if (!isPositiveInteger_(jobCardId)) { return errorResponse_('A valid jobCardId is required.'); }

    var jcRows = DatabaseService.executeQuery('SELECT job_card_id, order_qty, target_date FROM job_cards WHERE job_card_id = ?', [jobCardId]);
    if (jcRows.length === 0) { return errorResponse_('Job card not found.'); }
    var existing = DatabaseService.executeQuery('SELECT delivery_id FROM delivery WHERE job_card_id = ? LIMIT 1', [jobCardId]);
    if (existing.length > 0) { return errorResponse_('A delivery record already exists for this job card.'); }

    var jc = jcRows[0];
    var target = targetDeliveryDate || jc.target_date;
    var status = deriveStatus_(Number(jc.order_qty), 0, 0, target);

    var newDeliveryId = DatabaseService.executeTransaction(function (conn) {
      var deliveryId = DatabaseService.executeInsert(
        'INSERT INTO delivery (job_card_id, order_qty, target_delivery_date, delivery_status) VALUES (?, ?, ?, ?)',
        [jobCardId, jc.order_qty, target || null, status],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Delivery', ?, ?)",
        [user.userId, String(deliveryId), JSON.stringify({ jobCardId: jobCardId, orderQty: jc.order_qty, targetDeliveryDate: target || null })],
        conn
      );
      return deliveryId;
    });

    return successResponse_(getDelivery_(newDeliveryId, null), 'Delivery record created.');
  }

  function recordPacking(sessionId, deliveryId, packedQty) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.edit')) {
      return errorResponse_('You do not have permission to update delivery records.');
    }
    var delivery = getDelivery_(deliveryId, null);
    if (!delivery) { return errorResponse_('Delivery record not found.'); }
    packedQty = Number(packedQty) || 0;
    if (packedQty < 0) { return errorResponse_('packedQty cannot be negative.'); }
    if (packedQty > Number(delivery.order_qty)) {
      return errorResponse_('packedQty (' + packedQty + ') cannot exceed order qty (' + delivery.order_qty + ').');
    }

    var status = deriveStatus_(Number(delivery.order_qty), Number(delivery.ready_qty), Number(delivery.dispatched_qty), delivery.target_delivery_date);

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE delivery SET packed_qty = ?, delivery_status = ? WHERE delivery_id = ?',
        [packedQty, status, deliveryId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'Delivery', ?, ?)",
        [user.userId, String(deliveryId), JSON.stringify({ packedQty: packedQty })],
        conn
      );
      return null;
    });

    return successResponse_(getDelivery_(deliveryId, null), 'Packing recorded.');
  }

  function recordReady(sessionId, deliveryId, readyQty) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.edit')) {
      return errorResponse_('You do not have permission to update delivery records.');
    }
    var delivery = getDelivery_(deliveryId, null);
    if (!delivery) { return errorResponse_('Delivery record not found.'); }
    readyQty = Number(readyQty) || 0;
    if (readyQty < 0) { return errorResponse_('readyQty cannot be negative.'); }
    if (readyQty > Number(delivery.packed_qty)) {
      return errorResponse_('readyQty (' + readyQty + ') cannot exceed packed qty (' + delivery.packed_qty + ').');
    }

    var status = deriveStatus_(Number(delivery.order_qty), readyQty, Number(delivery.dispatched_qty), delivery.target_delivery_date);

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE delivery SET ready_qty = ?, delivery_status = ? WHERE delivery_id = ?',
        [readyQty, status, deliveryId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'Delivery', ?, ?)",
        [user.userId, String(deliveryId), JSON.stringify({ readyQty: readyQty })],
        conn
      );
      return null;
    });

    return successResponse_(getDelivery_(deliveryId, null), 'Ready quantity recorded.');
  }

  function recordDispatch(sessionId, deliveryId, dispatchedQty, dispatchDate) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.edit')) {
      return errorResponse_('You do not have permission to update delivery records.');
    }
    var delivery = getDelivery_(deliveryId, null);
    if (!delivery) { return errorResponse_('Delivery record not found.'); }
    dispatchedQty = Number(dispatchedQty) || 0;
    if (dispatchedQty < 0) { return errorResponse_('dispatchedQty cannot be negative.'); }
    if (dispatchedQty > Number(delivery.ready_qty)) {
      return errorResponse_('dispatchedQty (' + dispatchedQty + ') cannot exceed ready qty (' + delivery.ready_qty + ').');
    }

    var status = deriveStatus_(Number(delivery.order_qty), Number(delivery.ready_qty), dispatchedQty, delivery.target_delivery_date);
    var date = dispatchDate || formatDateForMySQL_(new Date());
    var setDeliveryDate = status === 'Dispatched';

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE delivery SET dispatched_qty = ?, delivery_status = ?' + (setDeliveryDate ? ', delivery_date = ?' : '') + ' WHERE delivery_id = ?',
        setDeliveryDate ? [dispatchedQty, status, date, deliveryId] : [dispatchedQty, status, deliveryId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'Delivery', ?, ?)",
        [user.userId, String(deliveryId), JSON.stringify({ dispatchedQty: dispatchedQty, status: status })],
        conn
      );
      return null;
    });

    return successResponse_(getDelivery_(deliveryId, null), 'Dispatch recorded.');
  }

  /**
   * Recomputes status from current quantities/date without changing any
   * quantity - for a Pending/Ready record whose target_delivery_date has
   * since passed (there is no background scheduler in this phase; call this
   * from the Delivery module screen's refresh, or wire it to a time-driven
   * trigger later).
   */
  function refreshDeliveryStatus(sessionId, deliveryId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.edit')) {
      return errorResponse_('You do not have permission to update delivery records.');
    }
    var delivery = getDelivery_(deliveryId, null);
    if (!delivery) { return errorResponse_('Delivery record not found.'); }
    if (delivery.delivery_status === 'Dispatched') { return successResponse_(delivery, 'Already Dispatched - nothing to refresh.'); }

    var status = deriveStatus_(Number(delivery.order_qty), Number(delivery.ready_qty), Number(delivery.dispatched_qty), delivery.target_delivery_date);
    if (status !== delivery.delivery_status) {
      DatabaseService.executeUpdate('UPDATE delivery SET delivery_status = ? WHERE delivery_id = ?', [status, deliveryId]);
    }
    return successResponse_(getDelivery_(deliveryId, null), 'Status refreshed.');
  }

  function getDelivery(sessionId, deliveryId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.view')) {
      return errorResponse_('You do not have permission to view delivery records.');
    }
    if (!isPositiveInteger_(deliveryId)) { return errorResponse_('A valid deliveryId is required.'); }
    var delivery = getDelivery_(deliveryId, null);
    if (!delivery) { return errorResponse_('Delivery record not found.'); }
    return successResponse_(delivery);
  }

  function listDeliveries(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.view')) {
      return errorResponse_('You do not have permission to view delivery records.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.jobCardId)) { where.push('d.job_card_id = ?'); params.push(filters.jobCardId); }
    if (isPositiveInteger_(filters.buyerId)) { where.push('jc.buyer_id = ?'); params.push(filters.buyerId); }
    if (isNonEmptyString_(filters.status) && isValidEnum_(filters.status, STATUS_VALUES)) {
      where.push('d.delivery_status = ?'); params.push(filters.status);
    }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS total FROM delivery d JOIN job_cards jc ON jc.job_card_id = d.job_card_id ' + whereSql,
      params
    );
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT d.*, jc.job_card_no, b.buyer_name ' +
      'FROM delivery d ' +
      'JOIN job_cards jc ON jc.job_card_id = d.job_card_id ' +
      'JOIN buyers b ON b.buyer_id = jc.buyer_id ' +
      whereSql + ' ORDER BY d.delivery_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  /**
   * On-time-delivery %: of the records that have actually Dispatched,
   * delivery_date <= target_delivery_date counts as on time. Records with
   * no target_delivery_date are excluded (there's nothing to be "on time"
   * against).
   */
  function getOtdSummary(sessionId, filters) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'delivery.view')) {
      return errorResponse_('You do not have permission to view delivery records.');
    }
    filters = filters || {};
    var where = ["d.delivery_status = 'Dispatched'", 'd.delivery_date IS NOT NULL', 'd.target_delivery_date IS NOT NULL'];
    var params = [];
    if (isPositiveInteger_(filters.buyerId)) { where.push('jc.buyer_id = ?'); params.push(filters.buyerId); }
    if (isNonEmptyString_(filters.fromDate)) { where.push('d.delivery_date >= ?'); params.push(filters.fromDate); }
    if (isNonEmptyString_(filters.toDate)) { where.push('d.delivery_date <= ?'); params.push(filters.toDate); }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var rows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS total_dispatched, ' +
      'SUM(CASE WHEN d.delivery_date <= d.target_delivery_date THEN 1 ELSE 0 END) AS on_time_count ' +
      'FROM delivery d JOIN job_cards jc ON jc.job_card_id = d.job_card_id ' + whereSql,
      params
    );
    var totalDispatched = Number(rows[0].total_dispatched);
    var onTimeCount = Number(rows[0].on_time_count) || 0;
    var otdPct = totalDispatched > 0 ? Math.round((onTimeCount / totalDispatched) * 10000) / 100 : null;

    return successResponse_({
      totalDispatched: totalDispatched,
      onTimeCount: onTimeCount,
      delayedCount: totalDispatched - onTimeCount,
      otdPct: otdPct
    });
  }

  return {
    createDeliveryRecord: withErrorHandling_(createDeliveryRecord),
    recordPacking: withErrorHandling_(recordPacking),
    recordReady: withErrorHandling_(recordReady),
    recordDispatch: withErrorHandling_(recordDispatch),
    refreshDeliveryStatus: withErrorHandling_(refreshDeliveryStatus),
    getDelivery: withErrorHandling_(getDelivery),
    listDeliveries: withErrorHandling_(listDeliveries),
    getOtdSummary: withErrorHandling_(getOtdSummary)
  };
})();
