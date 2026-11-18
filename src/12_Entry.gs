// 12_Entry.gs — نقطة الدخول الوحيدة api(request)، النشر، التثبيت، والترحيل.
var ACTION_HANDLERS_ = {
  ping: function () { return ping_(); },
  publicConfig: function () { return publicConfig_(); },
  login: login_,
  loginCard: loginCard_,
  loginGoogle: loginGoogle_,
  bootstrap: function (ctx) { return bootstrapData_(ctx.account); },
  logout: logout_,
  changePassword: changePassword_,
  getDay: getDay_,
  scanStudent: scanStudent_,
  closeDay: closeDay_,
  correctAttendance: correctAttendance_,
  getStudents: getStudents_,
  saveStudent: saveStudent_,
  importStudents: importStudents_,
  getDriverAdminData: getDriverAdminData_,
  saveDriver: saveDriver_,
  deleteDriver: deleteDriver_,
  issueCard: issueCard_,
  revokeCard: revokeCard_,
  getCards: getCards_,
  openTrip: openTrip_,
  addTripStudent: addTripStudent_,
  scanTrip: scanTrip_,
  unscanTrip: unscanTrip_,
  confirmTrip: confirmTrip_,
  cancelTrip: cancelTrip_,
  getTrips: getTrips_,
  getTrip: getTrip_,
  getReport: getReport_,
  getSettings: getSettings_,
  saveSettings: saveSettings_,
  getDatabaseStatus: getDatabaseStatus_,
  getUsers: getUsers_,
  saveUser: saveUser_,
  getAudit: getAudit_,
  createBackup: createBackup_,
  getBackupStatus: getBackupStatus_,
  previewRestore: previewRestore_,
  restoreBackup: restoreBackup_,
  runRetention: runRetention_
};

function runIdempotent_(ctx, runner, payload) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(ctx.requestId)) {
    fail_('BAD_REQUEST', 'معرّف الطلب (requestId) مطلوب لهذه العملية.');
  }
  var cache = CacheService.getScriptCache();
  var key = 'IDEM_' + sha256_(ctx.account.id + '|' + ctx.action + '|' + ctx.requestId).slice(0, 40);
  function cachedResult() {
    var cached = cache.get(key);
    return cached ? parseJson_(cached, null) : null;
  }
  var early = cachedResult();
  if (early) return early;
  return withLock_(function () {
    var inside = cachedResult();
    if (inside) return inside;
    var result = runner(ctx, payload);
    try { cache.put(key, JSON.stringify(result), IDEMPOTENCY_TTL_); } catch (ignored) { /* النتيجة وصلت؛ التخزين تحسين */ }
    return result;
  });
}

function api(request) {
  var started = Date.now();
  var requestId = request && typeof request.requestId === 'string' ? request.requestId.slice(0, 64) : '';
  var action = request && request.action;
  var ctx = { action: action, requestId: requestId, account: null, user: null, requestToken: request && request.token };
  try {
    if (!request || typeof request !== 'object' || typeof action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{1,39}$/.test(action)) {
      fail_('BAD_REQUEST', ERROR_MESSAGES_.BAD_REQUEST);
    }
    if (!Object.prototype.hasOwnProperty.call(ACTION_POLICY_, action)) {
      fail_('UNKNOWN_ACTION', ERROR_MESSAGES_.UNKNOWN_ACTION);
    }
    var policy = ACTION_POLICY_[action];
    var payload = request.payload === undefined || request.payload === null ? {} : request.payload;
    if (!isPlainObject_(payload)) fail_('BAD_REQUEST', ERROR_MESSAGES_.BAD_REQUEST);
    if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS_) fail_('PAYLOAD_TOO_LARGE', ERROR_MESSAGES_.PAYLOAD_TOO_LARGE);
    if (!policy.public) {
      ctx.account = sessionAccount_(request.token);
      ctx.user = publicAccount_(ctx.account);
      if (!policy.allowForcedPasswordChange && ctx.account.mustChange) {
        fail_('PASSWORD_CHANGE_REQUIRED', ERROR_MESSAGES_.PASSWORD_CHANGE_REQUIRED);
      }
      if (policy.permission && permissionsFor_(ctx.account).indexOf(policy.permission) < 0) {
        fail_('PERMISSION_DENIED', ERROR_MESSAGES_.PERMISSION_DENIED);
      }
    }
    AUTH_CONTEXT_ = ctx;
    var handler = ACTION_HANDLERS_[action];
    if (typeof handler !== 'function') fail_('UNKNOWN_ACTION', ERROR_MESSAGES_.UNKNOWN_ACTION);
    var data;
    if (policy.idempotent) data = runIdempotent_(ctx, handler, payload);
    else if (policy.lock) data = withLock_(function () { return handler(ctx, payload); });
    else data = handler(ctx, payload);
    log_('INFO', 'api_ok', {
      action: action, request_id: requestId, duration_ms: Date.now() - started,
      user_id: ctx.account ? ctx.account.id : '', count: payloadCount_(payload)
    });
    return envelope_(true, 'SUCCESS', 'تمت العملية.', data, requestId);
  } catch (error) {
    var safe = safeError_(error);
    log_(safe.code === 'INTERNAL' ? 'ERROR' : 'WARN', 'api_fail', {
      action: action, code: safe.code, request_id: requestId,
      duration_ms: Date.now() - started, user_id: ctx.account ? ctx.account.id : ''
    });
    return envelope_(false, safe.code, safe.message, safe.details, requestId);
  } finally {
    AUTH_CONTEXT_ = null;
  }
}

function payloadCount_(payload) {
  if (!payload) return 0;
  if (Array.isArray(payload.rows)) return payload.rows.length;
  return 1;
}

function doGet() {
  var settings = readSettings_();
  var config = publicConfig_();
  var template = HtmlService.createTemplateFromFile('Index');
  template.configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  return template.evaluate()
    .setTitle(settings.systemName || 'نظام الحضور والانصراف')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------- التثبيت والترحيل (محرر فقط، محمي بهوية المالك) ----------
function ownerIdentity_() {
  var owner = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL') || '').toLowerCase();
  var active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!owner || !active || active !== effective || effective !== owner) {
    fail_('PERMISSION_DENIED', 'شغّل هذه الدالة من محرر المشروع بحساب مالك النظام.');
  }
}

function ensureTriggers_() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'maintenance_';
  });
  if (!exists) ScriptApp.newTrigger('maintenance_').timeBased().everyMinutes(10).create();
}

function installSchool() {
  var active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== effective) fail_('PERMISSION_DENIED', 'شغّل التثبيت من المحرر بحساب مالك المشروع.');
  var props = PropertiesService.getScriptProperties();
  var book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) fail_('VALIDATION', 'ابدأ من جدول Google Sheets: إضافات ← Apps Script.');
  var current = props.getProperty('DB_ID');
  if (current) {
    if (props.getProperty('ADMIN_EMAIL') !== active) fail_('PERMISSION_DENIED', 'هذا النظام يخص مالكًا آخر.');
    if (current !== book.getId()) fail_('PERMISSION_DENIED', 'المشروع مربوط بملف مختلف.');
    var report = ensureSchema_();
    var account = initializeAccounts_();
    ensureTriggers_();
    return { existing: true, schema: report, account: account, url: book.getUrl() };
  }
  if (book.getSheets().some(function (sheet) { return sheet.getLastRow() > 0; })) {
    fail_('VALIDATION', 'استخدم جدولًا فارغًا للتثبيت الأول. لا تشغّل التثبيت على بيانات قائمة.');
  }
  var sheets = book.getSheets();
  if (sheets.length === 1 && sheets[0].getLastRow() === 0) sheets[0].setName('Students');
  Object.keys(TABLES_).forEach(function (name) {
    var sheet = book.getSheetByName(name) || book.insertSheet(name);
    sheet.getRange(1, 1, 1, TABLES_[name].length).setValues([TABLES_[name]])
      .setBackground('#173F5F').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    sheet.setRightToLeft(true);
  });
  book.setSpreadsheetTimeZone(TIMEZONE_);
  props.setProperties({
    DB_ID: book.getId(),
    ADMIN_EMAIL: active,
    INSTALL_VERSION: '6',
    SCHEMA_VERSION: '6',
    SETTINGS: JSON.stringify(defaultSettings_())
  });
  var account = initializeAccounts_();
  ensureTriggers_();
  return { existing: false, account: account, url: book.getUrl() };
}

// آمن للتكرار: يضيف الأعمدة والأوراق، يحوّل رموز الطلاب القائمة إلى بصمات، ولا يحذف أي سجل.
function migrateV36() {
  ownerIdentity_();
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('AUTH_SECRET')) props.setProperty('AUTH_SECRET', uuid_() + uuid_() + uuid_());
    var report = ensureSchema_();
    var students = readTable_('Students');
    var cards = readTable_('Cards');
    var existingHashes = {};
    cards.forEach(function (card) { existingHashes[card.token_hash] = true; });
    var migrated = 0, skipped = 0, cleared = 0;
    students.forEach(function (student) {
      var token = String(student.token || '').trim();
      if (!token) return;
      var hash = tokenHash_(token);
      if (existingHashes[hash]) { skipped += 1; }
      else {
        appendRows_('Cards', [{
          card_id: uuid_(), type: 'STUDENT', owner_id: student.id, token_hash: hash,
          status: 'ACTIVE', issued_at: stamp_(), issued_by: 'migrateV36',
          revoked_at: '', revoked_by: '', last_used_at: '', note: 'مرحّلة من 3.5'
        }]);
        existingHashes[hash] = true;
        migrated += 1;
      }
      updateRow_('Students', student._row, Object.assign({}, student, { token: '' }));
      cleared += 1;
    });
    var trips = readTable_('Journeys');
    var tripsUpdated = 0;
    trips.forEach(function (trip) {
      if (trip.status) return;
      var items = parseJson_(trip.items, []);
      if (Array.isArray(items)) {
        trip.items = JSON.stringify(items.map(function (item) {
          var state = item && item.state;
          if (['pending', 'scanned', 'guardian', 'absent'].indexOf(state) < 0) {
            var choice = String((item && item.choice) || 'pending');
            state = choice === 'driver' ? 'scanned' : choice === 'parent' ? 'guardian' :
              choice === 'absent' ? 'absent' : 'pending';
          }
          return {
            id: item && item.id, name: (item && item.name) || (item && item.id) || '',
            classroom: (item && item.classroom) || '', state: state,
            method: (item && item.method) || (state === 'scanned' ? 'driver' : state === 'guardian' ? 'guardian' : ''),
            at: (item && item.at) || trip.at || ''
          };
        }));
      }
      updateRow_('Journeys', trip._row, Object.assign({}, trip, {
        status: TRIP_CONFIRMED_, confirmedAt: trip.confirmedAt || trip.at || '',
        confirmedBy: trip.confirmedBy || trip.operator || '', appliedAt: trip.appliedAt || trip.at || ''
      }));
      tripsUpdated += 1;
    });
    if (!props.getProperty('AUTH_SECRET')) props.setProperty('AUTH_SECRET', uuid_() + uuid_() + uuid_());
    if (!props.getProperty('AUTH_SCHEMA')) initializeAccounts_();
    props.setProperty('SCHEMA_VERSION', '6');
    props.setProperty('INSTALL_VERSION', '6');
    ensureTriggers_();
    audit_({ account: { username: 'migrateV36' }, requestId: '' }, 'ترحيل المخطط إلى 3.6', {
      targetType: 'system',
      details: 'بطاقات مرحّلة: ' + migrated + ' | مكررة: ' + skipped + ' | رحلات مؤرشفة: ' + tripsUpdated,
      after: { schema: report, cardsCreated: migrated, tripsUpdated: tripsUpdated }
    });
    return {
      schema: report, cardsCreated: migrated, duplicateTokens: skipped,
      tokensCleared: cleared, tripsArchived: tripsUpdated,
      note: 'الطلاب الذين لا يملكون بطاقة سابقة يمكن إصدار بطاقة جديدة لهم من شاشة الطلاب.'
    };
  });
}

function recoverSupervisor() {
  ownerIdentity_();
  return withLock_(function () { return recoverSupervisorPassword_(); });
}

function runMaintenanceNow() {
  ownerIdentity_();
  return maintenance_();
}

// ---------- الصيانة الدورية ----------
function maintenance_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('DB_ID')) return { skipped: 'no_database' };
  var effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!effective || effective !== String(props.getProperty('ADMIN_EMAIL') || '').toLowerCase()) {
    return { skipped: 'not_owner' };
  }
  return withLock_(function () {
    var settings = readSettings_();
    var date = today_();
    var now = Utilities.formatDate(new Date(), TIMEZONE_, 'HH:mm');
    var result = { closed: false, backup: false, cancelledTrips: 0 };
    try {
      if (settings.autoClose && schoolDay_(date, settings) && now >= settings.closeTime) {
        var day = readTable_('Days').filter(function (item) { return item.date === date; })[0];
        if (!day) day = ensureDay_('النظام التلقائي').day;
        if (day && !day.closed) {
          closeDay_({ account: { username: 'النظام التلقائي', id: '' }, requestId: '' });
          result.closed = true;
        }
      }
      props.deleteProperty('MAINTENANCE_ERROR');
    } catch (error) {
      props.setProperty('MAINTENANCE_ERROR', stamp_() + ' ' + (error && error.message ? error.message : ''));
      log_('ERROR', 'auto_close_failed', { code: error && error.code ? error.code : 'INTERNAL' });
    }
    try {
      result.cancelledTrips = expireStaleTrips_('النظام التلقائي');
      cleanSessions_();
    } catch (error) {
      log_('WARN', 'maintenance_cleanup_failed', { code: error && error.code ? error.code : 'INTERNAL' });
    }
    if (settings.autoBackup && now >= settings.backupTime &&
        String(props.getProperty('LAST_BACKUP') || '').slice(0, 10) !== date) {
      try {
        createBackup_({ account: { username: 'النظام التلقائي', id: '' }, requestId: '' });
        result.backup = true;
      } catch (error) {
        props.setProperty('BACKUP_ERROR', stamp_() + ' ' + (error && error.message ? error.message : ''));
        log_('ERROR', 'auto_backup_failed', { code: error && error.code ? error.code : 'INTERNAL' });
      }
    }
    return result;
  });
}
