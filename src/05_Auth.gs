// 05_Auth.gs — جلسات، دخول بالكلمة أو البطاقة أو Google، وإدارة حسابات المشرف الأصلي.
var AUTH_CONTEXT_ = null;

function sessionKey_(token) {
  return 'SESSION_' + sha256_(token);
}

function createSession_(account) {
  var token = randomToken_();
  var now = Date.now();
  var session = {
    userId: account.id,
    createdAt: stamp_(),
    expiresAt: now + SESSION_IDLE_MS_,
    absoluteAt: now + SESSION_ABSOLUTE_MS_,
    lastSeenAt: now,
    version: Number(account.version || 0),
    status: 'ACTIVE'
  };
  PropertiesService.getScriptProperties().setProperty(sessionKey_(token), JSON.stringify(session));
  return token;
}

function sessionAccount_(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    fail_('SESSION_EXPIRED', ERROR_MESSAGES_.SESSION_EXPIRED);
  }
  var props = PropertiesService.getScriptProperties();
  var key = sessionKey_(token);
  var session = parseJson_(props.getProperty(key), null);
  var now = Date.now();
  var account = session ? accountById_(session.userId) : null;
  var valid = !!session && !!account && !!account.active &&
    Number(account.version || 0) === Number(session.version) &&
    now < Number(session.absoluteAt) && now < Number(session.expiresAt);
  if (!valid) {
    if (session) props.deleteProperty(key);
    fail_('SESSION_EXPIRED', ERROR_MESSAGES_.SESSION_EXPIRED);
  }
  if (now - Number(session.lastSeenAt || 0) > 60000) {
    session.lastSeenAt = now;
    session.expiresAt = Math.min(now + SESSION_IDLE_MS_, Number(session.absoluteAt));
    props.setProperty(key, JSON.stringify(session));
  }
  return account;
}

function revokeSessions_(userId) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('SESSION_') !== 0) return;
    var session = parseJson_(all[key], null);
    if (session && session.userId === userId) props.deleteProperty(key);
  });
}

function cleanSessions_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('SESSION_') !== 0) return;
    var session = parseJson_(all[key], null);
    if (!session || now >= Number(session.absoluteAt) || now >= Number(session.expiresAt)) {
      props.deleteProperty(key);
    }
  });
}

function loginCacheKey_(username) {
  return 'LOGIN_' + sha256_('login|' + username).slice(0, 32);
}

function loginAttempts_(username) {
  return Number(CacheService.getScriptCache().get(loginCacheKey_(username)) || 0);
}

function registerLoginFailure_(username) {
  var cache = CacheService.getScriptCache();
  var key = loginCacheKey_(username);
  var count = Number(cache.get(key) || 0) + 1;
  try { cache.put(key, String(count), LOGIN_WINDOW_SECONDS_); } catch (ignored) { /* لا يمنع المحاولة */ }
  return count;
}

function clearLoginFailures_(username) {
  try { CacheService.getScriptCache().remove(loginCacheKey_(username)); } catch (ignored) { /* تجاهل */ }
}

function passwordPolicy_(password) {
  if (typeof password !== 'string' || password.length < 8 || /[\u0000-\u001f\u007f]/.test(password)) {
    fail_('VALIDATION', 'كلمة المرور 8 خانات على الأقل، دون محارف تحكم.');
  }
  if (encodeURIComponent(password).replace(/%[0-9A-F]{2}/g, 'x').length > 72) {
    fail_('VALIDATION', 'كلمة المرور طويلة؛ استخدم كلمة أقصر من 72 بايت.');
  }
}

function randomBytes_(count) {
  var bytes = [];
  var rounds = Math.ceil(count / 32);
  for (var i = 0; i < rounds; i++) {
    var digest = Utilities.computeHmacSha256Signature(
      Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Date.now() + '|' + i,
      secret_()
    );
    for (var j = 0; j < digest.length && bytes.length < count; j++) bytes.push(digest[j]);
  }
  return bytes;
}

function passwordHash_(password) {
  passwordPolicy_(password);
  return passwordCrypto_().hashSync(password, '$2a$12$' + passwordCrypto_().encodeBase64(randomBytes_(32), 16));
}

function verifyPassword_(password, hash) {
  try { return passwordCrypto_().compareSync(String(password || ''), String(hash || '')); }
  catch (error) { return false; }
}

function bootstrapData_(account) {
  var settings = readSettings_();
  return {
    user: publicAccount_(account),
    today: today_(),
    settings: sanitizeSettings_(settings, account),
    version: APP_VERSION_,
    database: (account.role === 'admin' || isPrimaryAdmin_(account)) ? databaseInfo_() : null,
    ssoEnabled: !!settings.ssoEnabled
  };
}

function publicConfig_() {
  var settings = readSettings_();
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (ignored) { email = ''; }
  return {
    systemName: settings.systemName,
    schoolName: settings.schoolName,
    version: APP_VERSION_,
    ssoAvailable: !!settings.ssoEnabled && !!email,
    ssoEmail: email
  };
}

function ping_() {
  return { status: 'ok', version: APP_VERSION_, time: stamp_() };
}

function login_(ctx, payload) {
  var username = String(payload.username || '').trim().toLowerCase();
  var password = payload.password;
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || typeof password !== 'string' || !password) {
    fail_('INVALID_CREDENTIALS', ERROR_MESSAGES_.INVALID_CREDENTIALS);
  }
  if (loginAttempts_(username) >= MAX_LOGIN_FAILURES_) {
    auditSafe_(null, 'فشل تسجيل الدخول', { operator: username, result: 'FAIL', reason: 'TOO_MANY_ATTEMPTS' });
    fail_('TOO_MANY_ATTEMPTS', ERROR_MESSAGES_.TOO_MANY_ATTEMPTS);
  }
  var account = accounts_().filter(function (item) { return item.username === username; })[0] || null;
  var props = PropertiesService.getScriptProperties();
  var fallback = props.getProperty('AUTH_DUMMY');
  if (!fallback) {
    fallback = passwordHash_('Dummy!' + randomToken_());
    props.setProperty('AUTH_DUMMY', fallback);
  }
  var ok = verifyPassword_(password, account ? account.passwordHash : fallback);
  if (!account || !ok) {
    registerLoginFailure_(username);
    auditSafe_(null, 'فشل تسجيل الدخول', {
      operator: username, result: 'FAIL',
      reason: account ? 'INVALID_PASSWORD' : 'UNKNOWN_USERNAME'
    });
    fail_('INVALID_CREDENTIALS', ERROR_MESSAGES_.INVALID_CREDENTIALS);
  }
  if (!account.active) {
    auditSafe_(null, 'فشل تسجيل الدخول', { operator: username, result: 'FAIL', reason: 'USER_INACTIVE', targetType: 'user', targetId: account.id });
    fail_('USER_INACTIVE', ERROR_MESSAGES_.USER_INACTIVE);
  }
  var now = Date.now();
  if (Number(account.lockedUntil || 0) > now) {
    fail_('TOO_MANY_ATTEMPTS', ERROR_MESSAGES_.TOO_MANY_ATTEMPTS);
  }
  clearLoginFailures_(username);
  cleanSessions_();
  var token = createSession_(account);
  account.lastLoginAt = stamp_();
  account.failed = 0;
  saveAccount_(account);
  audit_({ account: account, requestId: ctx.requestId }, 'تسجيل دخول', {
    targetType: 'user', targetId: account.id, details: 'بكلمة المرور'
  });
  var result = bootstrapData_(account);
  result.token = token;
  return result;
}

function loginCard_(ctx, payload) {
  var raw = normalizeBarcode_(payload.token);
  if (!isCardToken_(raw)) fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
  var cards = readTable_('Cards');
  var card = findCardByToken_(cards, raw);
  if (!card) {
    auditSafe_(null, 'محاولة دخول ببطاقة غير صالحة', { result: 'FAIL', reason: 'INVALID_QR' });
    fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
  }
  assertCardUsable_(card, 'USER');
  var account = accountById_(card.owner_id);
  if (!account) fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
  if (!account.active) {
    auditSafe_(null, 'محاولة دخول بحساب موقوف', { result: 'FAIL', reason: 'USER_INACTIVE', targetType: 'user', targetId: account.id });
    fail_('USER_INACTIVE', ERROR_MESSAGES_.USER_INACTIVE);
  }
  touchCard_(card);
  var token = createSession_(account);
  audit_({ account: account, requestId: ctx.requestId }, 'تسجيل دخول', {
    targetType: 'user', targetId: account.id, details: 'ببطاقة QR', before: { lastUsedAt: card.last_used_at }, after: { lastUsedAt: stamp_() }
  });
  var result = bootstrapData_(account);
  result.token = token;
  return result;
}

function loginGoogle_(ctx, payload) {
  var settings = readSettings_();
  if (!settings.ssoEnabled) fail_('PERMISSION_DENIED', 'الدخول بحساب Google غير مفعّل.');
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) fail_('INVALID_CREDENTIALS', 'تعذر التحقق من هوية Google لهذه الجلسة.');
  var account = accounts_().filter(function (item) {
    return String(item.email || '').toLowerCase() === email ||
      (item.username === email && email.indexOf('@') > 0);
  })[0];
  if (!account) fail_('INVALID_CREDENTIALS', 'لا يوجد حساب مربوط بهذا البريد.');
  if (!account.active) fail_('USER_INACTIVE', ERROR_MESSAGES_.USER_INACTIVE);
  var token = createSession_(account);
  audit_({ account: account, requestId: ctx.requestId }, 'تسجيل دخول', {
    targetType: 'user', targetId: account.id, details: 'بحساب Google', reason: email
  });
  var result = bootstrapData_(account);
  result.token = token;
  return result;
}

function logout_(ctx) {
  var token = ctx.requestToken;
  audit_(ctx, 'تسجيل خروج', { targetType: 'user', targetId: ctx.account.id });
  if (token) PropertiesService.getScriptProperties().deleteProperty(sessionKey_(token));
  return { loggedOut: true };
}

function changePassword_(ctx, payload) {
  var account = accountById_(ctx.account.id);
  var current = payload.currentPassword;
  var next = payload.newPassword;
  if (!verifyPassword_(current, account.passwordHash)) {
    auditSafe_(ctx, 'فشل تغيير كلمة المرور', { result: 'FAIL', reason: 'INVALID_CURRENT' });
    fail_('INVALID_CREDENTIALS', 'كلمة المرور الحالية غير صحيحة.');
  }
  passwordPolicy_(next);
  if (verifyPassword_(next, account.passwordHash)) {
    fail_('VALIDATION', 'اختر كلمة مرور مختلفة عن الحالية.');
  }
  account.passwordHash = passwordHash_(next);
  account.version = Number(account.version || 0) + 1;
  account.mustChange = false;
  account.failed = 0;
  account.lockedUntil = 0;
  account.passwordChangedAt = stamp_();
  saveAccount_(account);
  revokeSessions_(account.id);
  audit_({ account: account, requestId: ctx.requestId }, 'تغيير كلمة المرور', {
    targetType: 'user', targetId: account.id, details: 'أُبطلت كل الجلسات السابقة'
  });
  return { relogin: true };
}

function getUsers_(ctx) {
  return accounts_().map(publicAccount_).sort(function (a, b) {
    return a.username < b.username ? -1 : 1;
  });
}

function saveUser_(ctx, payload) {
  var all = accounts_();
  var existing = payload.id ? accountById_(payload.id) : null;
  if (payload.id && !existing) fail_('NOT_FOUND', 'الحساب غير موجود.');
  var username = String(payload.username || '').trim().toLowerCase();
  var name = cleanText_(payload.name, 100);
  var email = String(payload.email || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || !name) {
    fail_('VALIDATION', 'أدخل اسمًا واسم مستخدم إنجليزيًا من 3 إلى 40 حرفًا دون مسافات.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('VALIDATION', 'البريد الإلكتروني غير صحيح.');
  if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS_, payload.role)) fail_('VALIDATION', 'الدور غير صحيح.');
  if (typeof payload.active !== 'boolean') fail_('VALIDATION', 'حالة الحساب غير صحيحة.');
  if (all.some(function (item) { return item.username === username && (!existing || item.id !== existing.id); })) {
    fail_('CONFLICT', 'اسم المستخدم موجود مسبقًا.');
  }
  if (email && all.some(function (item) { return String(item.email || '').toLowerCase() === email && (!existing || item.id !== existing.id); })) {
    fail_('CONFLICT', 'البريد الإلكتروني مربوط بحساب آخر.');
  }
  if (existing && isPrimaryAdmin_(existing) && (payload.role !== 'admin' || !payload.active)) {
    fail_('PERMISSION_DENIED', 'لا يمكن تعطيل المشرف الأصلي أو تخفيض صلاحياته.');
  }
  var otherAdmins = all.filter(function (item) {
    return item.active && item.role === 'admin' && (!existing || item.id !== existing.id);
  }).length;
  if (existing && existing.role === 'admin' && existing.active &&
      (payload.role !== 'admin' || !payload.active) && otherAdmins === 0) {
    fail_('PERMISSION_DENIED', 'لا يمكن تعطيل آخر مدير نظام أو تخفيض صلاحياته.');
  }
  if (!existing && all.length >= 30) fail_('VALIDATION', 'الحد الأقصى 30 حسابًا.');
  if (!existing && !payload.password) fail_('VALIDATION', 'كلمة مرور الحساب الجديد مطلوبة.');
  if (existing && existing.id === ctx.account.id && payload.password) {
    fail_('VALIDATION', 'لتغيير كلمة مرورك استخدم قسم كلمة المرور وأدخل الحالية.');
  }
  var before = existing ? publicAccount_(existing) : null;
  var hash = payload.password ? passwordHash_(payload.password) : null;
  var securityChange = !existing || existing.role !== payload.role || !!existing.active !== !!payload.active || !!hash;
  var account = existing || {
    id: uuid_(), version: 0, createdAt: stamp_(), failed: 0, lockedUntil: 0, mustChange: true
  };
  account.username = username;
  account.name = name;
  account.email = email;
  account.role = payload.role;
  account.active = payload.active;
  account.version = Number(account.version || 0) + (securityChange ? 1 : 0);
  if (hash) {
    account.passwordHash = hash;
    account.mustChange = true;
    account.failed = 0;
    account.lockedUntil = 0;
  }
  saveAccount_(account);
  if (securityChange) revokeSessions_(account.id);
  var revokedCards = account.active ? 0 : revokeOwnerCards_('USER', account.id, ctx.account.username, 'إيقاف الحساب');
  audit_(ctx, existing ? 'تعديل حساب مستخدم' : 'إنشاء حساب مستخدم', {
    targetType: 'user', targetId: account.id,
    details: username + ' | ' + account.role + ' | ' + (account.active ? 'نشط' : 'موقوف') +
      (revokedCards ? ' | بطاقات ملغاة: ' + revokedCards : ''),
    before: before, after: publicAccount_(account)
  });
  return { user: publicAccount_(account), users: getUsers_(ctx) };
}

// يُستدعى من المحرر فقط: ينشئ المشرف الأصلي ويعيد كلمة مرور مؤقتة مرة واحدة.
function initializeAccounts_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTH_SCHEMA') === '4') return { alreadyInitialized: true };
  if (!props.getProperty('AUTH_SECRET')) props.setProperty('AUTH_SECRET', uuid_() + uuid_() + uuid_());
  var temporary = 'Aa!' + randomToken_().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  var account = accountById_(props.getProperty('AUTH_PRIMARY_ADMIN')) ||
    accounts_().filter(function (item) { return item.username === 'admin' || item.username === 'supervisor'; })[0] ||
    { id: uuid_(), username: 'admin', name: 'مدير النظام', version: 0, createdAt: stamp_(), qrVersion: 1 };
  account.role = 'admin';
  account.active = true;
  account.mustChange = true;
  account.failed = 0;
  account.lockedUntil = 0;
  account.version = Number(account.version || 0) + 1;
  account.email = account.email || '';
  account.passwordHash = passwordHash_(temporary);
  saveAccount_(account);
  props.setProperty('AUTH_PRIMARY_ADMIN', account.id);
  props.setProperty('AUTH_DUMMY', passwordHash_('Dummy!' + randomToken_()));
  props.setProperty('AUTH_SCHEMA', '4');
  return { username: account.username, temporaryPassword: temporary };
}

function recoverSupervisorPassword_() {
  var props = PropertiesService.getScriptProperties();
  var account = accountById_(props.getProperty('AUTH_PRIMARY_ADMIN'));
  if (!account) return { error: 'شغّل installSchool أولًا.' };
  var temporary = 'Aa!' + randomToken_().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  account.passwordHash = passwordHash_(temporary);
  account.mustChange = true;
  account.active = true;
  account.role = 'admin';
  account.version = Number(account.version || 0) + 1;
  account.failed = 0;
  account.lockedUntil = 0;
  saveAccount_(account);
  revokeSessions_(account.id);
  return { username: account.username, temporaryPassword: temporary };
}
