/**
 * AuthService.gs
 * Phase 5 deliverable. Application-level authentication with secure session
 * handling (spec section 1 / 21 / 22).
 *
 * ES5 only.
 *
 * HASHING NOTE (read before deploying): Apps Script has no native bcrypt.
 * A full hand-rolled bcrypt or RFC-2898 PBKDF2-HMAC port is realistic to get
 * subtly wrong and I cannot execute Apps Script in the environment I built
 * this in to verify it end-to-end (unlike schema.sql/seed.sql, which I ran
 * against a real MySQL server before handing them over). Instead this uses
 * salted, iterated SHA-256 (Utilities.computeDigest, native to Apps Script) -
 * a simpler, easier-to-verify-by-inspection construction than a hand-rolled
 * PBKDF2/HMAC chain, still resistant to brute force via the iteration count,
 * but NOT the RFC-2898 PBKDF2 construction (hence the 'iterhash_sha256'
 * prefix, not 'pbkdf2') and not a substitute for bcrypt/Argon2 if you ever
 * add a proper crypto library. schema.sql's password_hash column comment
 * ("bcrypt/PBKDF2") should be read as "whatever this file actually produces."
 *
 * BEFORE TRUSTING THIS: run hashPassword_ + verifyPassword_ round-trip via a
 * test deployment (per your own workflow) - see testAuthRoundTrip_ at the
 * bottom of this file - and confirm login() against a real seeded user
 * before building anything on top of it.
 */

var AuthService = (function () {

  var ITERATIONS = 10000; // starting point - time an actual login in your environment and tune; GAS's Utilities service has real per-call overhead unlike a native crypto library, so don't blindly copy a "10.0.100000 iterations" figure from non-GAS guidance.

  function hashPassword_(plainPassword) {
    var salt = Utilities.getUuid() + Utilities.getUuid();
    var digest = iteratedDigest_(plainPassword, salt, ITERATIONS);
    return 'iterhash_sha256$' + ITERATIONS + '$' + salt + '$' + bytesToHex_(digest);
  }

  function verifyPassword_(plainPassword, storedHash) {
    if (!isNonEmptyString_(storedHash)) { return false; }
    var parts = storedHash.split('$');
    if (parts.length !== 4 || parts[0] !== 'iterhash_sha256') { return false; }
    var iterations = parseInt(parts[1], 10);
    var salt = parts[2];
    var expectedHex = parts[3];
    if (!iterations || iterations < 1) { return false; }
    var actualHex = bytesToHex_(iteratedDigest_(plainPassword, salt, iterations));
    return constantTimeEquals_(actualHex, expectedHex);
  }

  function iteratedDigest_(password, salt, iterations) {
    var seed = salt + '$' + password;
    var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
    for (var i = 1; i < iterations; i++) {
      digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digestBytes);
    }
    return digestBytes;
  }

  function bytesToHex_(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 0) { b += 256; } // Apps Script byte arrays are signed (-128..127); normalize to 0..255
      var h = b.toString(16);
      if (h.length === 1) { h = '0' + h; }
      hex += h;
    }
    return hex;
  }

  function constantTimeEquals_(a, b) {
    if (a.length !== b.length) { return false; }
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    }
    return diff === 0;
  }

  function login(username, plainPassword) {
    if (!isNonEmptyString_(username) || !isNonEmptyString_(plainPassword)) {
      return errorResponse_('Username and password are required.');
    }

    var rows = DatabaseService.executeQuery(
      'SELECT user_id, username, password_hash, full_name, email, role_id, is_active FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    if (rows.length === 0) {
      return errorResponse_('Invalid username or password.');
    }
    var user = rows[0];
    if (Number(user.is_active) !== 1) {
      return errorResponse_('This account is inactive. Contact your administrator.');
    }
    if (!verifyPassword_(plainPassword, user.password_hash)) {
      return errorResponse_('Invalid username or password.');
    }

    var sessionId = generateSessionToken_();
    var appCfg = getAppConfig_();
    var expiresAt = new Date(Date.now() + appCfg.sessionDurationHours * 60 * 60 * 1000);

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeInsert(
        'INSERT INTO user_sessions (session_id, user_id, expires_at, is_valid) VALUES (?, ?, ?, 1)',
        [sessionId, user.user_id, formatDateTimeForMySQL_(expiresAt)],
        conn
      );
      DatabaseService.executeUpdate(
        'UPDATE users SET last_login_at = NOW() WHERE user_id = ?',
        [user.user_id],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id) VALUES (?, 'Login', 'Auth', ?)",
        [user.user_id, String(user.user_id)],
        conn
      );
      return null;
    });

    return successResponse_({
      sessionId: sessionId,
      user: {
        userId: user.user_id,
        username: user.username,
        fullName: user.full_name,
        roleId: user.role_id
      }
    }, 'Login successful.');
  }

  function logout(sessionId) {
    if (!isNonEmptyString_(sessionId)) {
      return errorResponse_('No active session.');
    }
    var rows = DatabaseService.executeQuery(
      'SELECT user_id FROM user_sessions WHERE session_id = ? LIMIT 1',
      [sessionId]
    );
    DatabaseService.executeUpdate(
      'UPDATE user_sessions SET is_valid = 0 WHERE session_id = ?',
      [sessionId]
    );
    if (rows.length > 0) {
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id) VALUES (?, 'Logout', 'Auth', ?)",
        [rows[0].user_id, String(rows[0].user_id)]
      );
    }
    return successResponse_(null, 'Logged out.');
  }

  /**
   * Internal guard used by every other Service's public functions (from
   * Phase 6 onward) - NOT wrapped in the {success,...} envelope, since
   * callers need a plain user object or null, e.g.:
   *   var user = AuthService.validateSession(sessionId);
   *   if (!user) { return errorResponse_('Session expired. Please log in again.'); }
   */
  function validateSession(sessionId) {
    if (!isNonEmptyString_(sessionId)) { return null; }
    var rows = DatabaseService.executeQuery(
      'SELECT s.user_id, s.expires_at, s.is_valid, u.username, u.full_name, u.role_id, u.is_active ' +
      'FROM user_sessions s JOIN users u ON u.user_id = s.user_id ' +
      'WHERE s.session_id = ? LIMIT 1',
      [sessionId]
    );
    if (rows.length === 0) { return null; }
    var row = rows[0];
    if (Number(row.is_valid) !== 1 || Number(row.is_active) !== 1) { return null; }
    var expiresAt = parseMySQLTimestamp_(row.expires_at);
    if (!expiresAt || expiresAt.getTime() < Date.now()) { return null; }
    return {
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      roleId: row.role_id
    };
  }

  /**
   * Server-side permission check (spec section 21: "Permissions must be
   * checked server-side"). Every mutating public function in every
   * *Service.gs file, from JobCardService.gs onward, should call this right
   * after validateSession, e.g.:
   *   var user = AuthService.validateSession(sessionId);
   *   if (!user) { return errorResponse_('Session expired. Please log in again.'); }
   *   if (!AuthService.hasPermission(user.userId, 'jobcard.edit')) {
   *     return errorResponse_('You do not have permission to perform this action.');
   *   }
   * permissionKey values are the ones seeded in seed.sql's permissions table
   * (e.g. 'jobcard.view', 'jobcard.edit', 'fms.edit', 'inventory.edit', ...).
   */
  function hasPermission(userId, permissionKey) {
    if (!userId || !isNonEmptyString_(permissionKey)) { return false; }
    var rows = DatabaseService.executeQuery(
      'SELECT COUNT(*) AS cnt FROM role_permissions rp ' +
      'JOIN users u ON u.role_id = rp.role_id ' +
      'JOIN permissions p ON p.permission_id = rp.permission_id ' +
      'WHERE u.user_id = ? AND p.permission_key = ? AND u.is_active = 1',
      [userId, permissionKey]
    );
    return rows.length > 0 && Number(rows[0].cnt) > 0;
  }

  return {
    // Client-facing entry points (called via google.script.run from Login.html, Phase 6+)
    login: withErrorHandling_(login),
    logout: withErrorHandling_(logout),
    // Internal, used by every other Service - not wrapped, not called directly from the client
    validateSession: validateSession,
    hasPermission: hasPermission,
    // Exposed so the bootstrap helpers below (and any future admin tooling, e.g. a
    // "change password" flow that must re-check the old password) can call these directly
    hashPassword: hashPassword_,
    verifyPassword: verifyPassword_
  };
})();

/**
 * ONE-TIME BOOTSTRAP. seed.sql's users all have placeholder password_hash
 * values ('$2y$10$REPLACE_WITH_REAL_BCRYPT_HASH...') that will never verify
 * against anything. Run this manually from the Apps Script editor, once per
 * user, to set a real password:
 *
 *   setUserPassword_('admin', 'choose-a-real-password-here');
 *
 * Do not leave a real password typed into this file after running it -
 * type it into the Execution log / editor, run once, then clear it.
 */
function setUserPassword_(username, newPlainPassword) {
  if (!isNonEmptyString_(username) || !isNonEmptyString_(newPlainPassword)) {
    throw new Error('setUserPassword_ requires a username and a new password.');
  }
  var hash = AuthService.hashPassword(newPlainPassword);
  var count = DatabaseService.executeUpdate(
    'UPDATE users SET password_hash = ? WHERE username = ?',
    [hash, username]
  );
  Logger.log(count + ' row(s) updated for username=' + username);
  return count;
}

/**
 * Manual round-trip check. Run from the editor after setupScriptProperties_
 * and testDatabaseConnection_ both succeed, and BEFORE relying on login().
 * Confirms hashPassword_/verifyPassword_ agree with each other in your
 * actual Apps Script runtime (see the hashing note at the top of this file
 * for why this matters here specifically).
 */
function testAuthRoundTrip_() {
  var plain = 'Test@12345';
  var hash = AuthService.hashPassword(plain);
  Logger.log('Generated hash: ' + hash);

  var matchesCorrect = AuthService.verifyPassword(plain, hash);
  var matchesWrong = AuthService.verifyPassword('WrongPassword', hash);
  Logger.log('Correct password verifies true: ' + matchesCorrect);
  Logger.log('Wrong password verifies false: ' + (matchesWrong === false));

  if (matchesCorrect !== true || matchesWrong !== false) {
    throw new Error('Auth round-trip test FAILED - do not trust login() until this passes. See hashing note at the top of this file.');
  }
  Logger.log('Auth round-trip test PASSED.');
}
