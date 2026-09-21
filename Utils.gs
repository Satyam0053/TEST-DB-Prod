/**
 * Utils.gs
 * Phase 4 deliverable. Shared helpers used by every other *Service.gs file.
 *
 * ES5 only (per project convention): no let/const, no arrow functions, no
 * template literals, no destructuring, no Object.keys/Object.values.
 */

// ---------------------------------------------------------------------------
// Structured response shape (spec section 28)
// ---------------------------------------------------------------------------

function successResponse_(data, message) {
  return {
    success: true,
    data: (typeof data === 'undefined') ? null : data,
    message: message || 'Operation completed successfully'
  };
}

function errorResponse_(message) {
  return {
    success: false,
    data: null,
    message: message || 'Unable to complete operation'
  };
}

/**
 * Wraps a Service function that is exposed to the client via google.script.run.
 * The wrapped function is expected to return successResponse_(...) on its own
 * happy path; this wrapper only catches thrown errors (from DatabaseService,
 * validation, etc.) and converts them into the safe client-facing envelope,
 * logging the real technical detail server-side instead of exposing it
 * (spec section 28: never expose SQL credentials or stack traces to users).
 *
 * A thrown Error whose message starts with the 'BUSINESS_RULE: ' marker is
 * a deliberately safe, human-readable message - either passed through from
 * a schema.sql trigger via Database.gs's rethrowDatabaseError_, or thrown
 * directly by a Service (e.g. InventoryService's negative-stock guard) -
 * and is shown to the client with the marker stripped. Every other error is
 * a genuine technical failure and is collapsed into the generic message so
 * nothing sensitive (SQL, stack traces, connection strings) ever reaches
 * the client. This is the ONE place that decides safe-to-show vs not - any
 * BUSINESS_RULE: throw anywhere downstream relies on being unwrapped here.
 */
function withErrorHandling_(fn) {
  var BUSINESS_RULE_MARKER = 'BUSINESS_RULE: ';
  return function () {
    var args = Array.prototype.slice.call(arguments);
    try {
      return fn.apply(null, args);
    } catch (e) {
      var raw = (e && e.message) ? e.message : String(e);
      Logger.log('Handled error in ' + (fn.name || 'anonymous') + ': ' + (e && e.stack ? e.stack : e));
      if (raw.indexOf(BUSINESS_RULE_MARKER) === 0) {
        return errorResponse_(raw.substring(BUSINESS_RULE_MARKER.length));
      }
      return errorResponse_('Something went wrong. Please try again or contact your administrator.');
    }
  };
}

// ---------------------------------------------------------------------------
// Date/time helpers - everything pinned to Asia/Kolkata (IST), per
// ARCHITECTURE.md section 4's time-zone-consistency note.
// ---------------------------------------------------------------------------

var APP_TIME_ZONE = 'Asia/Kolkata';

function formatDateTimeForMySQL_(dateObj) {
  return Utilities.formatDate(dateObj, APP_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
}

function formatDateForMySQL_(dateObj) {
  return Utilities.formatDate(dateObj, APP_TIME_ZONE, 'yyyy-MM-dd');
}

/**
 * MySQL returns DATETIME/TIMESTAMP values as 'yyyy-MM-dd HH:mm:ss' strings
 * (or occasionally as a native object, depending on the JDBC driver's exact
 * marshaling - this normalizes either case). JS's Date constructor does not
 * reliably parse a space-separated datetime string across all engines, so
 * the space is swapped for 'T' first.
 */
function parseMySQLTimestamp_(value) {
  if (value === null || typeof value === 'undefined') { return null; }
  if (Object.prototype.toString.call(value) === '[object Date]') { return value; }
  var str = String(value).replace(' ', 'T');
  return new Date(str);
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isNonEmptyString_(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInteger_(v) {
  return typeof v === 'number' && (v % 1 === 0) && v > 0;
}

function isValidEnum_(v, allowedValues) {
  for (var i = 0; i < allowedValues.length; i++) {
    if (allowedValues[i] === v) { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function generateSessionToken_() {
  var raw = Utilities.getUuid() + Utilities.getUuid();
  return raw.replace(/-/g, '').substring(0, 64);
}
