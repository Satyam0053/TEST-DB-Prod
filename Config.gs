/**
 * Config.gs
 * Phase 4 deliverable. The ONLY place database configuration is read from.
 * Never hardcode DB_HOST/DB_PORT/DB_USER/DB_PASSWORD anywhere else in this
 * project (spec section 22 / rule 2).
 *
 * ES5 only, per project convention.
 */

/**
 * Reads DB connection config from Script Properties (Project Settings >
 * Script Properties, or set programmatically once via setupScriptProperties_
 * below). Throws a clear error naming exactly which keys are missing, rather
 * than failing deep inside a JDBC call with a confusing message.
 */
function getDbConfig_() {
  var props = PropertiesService.getScriptProperties();
  var cfg = {
    host: props.getProperty('DB_HOST'),
    port: props.getProperty('DB_PORT'),
    name: props.getProperty('DB_NAME'),
    user: props.getProperty('DB_USER'),
    password: props.getProperty('DB_PASSWORD'),
    jdbcPrefix: props.getProperty('JDBC_PREFIX') || 'jdbc:mysql://'
  };

  var missing = [];
  if (!cfg.host) { missing.push('DB_HOST'); }
  if (!cfg.port) { missing.push('DB_PORT'); }
  if (!cfg.name) { missing.push('DB_NAME'); }
  if (!cfg.user) { missing.push('DB_USER'); }
  if (!cfg.password) { missing.push('DB_PASSWORD'); }

  if (missing.length > 0) {
    throw new Error(
      'Missing required Script Properties: ' + missing.join(', ') +
      '. Run setupScriptProperties_() once from the Apps Script editor (see the ' +
      'comment above it in this file), or set them manually under Project Settings > Script Properties.'
    );
  }

  return cfg;
}

function getAppConfig_() {
  return {
    timeZone: APP_TIME_ZONE, // defined in Utils.gs
    sessionDurationHours: 12,
    appName: 'Garment Manufacturing ERP + FMS'
  };
}

/**
 * ONE-TIME SETUP ONLY. Do not leave real credentials in this file.
 *
 * How to use:
 *   1. Temporarily replace the placeholder strings below with your real
 *      DB_HOST / DB_PORT (your current ngrok TCP address - see
 *      ARCHITECTURE.md section 3.3 for why these change on tunnel restart)
 *      and your real DB_USER / DB_PASSWORD (the dedicated gas_app_user
 *      credentials, never root - see ARCHITECTURE.md section 3.4).
 *   2. In the Apps Script editor, select "setupScriptProperties_" from the
 *      function dropdown and click Run.
 *   3. Immediately replace the real values below with the placeholders again
 *      and save. The real values now live only in Script Properties, not in
 *      source - which is the entire point (spec rule 2: never expose DB
 *      credentials; rule about never hardcoding passwords into source files).
 *   4. Whenever the ngrok tunnel restarts and DB_HOST/DB_PORT change, either
 *      re-run this function with the new values, or update them directly
 *      under Project Settings > Script Properties (no redeploy needed either
 *      way - Script Properties changes take effect immediately).
 */
function setupScriptProperties_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperties({
    'DB_HOST': 'REPLACE_WITH_NGROK_HOST',
    'DB_PORT': 'REPLACE_WITH_NGROK_PORT',
    'DB_NAME': 'garment_erp',
    'DB_USER': 'REPLACE_WITH_DB_USER',
    'DB_PASSWORD': 'REPLACE_WITH_DB_PASSWORD',
    'JDBC_PREFIX': 'jdbc:mysql://'
  }, false);
  Logger.log('Script Properties saved. Now go delete the real values above and re-save this file.');
}
