/** Database configuration is read only from Script Properties. */
function getDbConfig_() {
  var props = PropertiesService.getScriptProperties();
  var cfg = { host: props.getProperty('DB_HOST'), port: props.getProperty('DB_PORT'), name: props.getProperty('DB_NAME'), user: props.getProperty('DB_USER'), password: props.getProperty('DB_PASSWORD'), jdbcPrefix: props.getProperty('JDBC_PREFIX') || 'jdbc:mysql://' };
  var missing = [];
  if (!cfg.host) { missing.push('DB_HOST'); }
  if (!cfg.port) { missing.push('DB_PORT'); }
  if (!cfg.name) { missing.push('DB_NAME'); }
  if (!cfg.user) { missing.push('DB_USER'); }
  if (!cfg.password) { missing.push('DB_PASSWORD'); }
  if (missing.length) { throw new Error('Missing required Script Properties: ' + missing.join(', ') + '. Configure them under Project Settings > Script Properties.'); }
  return cfg;
}
function getAppConfig_() { return { timeZone: APP_TIME_ZONE, sessionDurationHours: 12, appName: 'Garment Manufacturing ERP + FMS' }; }
/** Run once only after replacing placeholders locally; never commit real credentials. */
function setupScriptProperties_() {
  throw new Error('Configure DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD in Project Settings > Script Properties. Credentials are intentionally not stored in source code.');
}
