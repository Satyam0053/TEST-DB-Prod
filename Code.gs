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
  var page = (e && e.parameter && e.parameter.page) ? e.parameter.page.toLowerCase() : 'login';
  var fileName = PAGES_[page] || PAGES_['login'];
  
  try {
    var template = HtmlService.createTemplateFromFile(fileName);
    return template.evaluate()
      .setTitle('Garment ERP')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput('<h3>Page Load Error:</h3><pre>' + err.message + '\n' + err.stack + '</pre>');
  }
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
