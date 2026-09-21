/**
 * FMSService.gs
 * Phase 7 deliverable. Stage transitions for the 7-stage FMS flow, plus
 * calculatePlannedEnd() (spec section 10) - a reusable backend service that
 * reads tat_rules/shifts/working_days/holidays instead of hardcoding hours.
 *
 * ES5 only.
 *
 * Sequence enforcement is NOT duplicated here in application code - the
 * schema.sql triggers (trg_fms_before_insert_dependency /
 * trg_fms_before_update_dependency) are the actual backend enforcement
 * (spec section 7: "never rely only on JavaScript validation... backend
 * validation is mandatory"), and Database.gs's rethrowDatabaseError_ passes
 * their BUSINESS_RULE: message straight through as a friendly error. This
 * service still does its own status-shape checks (e.g. "can't start
 * something already Done") before touching the DB, purely so the common
 * mistakes get an immediate, specific message rather than a round trip.
 */

var FMSService = (function () {

  var STAGE_STATUS_VALUES = ['Pending', 'Started', 'In Progress', 'Done', 'Hold', 'Cancelled'];

  // ---------------------------------------------------------------------
  // calculatePlannedEnd() - spec section 10
  // ---------------------------------------------------------------------

  function getTatHoursForStage_(stageId, quantity, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT tat_hours FROM tat_rules ' +
      'WHERE stage_id = ? AND min_quantity <= ? AND (max_quantity IS NULL OR max_quantity >= ?) ' +
      '  AND is_active = 1 AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) ' +
      'ORDER BY effective_from DESC LIMIT 1',
      [stageId, quantity, quantity],
      conn
    );
    if (rows.length === 0) {
      throw new Error('No active TAT rule is configured for this stage and quantity. Add one to tat_rules before starting this stage.');
    }
    return Number(rows[0].tat_hours);
  }

  function normalizeTimeString_(value) {
    if (value === null || typeof value === 'undefined') { return null; }
    var str = String(value);
    if (str.indexOf(' ') > -1) { str = str.split(' ')[1]; }
    if (str.indexOf('T') > -1) { str = str.split('T')[1]; }
    return str.substring(0, 8); // 'HH:mm:ss'
  }

  function getWorkingDaysMap_(conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT wd.day_of_week, wd.is_working, s.start_time, s.end_time, s.break_start, s.break_end ' +
      'FROM working_days wd LEFT JOIN shifts s ON s.shift_id = wd.shift_id',
      [],
      conn
    );
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      map[Number(r.day_of_week)] = {
        isWorking: Number(r.is_working) === 1,
        startTime: normalizeTimeString_(r.start_time),
        endTime: normalizeTimeString_(r.end_time),
        breakStart: normalizeTimeString_(r.break_start),
        breakEnd: normalizeTimeString_(r.break_end)
      };
    }
    return map;
  }

  function normalizeDateKey_(value) {
    if (value === null || typeof value === 'undefined') { return null; }
    if (Object.prototype.toString.call(value) === '[object Date]') { return formatDateForMySQL_(value); }
    var str = String(value);
    if (str.indexOf(' ') > -1) { str = str.split(' ')[0]; }
    if (str.indexOf('T') > -1) { str = str.split('T')[0]; }
    return str.substring(0, 10);
  }

  function getHolidaySet_(conn) {
    var rows = DatabaseService.executeQuery('SELECT holiday_date FROM holidays WHERE is_active = 1', [], conn);
    var set = {};
    for (var i = 0; i < rows.length; i++) {
      var key = normalizeDateKey_(rows[i].holiday_date);
      if (key) { set[key] = true; }
    }
    return set;
  }

  function combineDateAndTime_(dateBase, hhmmss) {
    var dateStr = formatDateForMySQL_(dateBase);
    return Utilities.parseDate(dateStr + ' ' + hhmmss, APP_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
  }

  // India observes no DST, so this simple date-key round trip is safe here
  // (would NOT be safe as written in a DST-observing time zone).
  function startOfNextDay_(date) {
    var dateKey = formatDateForMySQL_(date);
    var next = Utilities.parseDate(dateKey, APP_TIME_ZONE, 'yyyy-MM-dd');
    next.setDate(next.getDate() + 1);
    return next;
  }

  function getWorkingWindowForDate_(cursor, workingDaysMap, holidaySet) {
    var dateKey = formatDateForMySQL_(cursor);
    if (holidaySet[dateKey]) { return null; }
    var dow = cursor.getDay(); // JS: 0=Sunday..6=Saturday - matches working_days.day_of_week convention exactly
    var dayCfg = workingDaysMap[dow];
    if (!dayCfg || !dayCfg.isWorking || !dayCfg.startTime || !dayCfg.endTime) { return null; }
    return {
      shiftStart: combineDateAndTime_(cursor, dayCfg.startTime),
      shiftEnd: combineDateAndTime_(cursor, dayCfg.endTime),
      breakStart: dayCfg.breakStart ? combineDateAndTime_(cursor, dayCfg.breakStart) : null,
      breakEnd: dayCfg.breakEnd ? combineDateAndTime_(cursor, dayCfg.breakEnd) : null
    };
  }

  /**
   * Actual Start + TAT = Planned End, but the calculation only "spends"
   * minutes during configured working hours (skipping non-working days,
   * holidays, and the shift's break window), continuing into the next
   * working period when a day's remaining window runs out (spec section 10).
   *
   * conn is optional; pass the current transaction's conn when calling this
   * from inside DatabaseService.executeTransaction, or omit it to use a
   * standalone connection.
   */
  function calculatePlannedEnd(startDateTime, stageId, quantity, conn) {
    var tatHours = getTatHoursForStage_(stageId, quantity, conn);
    var workingDaysMap = getWorkingDaysMap_(conn);
    var holidaySet = getHolidaySet_(conn);

    var remainingMinutes = tatHours * 60;
    var cursor = new Date(startDateTime.getTime());
    var maxIterations = 2000; // generous day-step ceiling; guards against a misconfigured calendar (e.g. no working days at all) looping forever
    var iterations = 0;

    while (remainingMinutes > 0.0001 && iterations < maxIterations) {
      iterations++;
      var win = getWorkingWindowForDate_(cursor, workingDaysMap, holidaySet);
      if (!win) { cursor = startOfNextDay_(cursor); continue; }
      if (cursor.getTime() < win.shiftStart.getTime()) { cursor = new Date(win.shiftStart.getTime()); }
      if (cursor.getTime() >= win.shiftEnd.getTime()) { cursor = startOfNextDay_(cursor); continue; }
      if (win.breakStart && win.breakEnd && cursor.getTime() >= win.breakStart.getTime() && cursor.getTime() < win.breakEnd.getTime()) {
        cursor = new Date(win.breakEnd.getTime());
        continue;
      }
      var windowEnd = win.shiftEnd;
      if (win.breakStart && cursor.getTime() < win.breakStart.getTime()) { windowEnd = win.breakStart; }
      var availableMinutes = (windowEnd.getTime() - cursor.getTime()) / 60000;
      if (availableMinutes <= 0) { cursor = startOfNextDay_(cursor); continue; }
      if (remainingMinutes <= availableMinutes) {
        cursor = new Date(cursor.getTime() + Math.round(remainingMinutes * 60000));
        remainingMinutes = 0;
      } else {
        remainingMinutes -= availableMinutes;
        cursor = new Date(windowEnd.getTime());
      }
    }

    if (iterations >= maxIterations) {
      throw new Error('Could not resolve a planned end date within ' + maxIterations + ' day-steps - check that at least one working day has a shift assigned in working_days/shifts.');
    }
    return cursor;
  }

  // ---------------------------------------------------------------------
  // Shared lookups
  // ---------------------------------------------------------------------

  function getStageTxn_(jobCardId, stageId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT stage_txn_id, job_card_id, stage_id, sequence_no, status, quantity, completed_qty ' +
      'FROM fms_stage_transactions WHERE job_card_id = ? AND stage_id = ? LIMIT 1',
      [jobCardId, stageId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------
  // startStage
  // ---------------------------------------------------------------------

  function startStage(sessionId, jobCardId, stageId, assignedTo) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'fms.edit')) {
      return errorResponse_('You do not have permission to update FMS stages.');
    }
    if (!isPositiveInteger_(jobCardId) || !isPositiveInteger_(stageId)) {
      return errorResponse_('A valid jobCardId and stageId are required.');
    }

    var stageTxn = getStageTxn_(jobCardId, stageId, null);
    if (!stageTxn) { return errorResponse_('FMS stage record not found for this job card.'); }
    if (stageTxn.status === 'Done') { return errorResponse_('This stage is already Done.'); }
    if (stageTxn.status === 'Cancelled') { return errorResponse_('This stage was cancelled.'); }
    if (stageTxn.status === 'Hold') { return errorResponse_('This stage is on hold - use resumeStage instead.'); }
    if (stageTxn.status === 'Started' || stageTxn.status === 'In Progress') {
      return errorResponse_('This stage has already been started.');
    }

    var now = new Date();

    DatabaseService.executeTransaction(function (conn) {
      var plannedEnd = calculatePlannedEnd(now, stageId, stageTxn.quantity, conn);
      DatabaseService.executeUpdate(
        "UPDATE fms_stage_transactions SET status = 'Started', actual_start = ?, planned_start = ?, planned_end = ?, assigned_to = ? " +
        'WHERE stage_txn_id = ?',
        [formatDateTimeForMySQL_(now), formatDateTimeForMySQL_(now), formatDateTimeForMySQL_(plannedEnd), assignedTo || null, stageTxn.stage_txn_id],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'FMS', ?, ?)",
        [user.userId, String(stageTxn.stage_txn_id), JSON.stringify({ status: 'Started', plannedEnd: formatDateTimeForMySQL_(plannedEnd) })],
        conn
      );
      return null;
    });

    return successResponse_(getStageTxn_(jobCardId, stageId, null), 'Stage started.');
  }

  // ---------------------------------------------------------------------
  // updateStageProgress - records completed quantity; auto-transitions to
  // In Progress (partial) or Done (fully complete, sets actual_end).
  // ---------------------------------------------------------------------

  function updateStageProgress(sessionId, jobCardId, stageId, completedQty, remarks) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'fms.edit')) {
      return errorResponse_('You do not have permission to update FMS stages.');
    }
    if (!isPositiveInteger_(jobCardId) || !isPositiveInteger_(stageId)) {
      return errorResponse_('A valid jobCardId and stageId are required.');
    }
    if (typeof completedQty !== 'number' || completedQty < 0) {
      return errorResponse_('completedQty must be a non-negative number.');
    }

    var stageTxn = getStageTxn_(jobCardId, stageId, null);
    if (!stageTxn) { return errorResponse_('FMS stage record not found for this job card.'); }
    if (stageTxn.status === 'Pending') { return errorResponse_('Start this stage before recording progress.'); }
    if (stageTxn.status === 'Done' || stageTxn.status === 'Cancelled') {
      return errorResponse_('This stage is already ' + stageTxn.status + ' and cannot be updated.');
    }
    if (stageTxn.status === 'Hold') { return errorResponse_('This stage is on hold - resume it before recording progress.'); }
    if (completedQty > stageTxn.quantity) {
      return errorResponse_('completedQty (' + completedQty + ') cannot exceed the stage quantity (' + stageTxn.quantity + ').');
    }

    var isDone = completedQty >= stageTxn.quantity;
    var newStatus = isDone ? 'Done' : 'In Progress';
    var now = new Date();

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE fms_stage_transactions SET completed_qty = ?, status = ?, remarks = ?' +
        (isDone ? ', actual_end = ?' : '') +
        ' WHERE stage_txn_id = ?',
        isDone
          ? [completedQty, newStatus, remarks || null, formatDateTimeForMySQL_(now), stageTxn.stage_txn_id]
          : [completedQty, newStatus, remarks || null, stageTxn.stage_txn_id],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, ?, 'FMS', ?, ?)",
        [
          user.userId,
          isDone ? 'Production Completion' : 'Update',
          String(stageTxn.stage_txn_id),
          JSON.stringify({ completedQty: completedQty, status: newStatus })
        ],
        conn
      );
      return null;
    });

    return successResponse_(getStageTxn_(jobCardId, stageId, null), isDone ? 'Stage completed.' : 'Progress recorded.');
  }

  // ---------------------------------------------------------------------
  // holdStage / resumeStage
  // ---------------------------------------------------------------------

  function holdStage(sessionId, jobCardId, stageId, remarks) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'fms.edit')) {
      return errorResponse_('You do not have permission to update FMS stages.');
    }
    var stageTxn = getStageTxn_(jobCardId, stageId, null);
    if (!stageTxn) { return errorResponse_('FMS stage record not found for this job card.'); }
    if (stageTxn.status !== 'Started' && stageTxn.status !== 'In Progress') {
      return errorResponse_('Only a Started/In Progress stage can be put on hold (current status: ' + stageTxn.status + ').');
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        "UPDATE fms_stage_transactions SET status = 'Hold', remarks = ? WHERE stage_txn_id = ?",
        [remarks || null, stageTxn.stage_txn_id],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'FMS', ?, ?, ?)",
        [user.userId, String(stageTxn.stage_txn_id), JSON.stringify({ status: stageTxn.status }), JSON.stringify({ status: 'Hold', remarks: remarks || null })],
        conn
      );
      return null;
    });

    return successResponse_(getStageTxn_(jobCardId, stageId, null), 'Stage put on hold.');
  }

  function resumeStage(sessionId, jobCardId, stageId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'fms.edit')) {
      return errorResponse_('You do not have permission to update FMS stages.');
    }
    var stageTxn = getStageTxn_(jobCardId, stageId, null);
    if (!stageTxn) { return errorResponse_('FMS stage record not found for this job card.'); }
    if (stageTxn.status !== 'Hold') {
      return errorResponse_('This stage is not on hold (current status: ' + stageTxn.status + ').');
    }
    var resumedStatus = stageTxn.completed_qty > 0 ? 'In Progress' : 'Started';

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate(
        'UPDATE fms_stage_transactions SET status = ? WHERE stage_txn_id = ?',
        [resumedStatus, stageTxn.stage_txn_id],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'FMS', ?, ?, ?)",
        [user.userId, String(stageTxn.stage_txn_id), JSON.stringify({ status: 'Hold' }), JSON.stringify({ status: resumedStatus })],
        conn
      );
      return null;
    });

    return successResponse_(getStageTxn_(jobCardId, stageId, null), 'Stage resumed.');
  }

  // ---------------------------------------------------------------------
  // listStageQueue - "what's pending/in-progress at this stage right now",
  // the working screen for a stage owner (e.g. the Cutting Manager's view).
  // ---------------------------------------------------------------------

  function listStageQueue(sessionId, stageId, statusFilter, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'fms.view')) {
      return errorResponse_('You do not have permission to view FMS stages.');
    }
    if (!isPositiveInteger_(stageId)) {
      return errorResponse_('A valid stageId is required.');
    }
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var whereClauses = ['fst.stage_id = ?'];
    var params = [stageId];
    if (isNonEmptyString_(statusFilter) && isValidEnum_(statusFilter, STAGE_STATUS_VALUES)) {
      whereClauses.push('fst.status = ?');
      params.push(statusFilter);
    }
    var whereSql = 'WHERE ' + whereClauses.join(' AND ');

    var countRows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS total FROM fms_stage_transactions fst ' + whereSql,
      params
    );
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT fst.stage_txn_id, fst.job_card_id, jc.job_card_no, b.buyer_name, s.style_no, ' +
      '       fst.status, fst.quantity, fst.completed_qty, fst.pending_qty, ' +
      '       fst.planned_start, fst.planned_end, fst.actual_start, fst.actual_end ' +
      'FROM fms_stage_transactions fst ' +
      'JOIN job_cards jc ON jc.job_card_id = fst.job_card_id ' +
      'JOIN buyers b ON b.buyer_id = jc.buyer_id ' +
      'JOIN styles s ON s.style_id = jc.style_id ' +
      whereSql +
      ' ORDER BY fst.stage_txn_id DESC LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows,
      page: pageNum,
      pageSize: size,
      total: total,
      totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  return {
    calculatePlannedEnd: calculatePlannedEnd,
    startStage: withErrorHandling_(startStage),
    updateStageProgress: withErrorHandling_(updateStageProgress),
    holdStage: withErrorHandling_(holdStage),
    resumeStage: withErrorHandling_(resumeStage),
    listStageQueue: withErrorHandling_(listStageQueue)
  };
})();

/**
 * Manual check. Run from the editor after the DB connection test passes.
 * Confirms calculatePlannedEnd() actually reaches the DB and returns a
 * sane forward-dated result (it cannot be unit-tested outside the Apps
 * Script runtime, unlike the algorithm's pure logic, which was traced by
 * hand against the seeded shift/working_days/holidays data before delivery).
 */
function testCalculatePlannedEnd_() {
  var start = new Date(); // "now", in whatever stage/quantity band your tat_rules cover
  var stageId = 3; // Stitching
  var quantity = 600; // falls in the 500-999 band per seed.sql's tat_rules
  var plannedEnd = FMSService.calculatePlannedEnd(start, stageId, quantity, null);
  Logger.log('Start: ' + start + ' | Planned end: ' + plannedEnd);
}
