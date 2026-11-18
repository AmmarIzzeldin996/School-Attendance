// 02_Core.gs — أخطاء، تحقق، هوية، وقت، تشفير، سجلات تقنية. لا وصول إلى Sheets هنا.

function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code || 'INTERNAL';
  this.message = message || ERROR_MESSAGES_[this.code] || ERROR_MESSAGES_.INTERNAL;
  this.details = details == null ? null : details;
  if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail_(code, message, details) {
  throw new AppError(code, message, details);
}

function isPlainObject_(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText_(value, max) {
  var text = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  if (text.length > (max || 150)) fail_('VALIDATION', 'النص أطول من الحد المسموح.');
  return text;
}

function normalizeName_(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}

function normalizeId_(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim()
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) & 15); })
    .toUpperCase();
}

function normalizeBarcode_(value) {
  return String(value == null ? '' : value).normalize('NFKC')
    .replace(/[\u0000-\u0020\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/^\*+|\*+$/g, '')
    .trim();
}

function validateDate_(value) {
  var text = String(value == null ? '' : value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail_('VALIDATION', 'التاريخ غير صحيح.');
  var date = new Date(text + 'T12:00:00Z');
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail_('VALIDATION', 'التاريخ غير صحيح.');
  return text;
}

function validateTime_(value, fallback) {
  var text = String(value == null || value === '' ? fallback : value);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) fail_('VALIDATION', 'الوقت غير صحيح.');
  return text;
}

function today_() {
  return Utilities.formatDate(new Date(), TIMEZONE_, 'yyyy-MM-dd');
}

function stamp_() {
  return Utilities.formatDate(new Date(), TIMEZONE_, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function dayOfWeek_(date) {
  validateDate_(date);
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

function schoolDay_(date, settings) {
  validateDate_(date);
  return (settings.workdays || []).indexOf(dayOfWeek_(date)) !== -1 &&
    (settings.holidays || []).indexOf(date) === -1;
}

function daysBetween_(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

function addDays_(date, days) {
  var time = Date.parse(validateDate_(date) + 'T00:00:00Z') + days * 86400000;
  return new Date(time).toISOString().slice(0, 10);
}

function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + ((bytes[i] + 256) % 256).toString(16)).slice(-2);
  return out;
}

function sha256_(value) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}

function secret_() {
  var value = PropertiesService.getScriptProperties().getProperty('AUTH_SECRET');
  if (!value) fail_('SCHEMA_NOT_READY', 'لم تُهيأ أسرار النظام. شغّل installSchool أو migrateV36 من المحرر.');
  return value;
}

function tokenHash_(token) {
  return hex_(Utilities.computeHmacSha256Signature('card|' + token, secret_()));
}

var RANDOM_COUNTER_ = 0;
function randomToken_() {
  RANDOM_COUNTER_ += 1;
  var seed = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Date.now() + '|' + RANDOM_COUNTER_;
  var bytes = Utilities.computeHmacSha256Signature(seed, secret_());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function uuid_() {
  return Utilities.getUuid();
}

function isCardToken_(value) {
  return typeof value === 'string' && value.length >= 20 && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeCell_(value) {
  if (typeof value === 'string' && /^[=+@\-]/.test(value)) return "'" + value;
  return value == null ? '' : value;
}

function truncate_(value, max) {
  var text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function jsonSafe_(value, max) {
  try { return truncate_(JSON.stringify(value), max || 500); } catch (error) { return ''; }
}

function parseJson_(text, fallback) {
  try { return JSON.parse(text); } catch (error) { return fallback; }
}

function boolCell_(value) {
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (value === true || text === 'true' || text === '1') return true;
  if (value === false || text === 'false' || text === '0' || text === '') return false;
  fail_('SCHEMA_NOT_READY', 'قيمة منطقية غير صحيحة في قاعدة البيانات.');
}

function permissionsFor_(account) {
  if (!account) return [];
  if (account.role === 'admin' && account.id === PropertiesService.getScriptProperties().getProperty('AUTH_PRIMARY_ADMIN')) {
    return ROLE_PERMISSIONS_.admin.slice();
  }
  return (ROLE_PERMISSIONS_[account.role] || []).filter(function (permission) {
    return permission !== 'users';
  });
}

function primaryAdminId_() {
  return PropertiesService.getScriptProperties().getProperty('AUTH_PRIMARY_ADMIN') || '';
}

function isPrimaryAdmin_(account) {
  return !!account && account.id === primaryAdminId_();
}

function accountById_(id) {
  if (typeof id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  return parseJson_(PropertiesService.getScriptProperties().getProperty('ACCOUNT_' + id), null);
}

function accounts_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).filter(function (key) { return key.indexOf('ACCOUNT_') === 0; })
    .map(function (key) { return parseJson_(all[key], null); })
    .filter(Boolean);
}

function saveAccount_(account) {
  account.updatedAt = stamp_();
  PropertiesService.getScriptProperties().setProperty('ACCOUNT_' + account.id, JSON.stringify(account));
}

// نطاق الصفوف: فصول الحساب المسموحة. فارغ = كل الفصول، والمشرف يرى الكل دائمًا.
function scopeClassrooms_(account) {
  if (!account || account.role === 'admin') return [];
  return (account.classrooms || []).map(function (room) { return String(room || '').trim(); })
    .filter(function (room) { return !!room; });
}

function inScope_(account, classroom) {
  var scope = scopeClassrooms_(account);
  if (!scope.length) return true;
  return scope.indexOf(String(classroom || '').trim()) >= 0;
}

function scopeRows_(account, rows) {
  if (!scopeClassrooms_(account).length) return rows;
  return rows.filter(function (row) { return inScope_(account, row.classroom); });
}

function publicAccount_(account) {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    email: account.email || '',
    role: account.role,
    roleLabel: ROLE_LABELS_[account.role] || 'دور غير معروف',
    classrooms: (account.classrooms || []).slice(),
    active: !!account.active,
    mustChange: !!account.mustChange && !account.passwordChangedAt,
    permissions: permissionsFor_(account),
    isOwner: isPrimaryAdmin_(account)
  };
}

function sanitizeSettings_(settings, account) {
  var admin = !!account && isPrimaryAdmin_(account);
  return {
    systemName: settings.systemName,
    schoolName: settings.schoolName,
    classrooms: settings.classrooms || [],
    workdays: settings.workdays || [],
    holidays: settings.holidays || [],
    autoClose: !!settings.autoClose,
    closeTime: settings.closeTime || '08:00',
    autoBackup: !!settings.autoBackup,
    backupTime: settings.backupTime || '15:00',
    retention: Number(settings.retention || 30),
    lateAfter: settings.lateAfter || '07:30',
    ssoEnabled: !!settings.ssoEnabled,
    supervisors: admin ? (settings.supervisors || []) : []
  };
}

// ---------- السجل التقني (غير حظري) ----------
var LOG_LEVELS_ = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
var LOG_FIELDS_ = ['action', 'code', 'duration_ms', 'lock_wait_ms', 'user_id', 'request_id', 'target_id', 'count', 'mode'];

function log_(level, event, fields) {
  try {
    if (LOG_LEVELS_.indexOf(level) < 0) level = 'INFO';
    var entry = { ts: stamp_(), level: level, event: String(event || '').slice(0, 80) };
    fields = fields || {};
    LOG_FIELDS_.forEach(function (key) {
      if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') {
        entry[key] = typeof fields[key] === 'string' ? fields[key].slice(0, 120) : fields[key];
      }
    });
    console.log(JSON.stringify(entry));
  } catch (ignored) { /* التسجيل لا يُفشل العملية */ }
}

function envelope_(success, code, message, data, requestId) {
  return {
    success: !!success,
    code: code,
    message: message || (success ? 'تمت العملية.' : (ERROR_MESSAGES_[code] || ERROR_MESSAGES_.INTERNAL)),
    data: data === undefined ? null : data,
    timestamp: stamp_(),
    requestId: requestId || ''
  };
}

function safeError_(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details };
  log_('ERROR', 'unhandled_exception', { code: 'INTERNAL' });
  return { code: 'INTERNAL', message: ERROR_MESSAGES_.INTERNAL, details: null };
}
