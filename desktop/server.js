'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { parseStudentsBuffer } = require('./backup/workbook');

const MAX_JSON = 3 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;

// رؤوس أمان تُطبَّق على كل استجابة. التطبيق يستخدم سكربتات/أنماطًا مضمّنة
// لذلك يلزم 'unsafe-inline'، لكن لا يُسمح بأي مصدر خارجي.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

function send(res, status, body, headers, omitCsp) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  const base = Object.assign({
    'content-type': 'text/plain; charset=utf-8',
    'content-length': buffer.length
  }, SECURITY_HEADERS);
  if (omitCsp) delete base['content-security-policy'];
  res.writeHead(status, Object.assign(base, headers || {}));
  res.end(buffer);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('الطلب أكبر من الحد المسموح.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit) {
  const buffer = await readBody(req, limit || MAX_JSON);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); } catch (error) {
    throw Object.assign(new Error('JSON غير صحيح.'), { status: 400 });
  }
}

function isLoopback(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// اسم المضيف من ترويسة Host بدون المنفذ (يدعم IPv6 بين أقواس).
function hostHeaderName(req) {
  const raw = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.charAt(0) === '[') {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : raw;
  }
  return raw.split(':')[0];
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// يمنع DNS rebinding: مسارات الجهاز المحلي لا تُخدم إلا لمضيف محلي معروف.
function isLocalHost(req) {
  return LOCAL_HOSTS.has(hostHeaderName(req));
}

// يرفض الطلبات المتقاطعة من متصفح (CSRF) عبر Origin / Sec-Fetch-Site.
function isSameOriginRequest(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(String(origin));
    if (parsed.protocol !== 'http:') return false;
    const host = String((req.headers && req.headers.host) || '').toLowerCase();
    return parsed.host.toLowerCase() === host;
  } catch (error) {
    return false;
  }
}

// عناوين خدمات البيانات الوصفية السحابية — ممنوعة دائمًا حتى لا تُستخدم في SSRF.
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254'
]);

function privateAddress(address) {
  let value = String(address || '').toLowerCase();
  if (value.indexOf('::ffff:') === 0) value = value.slice(7);
  if (METADATA_ADDRESSES.has(value)) return false;
  if (value === '::1' || value === '127.0.0.1') return true;
  if (/^127\./.test(value)) return true;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  if (/^169\.254\./.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  if (/^fe80:/.test(value)) return true;
  return false;
}

// يقيّد الانضمام لأهداف الشبكة المحلية فقط لمنع SSRF إلى الإنترنت/الخدمات الداخلية.
async function isPrivateTarget(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(':') >= 0) return privateAddress(host);
  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    return results.length > 0 && results.every((entry) => privateAddress(entry.address));
  } catch (error) {
    return false;
  }
}

// يقبل ملفات Excel (xlsx/xls) أو نص CSV فقط، ويرفض أي محتوى ثنائي آخر.
function isStudentWorkbook(buffer) {
  if (!buffer || !buffer.length) return false;
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return true;
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return true;
  return buffer.indexOf(0) === -1;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function contentType(file) {
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

class AppServer {
  constructor(options) {
    this.runtime = options.runtime;
    this.engine = options.engine;
    this.backup = options.backup;
    this.discovery = options.discovery;
    this.update = options.update || null;
    this.logger = options.logger;
    this.dataDir = options.dataDir;
    this.uiDir = options.uiDir || path.join(__dirname, 'ui');
    this.appVersion = options.appVersion || '3.6.2';
    this.onInstalled = options.onInstalled || function () {};
    this.onBeforeQuit = options.onBeforeQuit || function () {};
    this.server = null;
    this.port = 0;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = require('node:http').createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.logger.error('http_handler_failed', { message: error && error.message, url: req.url });
          const status = error.status || 500;
          const message = status >= 500 ? 'تعذر تنفيذ الطلب.' : (error.message || 'INTERNAL');
          if (!res.headersSent) sendJson(res, status, { success: false, error: message });
          else res.end();
        });
      });
      server.on('error', reject);
      server.listen(port || 0, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port;
        this.logger.info('http_listening', { port: this.port });
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  requireLoopback(req, res) {
    if (isLoopback(req)) return true;
    this.logger.warn('non_loopback_denied', { url: req.url, address: req.socket && req.socket.remoteAddress });
    sendJson(res, 403, { success: false, error: 'هذه الواجهة متاحة من هذا الجهاز فقط.' });
    return false;
  }

  // يتحقق من أن الطلب محلي فعلًا وأن المضيف/المصدر ليسا خارجيين.
  requireLocalRequest(req, res) {
    if (!isLoopback(req)) return this.requireLoopback(req, res);
    if (!isLocalHost(req) || !isSameOriginRequest(req)) {
      this.logger.warn('cross_origin_denied', {
        url: req.url,
        host: req.headers && req.headers.host,
        origin: req.headers && req.headers.origin,
        site: req.headers && req.headers['sec-fetch-site']
      });
      sendJson(res, 403, { success: false, error: 'طلب غير موثوق.' });
      return false;
    }
    return true;
  }

  // كل مسارات /desktop/* الإدارية تتطلب جلسة مشرف صالحة، لا مجرد loopback.
  requireAdmin(req, res) {
    const token = String((req.headers && req.headers['x-session-token']) || '');
    if (!token) {
      this.logger.warn('desktop_admin_token_missing', { url: req.url });
      sendJson(res, 401, { success: false, error: 'يلزم تسجيل دخول المشرف.' });
      return false;
    }
    const account = this.runtime.resolveSession(token);
    if (!account) {
      this.logger.warn('desktop_admin_token_invalid', { url: req.url });
      sendJson(res, 401, { success: false, error: 'انتهت جلسة المشرف. سجّل الدخول من جديد.' });
      return false;
    }
    if (account.role !== 'admin' && !account.isOwner) {
      this.logger.warn('desktop_admin_forbidden', { url: req.url, user: account.username });
      sendJson(res, 403, { success: false, error: 'هذه اللوحة للمشرف فقط.' });
      return false;
    }
    return true;
  }

  requireKey(req, url, res) {
    // المفتاح يُقبل في الترويسة فقط، لا في الرابط، حتى لا يتسرب في السجلات.
    const supplied = req.headers['x-sync-key'] || '';
    if (safeEqual(supplied, this.engine.key)) return true;
    sendJson(res, 403, { success: false, error: 'مفتاح المزامنة غير صحيح.' });
    return false;
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, Object.assign({}, SECURITY_HEADERS, { allow: 'GET,POST,DELETE' }));
      res.end();
      return;
    }

    // ---------- مسارات المزامنة على الشبكة المحلية ----------
    if (pathname === '/sync/ping' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        app: 'sa36',
        version: 1,
        deviceId: this.engine.deviceId,
        name: this.engine.deviceName,
        installed: !!this.runtime.installed,
        appVersion: this.appVersion
      });
      return;
    }

    if (pathname === '/sync/changes' && method === 'GET') {
      if (!this.requireKey(req, url, res)) return;
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 300);
      sendJson(res, 200, this.engine.journal.changesSince(since, limit));
      return;
    }

    if (pathname === '/sync/info' && method === 'GET') {
      if (!this.requireKey(req, url, res)) return;
      const counts = this.runtime.counts();
      const config = this.runtime.getPublicConfig();
      sendJson(res, 200, {
        ok: true,
        deviceId: this.engine.deviceId,
        deviceName: this.engine.deviceName,
        installed: !!this.runtime.installed,
        schoolName: config.schoolName || '',
        systemName: config.systemName || '',
        counts
      });
      return;
    }

    if (pathname === '/desktop/clone' && method === 'GET') {
      if (!this.requireKey(req, url, res)) return;
      if (!this.runtime.installed) {
        sendJson(res, 409, { success: false, error: 'الجهاز الآخر غير مُجهَّز بعد.' });
        return;
      }
      const properties = Object.assign({}, this.runtime.store.getProperties());
      Object.keys(properties).forEach((key) => {
        if (/^SESSION_/.test(key) || ['BACKUP_FOLDER', 'DESKTOP_TRIGGERS', 'MAINTENANCE_ERROR', 'BACKUP_ERROR', 'LAST_BACKUP', 'LAST_CLOUD_BACKUP'].includes(key)) {
          delete properties[key];
        }
      });
      properties.DB_ID = this.runtime.store.workbook.bookId;
      sendJson(res, 200, {
        ok: true,
        workbook: this.runtime.store.workbook,
        properties,
        ownerEmail: this.runtime.store.meta.ownerEmail || '',
        deviceName: this.engine.deviceName
      });
      return;
    }

    // ---------- كل ما يلي من هذا الجهاز فقط ----------
    if (!this.requireLocalRequest(req, res)) return;

    if (pathname === '/' && method === 'GET') {
      if (!this.runtime.installed) {
        send(res, 200, fs.readFileSync(path.join(this.uiDir, 'setup.html')), { 'content-type': 'text/html; charset=utf-8' });
        return;
      }
      try {
        send(res, 200, this.runtime.renderIndex(), { 'content-type': 'text/html; charset=utf-8' });
      } catch (error) {
        this.logger.error('render_failed', { message: error.message });
        send(res, 500, '<!doctype html><meta charset="utf-8"><body dir="rtl"><h1>تعذر تحميل الواجهة</h1><pre>' +
          String(error.message || '').replace(/[<>&]/g, '') + '</pre></body>', { 'content-type': 'text/html; charset=utf-8' });
      }
      return;
    }

    if (pathname.startsWith('/desktop/') && (pathname.endsWith('.js') || pathname.endsWith('.css')) && method === 'GET') {
      const name = path.basename(pathname);
      const allowed = ['bridge.js', 'desktop-settings.js', 'desktop-settings.css'];
      if (allowed.includes(name)) {
        const file = path.join(this.uiDir, name);
        if (!fs.existsSync(file)) { send(res, 404, 'not found'); return; }
        send(res, 200, fs.readFileSync(file), { 'content-type': contentType(file) });
        return;
      }
    }

    // مسارات سطح المكتب الإدارية (بيانات، نسخ احتياطي، مزامنة، ملفات) تتطلب
    // جلسة مشرف صالحة. الملفات الثابتة أعلاه فقط مسموحة قبل تسجيل الدخول.
    if (pathname.startsWith('/desktop/') && !this.requireAdmin(req, res)) return;

    if (pathname === '/api' && method === 'POST') {
      if (!this.runtime.installed) {
        sendJson(res, 409, { success: false, code: 'SETUP_REQUIRED', message: 'لم يُجهَّز النظام بعد. أكمل الإعداد الأول.', data: null });
        return;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body.action !== 'string') {
        sendJson(res, 400, { success: false, code: 'VALIDATION', message: 'طلب غير صحيح.', data: null });
        return;
      }
      const result = await this.runtime.callApi(body);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/setup/status' && method === 'GET') {
      sendJson(res, 200, {
        installed: !!this.runtime.installed,
        role: this.runtime.role,
        counts: this.runtime.counts(),
        version: this.appVersion,
        deviceName: this.engine.deviceName,
        port: this.port
      });
      return;
    }

    if (pathname === '/setup/peers' && method === 'GET') {
      // لا يُرسل مفتاح المزامنة عبرDiscovery أو واجهة الإعداد؛ تتم المزاوجة يدويًا.
      const peers = Object.keys(this.engine.state.peers).map((id) => {
        const peer = this.engine.state.peers[id];
        return { id, name: peer.name || peer.url, url: peer.url, needsKey: !peer.key };
      });
      sendJson(res, 200, { peers });
      return;
    }

    if (pathname === '/setup/parse-students' && method === 'POST') {
      const buffer = await readBody(req, MAX_UPLOAD);
      if (!isStudentWorkbook(buffer)) {
        sendJson(res, 400, { success: false, error: 'صيغة الملف غير مدعومة. استخدم Excel أو CSV.' });
        return;
      }
      const parsed = parseStudentsBuffer(buffer);
      sendJson(res, 200, {
        ok: true,
        sheetName: parsed.sheetName,
        count: parsed.students.length,
        total: parsed.total,
        errors: parsed.errors.slice(0, 50),
        duplicates: parsed.duplicates.slice(0, 50),
        students: parsed.students,
        sample: parsed.students.slice(0, 8)
      });
      return;
    }

    if (pathname === '/desktop/parse-students' && method === 'POST') {
      const buffer = await readBody(req, MAX_UPLOAD);
      if (!isStudentWorkbook(buffer)) {
        sendJson(res, 400, { success: false, error: 'صيغة الملف غير مدعومة. استخدم Excel أو CSV.' });
        return;
      }
      const parsed = parseStudentsBuffer(buffer);
      sendJson(res, 200, {
        ok: true,
        sheetName: parsed.sheetName,
        count: parsed.students.length,
        total: parsed.total,
        errors: parsed.errors.slice(0, 50),
        duplicates: parsed.duplicates.slice(0, 50),
        students: parsed.students,
        sample: parsed.students.slice(0, 8)
      });
      return;
    }

    if (pathname === '/setup/install' && method === 'POST') {
      if (this.runtime.installed) { sendJson(res, 409, { success: false, error: 'النظام مُجهَّز مسبقًا.' }); return; }
      const body = await readJsonBody(req, MAX_UPLOAD);
      const result = await this.runtime.install({
        schoolName: body.schoolName,
        systemName: body.systemName,
        students: Array.isArray(body.students) ? body.students : [],
        autoBackup: true
      });
      this.onInstalled('install');
      sendJson(res, 200, { success: true, ...result });
      return;
    }

    if (pathname === '/setup/join' && method === 'POST') {
      if (this.runtime.installed) { sendJson(res, 409, { success: false, error: 'النظام مُجهَّز مسبقًا.' }); return; }
      const body = await readJsonBody(req, MAX_JSON);
      const base = String(body.url || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s]+$/i.test(base)) { sendJson(res, 400, { success: false, error: 'عنوان الجهاز غير صحيح.' }); return; }
      let target;
      try { target = new URL(base); } catch (error) { target = null; }
      if (!target || target.username || target.password || !(await isPrivateTarget(target.hostname))) {
        sendJson(res, 400, { success: false, error: 'يُسمح بالانضمام إلى عنوان على الشبكة المحلية فقط.' });
        return;
      }
      const key = String(body.key || '').trim();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetch(base + '/desktop/clone', {
          headers: { 'x-sync-key': key, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: 'تعذر الاتصال بالجهاز. تحقق من العنوان والمنفذ.' });
        return;
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        sendJson(res, 400, { success: false, error: response.status === 403 ? 'مفتاح المزامنة غير صحيح.' : 'تعذر الاتصال بالجهاز (' + response.status + ').' });
        return;
      }
      const payload = await response.json();
      if (!payload || !payload.workbook || !payload.workbook.sheets) {
        sendJson(res, 400, { success: false, error: 'بيانات الجهاز الآخر غير صحيحة.' });
        return;
      }
      const result = await this.runtime.join(payload);
      this.engine.addPeer(base, key, payload.deviceName || base, true);
      this.onInstalled('join');
      sendJson(res, 200, { success: true, ...result, deviceName: payload.deviceName || base });
      return;
    }

    if (pathname === '/desktop/status' && method === 'GET') {
      sendJson(res, 200, {
        installed: !!this.runtime.installed,
        role: this.runtime.role,
        version: this.appVersion,
        deviceName: this.engine.deviceName,
        dataDir: this.dataDir,
        port: this.port,
        counts: this.runtime.counts(),
        sync: this.engine.status(),
        backup: this.backup.status(),
        update: this.update ? this.update.status() : null
      });
      return;
    }

    if (pathname === '/desktop/sync/status' && method === 'GET') {
      sendJson(res, 200, this.engine.status());
      return;
    }

    if (pathname === '/desktop/sync/now' && method === 'POST') {
      const result = await this.engine.syncNow('manual');
      sendJson(res, 200, { ok: true, result, status: this.engine.status() });
      return;
    }

    if (pathname === '/desktop/sync/peers' && method === 'POST') {
      const body = await readJsonBody(req);
      let target = null;
      try { target = new URL(String(body.url || '').trim()); } catch (error) { target = null; }
      if (!target || !/^https?:$/.test(target.protocol) || !(await isPrivateTarget(target.hostname))) {
        sendJson(res, 400, { success: false, error: 'عنوان الجهاز يجب أن يكون على الشبكة المحلية.' });
        return;
      }
      const peer = this.engine.addPeer(body.url, body.key, body.name, true);
      sendJson(res, 200, { ok: true, peer, status: this.engine.status() });
      return;
    }

    if (pathname.startsWith('/desktop/sync/peers/') && method === 'DELETE') {
      const id = pathname.split('/').pop();
      const removed = this.engine.removePeer(id);
      sendJson(res, 200, { ok: removed, status: this.engine.status() });
      return;
    }

    if (pathname === '/desktop/sync/auto' && method === 'POST') {
      const body = await readJsonBody(req);
      this.engine.state.auto = body.auto !== false;
      this.engine.saveState();
      sendJson(res, 200, { ok: true, status: this.engine.status() });
      return;
    }

    if (pathname === '/desktop/backup/status' && method === 'GET') {
      sendJson(res, 200, this.backup.status());
      return;
    }

    if (pathname === '/desktop/backup/credentials' && method === 'POST') {
      const body = await readJsonBody(req, MAX_JSON);
      const info = this.backup.saveCredentials(body.credentials || body);
      let test = null;
      if (body.test !== false) {
        try { test = await this.backup.testConnection(); } catch (error) { test = { error: error.message }; }
      }
      sendJson(res, 200, { ok: true, credentials: info, test, status: this.backup.status() });
      return;
    }

    if (pathname === '/desktop/backup/remove-credentials' && method === 'POST') {
      this.backup.removeCredentials();
      sendJson(res, 200, { ok: true, status: this.backup.status() });
      return;
    }

    if (pathname === '/desktop/backup/oauth/start' && method === 'POST') {
      const body = await readJsonBody(req, MAX_JSON);
      const started = await this.backup.startUserAuth(body.client || body);
      sendJson(res, 200, { ok: true, url: started.url, status: this.backup.status() });
      return;
    }

    if (pathname === '/desktop/backup/oauth/remove' && method === 'POST') {
      this.backup.removeUserAuth();
      sendJson(res, 200, { ok: true, status: this.backup.status() });
      return;
    }

    if (pathname === '/desktop/update/check' && method === 'POST') {
      if (!this.update) { sendJson(res, 404, { success: false, error: 'فحص التحديث غير متاح.' }); return; }
      const status = await this.update.check();
      sendJson(res, 200, { ok: true, update: status });
      return;
    }

    if (pathname === '/desktop/update/download' && method === 'POST') {
      if (!this.update) { sendJson(res, 404, { success: false, error: 'فحص التحديث غير متاح.' }); return; }
      const status = await this.update.download();
      sendJson(res, 200, { ok: true, update: status });
      return;
    }

    if (pathname === '/desktop/backup/test' && method === 'POST') {
      const test = await this.backup.testConnection();
      sendJson(res, 200, { ok: true, test });
      return;
    }

    if (pathname === '/desktop/backup/config' && method === 'POST') {
      const body = await readJsonBody(req);
      const status = this.backup.configure(body);
      sendJson(res, 200, { ok: true, status });
      return;
    }

    if (pathname === '/desktop/backup/run' && method === 'POST') {
      const result = await this.backup.runNow('manual');
      sendJson(res, 200, { ok: true, result, status: this.backup.status() });
      return;
    }

    if (pathname === '/desktop/backup/import-latest' && method === 'POST') {
      const result = await this.backup.importLatest();
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (pathname === '/desktop/database' && method === 'GET') {
      const body = this.runtime.databaseJson();
      send(res, 200, body, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="school-attendance-db.json"'
      });
      return;
    }

    if (pathname.startsWith('/desktop/backup-file/') && method === 'GET') {
      const id = pathname.split('/').pop();
      const text = this.runtime.store.readFile(id);
      if (text === null) { send(res, 404, 'not found'); return; }
      send(res, 200, text, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, at: new Date().toISOString(), installed: !!this.runtime.installed });
      return;
    }

    sendJson(res, 404, { success: false, error: 'المسار غير موجود.' });
  }
}

module.exports = { AppServer, isLoopback, safeEqual, privateAddress };
