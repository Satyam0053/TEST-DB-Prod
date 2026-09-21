/**
 * Database.gs
 * Phase 4 deliverable. DatabaseService: the only place in this project that
 * touches Jdbc directly. Every other Service file goes through this.
 *
 * ES5 only. Every query is a PreparedStatement with bound params - never
 * string-concatenated SQL (spec section 23/rule 9).
 */

var DatabaseService = (function () {

  function getConnection() {
    var cfg = getDbConfig_();
    var url = cfg.jdbcPrefix + cfg.host + ':' + cfg.port + '/' + cfg.name +
      '?useSSL=false';
    // useSSL=false: the local MySQL instance behind the ngrok tunnel typically has no
    // valid TLS certificate to present. Acceptable only under the mitigations in
    // ARCHITECTURE.md section 3.4 (dedicated low-privilege DB user, strong password,
    // ngrok as the sole entry point). Revisit if MySQL is ever moved to a host that
    // terminates TLS properly (e.g. Cloud SQL).
    //
    // Deliberately NOT included: rewriteBatchedStatements, serverTimezone (and any
    // other MySQL Connector/J-specific property). Apps Script's built-in Jdbc
    // service only accepts a narrow, whitelisted set of connection properties and
    // throws "The following connection properties are unsupported: ..." for
    // anything outside it - confirmed against a live ngrok-tunneled MySQL instance.
    // rewriteBatchedStatements would have been a no-op anyway (nothing here does
    // JDBC batching); time zone handling is independent of this connection string
    // and already goes through APP_TIME_ZONE (Utils.gs) / schema.sql's session-level
    // SET time_zone.
    return Jdbc.getConnection(url, cfg.user, cfg.password);
  }

  function closeConnection(conn) {
    if (conn) {
      try {
        conn.close();
      } catch (e) {
        Logger.log('Error closing connection: ' + e);
      }
    }
  }

  /**
   * Some schema.sql triggers raise SIGNAL SQLSTATE '45000' with a
   * deliberately safe, human-readable business-rule message (e.g. "FMS
   * stages must complete in order") - those messages are tagged with a
   * 'BUSINESS_RULE: ' prefix specifically so this layer can tell them apart
   * from a genuine technical failure (bad SQL, connection drop, etc.) and
   * let the safe ones through to the client instead of collapsing everything
   * into a generic "Database update failed." JDBC drivers append their own
   * formatting around the raw message, so this also trims anything after
   * the sentence itself (a trailing '[...]' or newline).
   */
  function extractBusinessRuleMessage_(rawErrorText) {
    var marker = 'BUSINESS_RULE: ';
    var idx = rawErrorText.indexOf(marker);
    if (idx === -1) { return null; }
    var rest = rawErrorText.substring(idx + marker.length);
    var cutIdx = rest.search(/[\[\n\r]/);
    if (cutIdx > -1) { rest = rest.substring(0, cutIdx); }
    rest = rest.replace(/\.*\s*$/, '.').trim(); // normalize trailing punctuation/whitespace
    return rest.length > 0 ? rest : null;
  }

  /**
   * Re-throws with the 'BUSINESS_RULE: ' marker still attached when the raw
   * driver error contained one, so Utils.gs's withErrorHandling_ - the single
   * place that decides what's safe to show a client - can unwrap it. Any
   * other error becomes the generic, technical-detail-free message.
   */
  function rethrowDatabaseError_(e, genericMessage) {
    var raw = (e && e.message) ? e.message : String(e);
    var businessMessage = extractBusinessRuleMessage_(raw);
    if (businessMessage) { throw new Error('BUSINESS_RULE: ' + businessMessage); }
    throw new Error(genericMessage);
  }

  function bindParams_(stmt, params) {
    if (!params) { return; }
    for (var i = 0; i < params.length; i++) {
      var idx = i + 1;
      var val = params[i];
      if (val === null || typeof val === 'undefined') {
        // Generic NULL. Works for MySQL in practice regardless of target column
        // type; if a specific service method ever needs an explicit SQL type for
        // a NULL (rare), pass Jdbc.Types.<TYPE> through a dedicated bind helper
        // at that call site instead of generalizing this one.
        stmt.setNull(idx, Jdbc.Types.VARCHAR);
      } else if (typeof val === 'number') {
        if (val % 1 === 0) {
          stmt.setInt(idx, val);
        } else {
          stmt.setDouble(idx, val);
        }
      } else if (typeof val === 'boolean') {
        stmt.setBoolean(idx, val);
      } else if (Object.prototype.toString.call(val) === '[object Date]') {
        stmt.setTimestamp(idx, Jdbc.newTimestamp(val.getTime()));
      } else {
        stmt.setString(idx, String(val));
      }
    }
  }

  function resultSetToObjects_(rs) {
    var meta = rs.getMetaData();
    var colCount = meta.getColumnCount();
    var cols = [];
    var c;
    for (c = 1; c <= colCount; c++) {
      cols.push(meta.getColumnLabel(c));
    }
    var rows = [];
    while (rs.next()) {
      var row = {};
      for (c = 0; c < colCount; c++) {
        row[cols[c]] = rs.getObject(c + 1);
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * Every execute* function accepts an optional existingConn as its last
   * argument. Pass one (from inside executeTransaction's callback) to run
   * multiple statements on the same connection/transaction; omit it to get
   * a standalone connection that opens and closes around this one call.
   */
  function executeQuery(sql, params, existingConn) {
    var conn = existingConn || getConnection();
    var shouldClose = !existingConn;
    var stmt = null;
    var rs = null;
    try {
      stmt = conn.prepareStatement(sql);
      bindParams_(stmt, params);
      rs = stmt.executeQuery();
      return resultSetToObjects_(rs);
    } catch (e) {
      Logger.log('executeQuery failed. SQL: ' + sql + ' | Error: ' + e);
      throw new Error('Database query failed.');
    } finally {
      if (rs) { try { rs.close(); } catch (e2) { /* ignore */ } }
      if (stmt) { try { stmt.close(); } catch (e3) { /* ignore */ } }
      if (shouldClose) { closeConnection(conn); }
    }
  }

  function executeUpdate(sql, params, existingConn) {
    var conn = existingConn || getConnection();
    var shouldClose = !existingConn;
    var stmt = null;
    try {
      stmt = conn.prepareStatement(sql);
      bindParams_(stmt, params);
      return stmt.executeUpdate();
    } catch (e) {
      Logger.log('executeUpdate failed. SQL: ' + sql + ' | Error: ' + e);
      rethrowDatabaseError_(e, 'Database update failed.');
    } finally {
      if (stmt) { try { stmt.close(); } catch (e2) { /* ignore */ } }
      if (shouldClose) { closeConnection(conn); }
    }
  }

  function executeInsert(sql, params, existingConn) {
    var conn = existingConn || getConnection();
    var shouldClose = !existingConn;
    var stmt = null;
    var keysRs = null;
    try {
      stmt = conn.prepareStatement(sql, Jdbc.Statement.RETURN_GENERATED_KEYS);
      bindParams_(stmt, params);
      stmt.executeUpdate();
      keysRs = stmt.getGeneratedKeys();
      var newId = null;
      if (keysRs.next()) {
        newId = keysRs.getObject(1);
      }
      return newId;
    } catch (e) {
      Logger.log('executeInsert failed. SQL: ' + sql + ' | Error: ' + e);
      rethrowDatabaseError_(e, 'Database insert failed.');
    } finally {
      if (keysRs) { try { keysRs.close(); } catch (e2) { /* ignore */ } }
      if (stmt) { try { stmt.close(); } catch (e3) { /* ignore */ } }
      if (shouldClose) { closeConnection(conn); }
    }
  }

  /**
   * Runs callback(conn) with autocommit off; commits on success, rolls back
   * and rethrows on any error. Use this for every multi-table write (spec
   * section 24 - e.g. fabric issue -> reduce inventory -> FMS entry -> job
   * card update must all succeed or all roll back together).
   *
   * Usage:
   *   DatabaseService.executeTransaction(function (conn) {
   *     DatabaseService.executeUpdate(sql1, params1, conn);
   *     DatabaseService.executeInsert(sql2, params2, conn);
   *     return something; // becomes executeTransaction's return value
   *   });
   */
  function executeTransaction(callback) {
    var conn = getConnection();
    var result;
    try {
      conn.setAutoCommit(false);
      result = callback(conn);
      conn.commit();
    } catch (e) {
      try {
        conn.rollback();
      } catch (e2) {
        Logger.log('Rollback failed: ' + e2);
      }
      Logger.log('Transaction failed: ' + e);
      closeConnection(conn);
      throw e; // rethrow so the calling Service's withErrorHandling_ wrapper produces the client-facing error response
    }
    closeConnection(conn);
    return result;
  }

  return {
    getConnection: getConnection,
    closeConnection: closeConnection,
    executeQuery: executeQuery,
    executeUpdate: executeUpdate,
    executeInsert: executeInsert,
    executeTransaction: executeTransaction
  };
})();

/**
 * Manual sanity check. Select this function in the Apps Script editor and
 * click Run (after setupScriptProperties_ has been run at least once) to
 * confirm the JDBC connection actually reaches MySQL through the ngrok
 * tunnel before wiring up any real service logic on top of it.
 */
function testDatabaseConnection_() {
  try {
    var rows = DatabaseService.executeQuery('SELECT 1 AS ok, NOW() AS server_time', []);
    Logger.log('DB connection OK: ' + JSON.stringify(rows));
    return rows;
  } catch (e) {
    Logger.log('DB connection FAILED: ' + e);
    throw e;
  }
}