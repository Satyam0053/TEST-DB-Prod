var PAGES_ = { login:'Login', dashboard:'Dashboard', jobcards:'JobCards', fms:'FMS', production:'Production', inventory:'Inventory', artwork:'Artwork', quality:'Quality', delivery:'Delivery', purchase:'Purchase', users:'Users', reports:'Reports' };

function doGet(e) {
  var rawPage = e && e.parameter ? e.parameter.page : null;
  var page = typeof rawPage === 'string' ? rawPage.toLowerCase() : 'login';
  var fileName = PAGES_[page] || PAGES_.login;
  try {
    return HtmlService.createTemplateFromFile(fileName).evaluate().setTitle('Garment ERP').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    Logger.log('Page load failed for ' + fileName + ': ' + (err && err.stack ? err.stack : err));
    return HtmlService.createHtmlOutput('<!doctype html><html><body style="font-family:Arial;padding:24px;color:#991b1b"><h3>Page could not be loaded</h3><p>Please reload the application. If the problem continues, contact the administrator.</p></body></html>');
  }
}
function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }
