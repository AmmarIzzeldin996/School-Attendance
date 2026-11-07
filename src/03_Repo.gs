// 03_Repo.gs — المحول الوحيد إلى Google Sheets: قراءة/كتابة دفعية، قفل، تحقق من المخطط.
var LOCK_DEPTH_ = 0;
var ROW_CACHE_ = Object.create(null);
var DB_CACHE_ = null;
var DB_CACHE_ID_ = '';

function db_() {
  var id = String(PropertiesService.getScriptProperties().getProperty('DB_ID') || '').trim();
  if (!id) fail_('SCHEMA_NOT_READY', 'لم يُربط النظام بجدول. شغّل installSchool من محرر المشروع أولًا.');
  if (!DB_CACHE_ || DB_CACHE_ID_ !== id) {
    DB_CACHE_ = SpreadsheetApp.openById(id);
    DB_CACHE_ID_ = id;
  }
  return DB_CACHE_;
}

function clearCache_() {
  ROW_CACHE_ = Object.create(null);
}

function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  var started = Date.now();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS_);
  } catch (error) {
    fail_('BUSY', ERROR_MESSAGES_.BUSY);
  }
  var waited = Date.now() - started;
  if (waited > 3000) log_('WARN', 'slow_lock', { lock_wait_ms: waited });
  LOCK_DEPTH_ += 1;
  clearCache_();
  try {
    return fn();
  } finally {
    LOCK_DEPTH_ -= 1;
    clearCache_();
    try { SpreadsheetApp.flush(); } catch (ignored) { /* mock أو بيئة بلا flush */ }
    try { lock.releaseLock(); } catch (ignored) { /* حرره المحرك */ }
  }
}

function sheet_(name) {
  if (!Object.prototype.hasOwnProperty.call(TABLES_, name)) fail_('INTERNAL', 'اسم جدول غير معروف.');
  var sheet = db_().getSheetByName(name);
  if (!sheet) fail_('SCHEMA_NOT_READY', 'ورقة ' + name + ' غير موجودة. شغّل migrateV36.');
  return sheet;
}

function headerMatches_(sheet, name) {
  var columns = TABLES_[name];
  if (sheet.getLastColumn() < columns.length) return false;
  var header = sheet.getRange(1, 1, 1, columns.length).getValues()[0];
  for (var i = 0; i < columns.length; i++) {
    if (String(header[i]) !== columns[i]) return false;
  }
  return true;
}

function rowToArray_(name, object) {
  return TABLES_[name].map(function (key) {
    var value = object[key];
    if (value === undefined || value === null) value = '';
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    return safeCell_(String(value));
  });
}

function objectFromRow_(name, row, rowNumber) {
  var object = {};
  TABLES_[name].forEach(function (key, index) { object[key] = row[index] == null ? '' : row[index]; });
  if (name === 'Students' || name === 'Drivers') object.active = boolCell_(object.active);
  if (name === 'Drivers') object.deleted = boolCell_(object.deleted);
  if (name === 'Days') {
    object.closed = boolCell_(object.closed);
    object.startRow = Number(object.startRow);
    object.rowCount = Number(object.rowCount);
  }
  if (name === 'Journeys') object.revision = Number(object.revision || 0);
  if (rowNumber) object._row = rowNumber;
  return object;
}

function readTable_(name) {
  if (ROW_CACHE_[name]) return ROW_CACHE_[name];
  var sheet = sheet_(name);
  if (!headerMatches_(sheet, name)) fail_('SCHEMA_NOT_READY', 'عناوين ورقة ' + name + ' لا تطابق المخطط. شغّل migrateV36.');
  var last = sheet.getLastRow();
  if (last < 2) return (ROW_CACHE_[name] = []);
  var columns = TABLES_[name].length;
  var values = sheet.getRange(2, 1, last - 1, columns).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] == null) continue;
    rows.push(objectFromRow_(name, values[i], i + 2));
  }
  ROW_CACHE_[name] = rows;
  return rows;
}

function appendRows_(name, objects) {
  if (!objects || !objects.length) return;
  var sheet = sheet_(name);
  var start = sheet.getLastRow() + 1;
  var values = objects.map(function (object) { return rowToArray_(name, object); });
  sheet.getRange(start, 1, values.length, TABLES_[name].length).setNumberFormat('@').setValues(values);
  delete ROW_CACHE_[name];
}

function updateRow_(name, rowNumber, object) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) fail_('INTERNAL', 'رقم صف غير صحيح.');
  sheet_(name).getRange(rowNumber, 1, 1, TABLES_[name].length).setNumberFormat('@').setValues([rowToArray_(name, object)]);
  delete ROW_CACHE_[name];
}

function writeRowsAt_(name, startRow, objects) {
  if (!objects || !objects.length) return;
  if (!Number.isInteger(startRow) || startRow < 2) fail_('INTERNAL', 'بداية كتابة غير صحيحة.');
  sheet_(name).getRange(startRow, 1, objects.length, TABLES_[name].length).setNumberFormat('@')
    .setValues(objects.map(function (object) { return rowToArray_(name, object); }));
  delete ROW_CACHE_[name];
}

function defaultSettings_() {
  return {
    systemName: 'نظام الحضور والانصراف',
    schoolName: 'اسم المدرسة',
    classrooms: [],
    workdays: [0, 1, 2, 3, 4],
    holidays: [],
    supervisors: [],
    autoClose: false,
    closeTime: '08:00',
    autoBackup: false,
    backupTime: '15:00',
    retention: 30,
    lateAfter: '07:30',
    ssoEnabled: false
  };
}

function readSettings_() {
  var saved = parseJson_(PropertiesService.getScriptProperties().getProperty('SETTINGS') || '{}', {});
  return Object.assign(defaultSettings_(), saved || {});
}

function setSettings_(settings) {
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(settings));
}

function databaseInfo_() {
  var book = db_();
  return { id: book.getId(), name: book.getName(), url: book.getUrl() };
}
function ensureSchema_() {
  var book = db_();
  var report = { created: [], extended: [] };
  Object.keys(TABLES_).forEach(function (name) {
    var columns = TABLES_[name];
    var sheet = book.getSheetByName(name);
    if (!sheet) {
      sheet = book.insertSheet(name);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns])
        .setBackground('#173F5F').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
      sheet.setRightToLeft(true);
      report.created.push(name);
      return;
    }
    var width = Math.max(sheet.getLastColumn(), columns.length);
    var header = sheet.getRange(1, 1, 1, width).getValues()[0];
    var changed = false;
    for (var i = 0; i < columns.length; i++) {
      var current = header[i] == null ? '' : String(header[i]).trim();
      if (current === columns[i]) continue;
      if (current === '') { header[i] = columns[i]; changed = true; continue; }
      fail_('SCHEMA_NOT_READY', 'عمود غير متوقع في ' + name + ' عند العمود ' + (i + 1) + '.');
    }
    if (changed) {
      sheet.getRange(1, 1, 1, width).setValues([header]);
      report.extended.push(name);
    }
    if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  });
  clearCache_();
  return report;
}
