/**
 * Code.gs
 * Phase 16 deliverable. Web app entry point: doGet(e) routing and the
 * include(filename) helper every HTML file uses to pull in the shared
 * CSS/JS/Components partials (spec section 26 - single web app, client-side
 * page routing via a ?page= query param rather than 12 separate
 * deployments).
 *
 * ES5 only.
 *
 * Auth is NOT enforced here - doGet has no reliable notion of "logged in"
 * (no server-side session cookie; the session id lives in the browser's
 * localStorage, set by Login.html after AuthService.login() succeeds - see
 * JS.html's requireAuth()). Every module page other than Login.html calls
 * requireAuth() itself on load and redirects to ?page=login if there's no
 * valid session, and every *Service.gs function independently re-validates
 * the sessionId server-side before doing anything (spec section 21/22) - so
 * a client that skips the redirect still can't read or write anything.
 */

var PAGES_ = {
  login: 'Login',
  dashboard: 'Dashboard',
  jobcards: 'JobCards',
  fms: 'FMS',
  production: 'Production',
  inventory: 'Inventory',
  artwork: 'Artwork',
  quality: 'Quality',
  delivery: 'Delivery',
  purchase: 'Purchase',
  users: 'Users',
  reports: 'Reports'
};

function doGet(e) {
  var requestedPage = (e && e.parameter && e.parameter.page) ? String(e.parameter.page).toLowerCase() : 'login';
  var fileName = PAGES_.hasOwnProperty(requestedPage) ? PAGES_[requestedPage] : PAGES_.login;

  var template = HtmlService.createTemplateFromFile(fileName);
  return template.evaluate()
    .setTitle('Garment Manufacturing ERP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setFaviconUrl('https://www.google.com/images/icons/product/sheets-32.png')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Used from every page template as <?!= include('CSS'); ?> etc. Returns raw
 * file content - note this does NOT recursively evaluate <?!= ?> scriptlet
 * tags inside the included file (a well-known HtmlService limitation), so
 * CSS.html/JS.html/Components.html are plain static HTML/CSS/JS with no
 * server-side templating of their own; only each top-level module page
 * (Login.html, Dashboard.html, ...) is evaluated as a template.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function debugLoginCheck_() {
  try {
    var cfg = getDbConfig_();
    Logger.log('Script Properties OK. HOST=' + cfg.host + ' PORT=' + cfg.port + ' NAME=' + cfg.name + ' USER=' + cfg.user);
  } catch (e) {
    Logger.log('FAILED reading Script Properties: ' + e.message);
    return;
  }

  try {
    var rows = DatabaseService.executeQuery(
      'SELECT user_id, username, password_hash, is_active FROM users WHERE username = ?',
      ['admin']
    );
    Logger.log('DB connection OK. Row count for username=admin: ' + rows.length);
    if (rows.length > 0) {
      Logger.log('admin row -> is_active=' + rows[0].is_active + ', hash starts with: ' + String(rows[0].password_hash).substring(0, 25));
    } else {
      Logger.log('No admin row found - seed.sql (with the fixed hash) has not been run against THIS database yet.');
    }
  } catch (e) {
    Logger.log('FAILED connecting to / querying the database: ' + e.message);
    return;
  }

  var knownHash = 'iterhash_sha256$10000$01607bd1-2c08-4d36-b4eb-b8827c119244b7888428-cdb1-47ec-b404-3f8eb07ef6e6$8a108105793a492b952a5a69d7bb857de84b31424ff5db9d93f4c73e19ef2513';
  Logger.log('Self-check verifyPassword("Admin@123", knownHash) = ' + AuthService.verifyPassword('Admin@123', knownHash));
}
