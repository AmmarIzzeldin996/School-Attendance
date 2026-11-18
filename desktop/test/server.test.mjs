import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import XLSX from 'xlsx';
import { AppServer, isLoopback, safeEqual, privateAddress } from '../server.js';
import { SyncEngine } from '../sync/engine.js';
import { Discovery } from '../sync/discovery.js';
import { BackupManager } from '../backup/manager.js';
import { Secrets } from '../lib/secrets.js';
import { installRuntime, createRuntime, tempDir, quietLogger, cleanup } from './helpers.js';

let primary;
let engine;
let server;
let base;
let account;
let adminToken = '';

function rawRequest(target, options) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

function withToken(extra) {
  return Object.assign({ 'x-session-token': adminToken }, extra || {});
}

function sampleXlsx() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['رقم الطالب', 'اسم الطالب', 'الصف والفصل', 'هاتف ولي الأمر'],
    ['STU-4001', 'طالب استيراد', 'الصف الرابع', ''],
    ['STU-4002', 'طالبة استيراد', 'الصف الرابع', '']
  ]), 'الطلاب');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

beforeAll(async () => {
  primary = await installRuntime();
  account = primary.result.account;
  engine = new SyncEngine({
    dataDir: primary.dataDir,
    store: primary.runtime.store,
    runtime: primary.runtime,
    logger: quietLogger(),
    deviceName: primary.runtime.store.meta.deviceName
  });
  const backup = new BackupManager({
    dataDir: primary.dataDir,
    store: primary.runtime.store,
    runtime: primary.runtime,
    logger: quietLogger(),
    secrets: new Secrets(primary.dataDir, { safeStorage: null }),
    deviceName: primary.runtime.store.meta.deviceName,
    deviceId: engine.deviceId
  });
  server = new AppServer({
    runtime: primary.runtime,
    engine,
    backup,
    discovery: null,
    logger: quietLogger(),
    dataDir: primary.dataDir,
    appVersion: '3.6.0'
  });
  const port = await server.listen(0);
  base = 'http://127.0.0.1:' + port;
  const login = await fetch(base + '/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'login',
      token: '',
      payload: { username: account.username, password: account.temporaryPassword },
      requestId: 'test-admin-session'
    })
  }).then((response) => response.json());
  if (!login.success) throw new Error('admin login failed: ' + JSON.stringify(login));
  adminToken = login.data.token;
});

afterAll(async () => {
  if (server) await server.close();
  if (primary) cleanup(primary.dataDir);
});

describe('desktop HTTP server', () => {
  it('serves health and setup status from loopback', async () => {
    const health = await fetch(base + '/health').then((response) => response.json());
    expect(health.ok).toBe(true);
    expect(health.installed).toBe(true);

    const status = await fetch(base + '/setup/status').then((response) => response.json());
    expect(status.installed).toBe(true);
    expect(status.counts.students).toBe(3);
    expect(status.role).toBe('primary');
  });

  it('renders the real application with the desktop bridge and stylesheet', async () => {
    const response = await fetch(base + '/');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('/desktop/bridge.js');
    expect(html).toContain('/desktop/desktop-settings.js');
    expect(html).toContain('/desktop/desktop-settings.css');
    expect(html).toContain('SA.boot();');
    expect(html).not.toContain('<?!=');

    const css = await fetch(base + '/desktop/desktop-settings.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('protects LAN sync routes with the sync key', async () => {
    const denied = await fetch(base + '/sync/changes?since=0');
    expect(denied.status).toBe(403);

    const allowed = await fetch(base + '/sync/changes?since=0', {
      headers: { 'x-sync-key': engine.key }
    });
    const data = await allowed.json();
    expect(allowed.status).toBe(200);
    expect(Array.isArray(data.ops)).toBe(true);
  });

  it('runs the real API through /api', async () => {
    const login = await fetch(base + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'login',
        token: '',
        payload: { username: account.username, password: account.temporaryPassword },
        requestId: 'test-login'
      })
    }).then((response) => response.json());
    expect(login.success, JSON.stringify(login)).toBe(true);
    expect(login.data.user.mustChange).toBe(true);
    expect(login.data.token).toBeTruthy();

    const ping = await fetch(base + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ping', token: '', payload: {} })
    }).then((response) => response.json());
    expect(ping.success).toBe(true);
    expect(ping.data.version).toBe('3.6.2');
  });

  it('exposes desktop status, database download, and sync status', async () => {
    const status = await fetch(base + '/desktop/status', { headers: withToken() }).then((response) => response.json());
    expect(status.installed).toBe(true);
    expect(status.sync.deviceId).toBe(engine.deviceId);
    expect(status.backup.config).toBeTruthy();

    const database = await fetch(base + '/desktop/database', { headers: withToken() });
    const text = await database.text();
    expect(database.headers.get('content-disposition')).toContain('school-attendance-db.json');
    expect(JSON.parse(text).bookId).toBe(primary.runtime.store.workbook.bookId);

    const sync = await fetch(base + '/desktop/sync/status', { headers: withToken() }).then((response) => response.json());
    expect(sync.key).toBe(engine.key);
  });

  it('parses an uploaded student workbook without importing it', async () => {
    const response = await fetch(base + '/desktop/parse-students', {
      method: 'POST',
      headers: withToken({ 'content-type': 'application/octet-stream' }),
      body: sampleXlsx()
    });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.count).toBe(2);
    expect(data.students[0].id).toBe('STU-4001');
    expect(primary.runtime.store.workbook.sheets.Students).toHaveLength(4);
  });

  it('recovers the supervisor password with a one-time temporary password', async () => {
    const recovered = await primary.runtime.recoverAdmin();
    expect(recovered.username).toBe(account.username);
    expect(recovered.temporaryPassword).toMatch(/^Aa!/);

    const oldLogin = await fetch(base + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'login',
        token: '',
        payload: { username: account.username, password: account.temporaryPassword }
      })
    }).then((response) => response.json());
    expect(oldLogin.success).toBe(false);

    const login = await fetch(base + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'login',
        token: '',
        payload: { username: recovered.username, password: recovered.temporaryPassword }
      })
    }).then((response) => response.json());
    expect(login.success, JSON.stringify(login)).toBe(true);
    expect(login.data.user.mustChange).toBe(true);
    // استعادة كلمة المرور تُبطل الجلسات السابقة؛ نستخدم جلسة المشرف الجديدة.
    adminToken = login.data.token;
  });

  it('requires an admin session for every desktop route', async () => {
    for (const route of ['/desktop/status', '/desktop/database', '/desktop/sync/status', '/desktop/backup/status']) {
      const denied = await fetch(base + route);
      expect(denied.status, route).toBe(401);
    }
    const wrongToken = await fetch(base + '/desktop/status', { headers: { 'x-session-token': 'x'.repeat(40) } });
    expect(wrongToken.status).toBe(401);

    const allowed = await fetch(base + '/desktop/status', { headers: withToken() });
    expect(allowed.status).toBe(200);
  });

  it('rejects DNS-rebinding Host headers and cross-origin requests', async () => {
    const rebound = await rawRequest(base + '/setup/status', { headers: { host: 'evil.example' } });
    expect(rebound.status).toBe(403);

    const crossOrigin = await rawRequest(base + '/setup/status', { headers: { origin: 'http://evil.example' } });
    expect(crossOrigin.status).toBe(403);

    const crossSite = await rawRequest(base + '/setup/status', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await rawRequest(base + '/setup/status', { headers: { origin: base, host: new URL(base).host } });
    expect(sameOrigin.status).toBe(200);
  });

  it('sends security hardening headers with app responses', async () => {
    const response = await fetch(base + '/');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
  });

  it('never exposes sync keys through discovery or setup peers', async () => {
    const discovery = new Discovery({ deviceId: 'device-a', name: 'A', port: 43118, logger: quietLogger() });
    const payload = JSON.parse(discovery.message());
    expect(payload.key).toBeUndefined();
    discovery.stop();

    engine.observePeer({
      deviceId: 'peer-test',
      name: 'جهاز مجاور',
      url: 'http://192.168.1.50:43118',
      key: 'SHOULD-NOT-BE-TRUSTED'
    });
    expect(engine.state.peers['peer-test'].key).toBe('');
    const data = await fetch(base + '/setup/peers').then((response) => response.json());
    const peer = data.peers.find((item) => item.id === 'peer-test');
    expect(peer).toBeTruthy();
    expect(peer.key).toBeUndefined();
    expect(peer.needsKey).toBe(true);

    const blocked = await engine.syncPeer(engine.state.peers['peer-test']);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('مفتاح');
  });

  it('rejects binary uploads that are not student workbooks', async () => {
    const response = await fetch(base + '/desktop/parse-students', {
      method: 'POST',
      headers: withToken({ 'content-type': 'application/octet-stream' }),
      body: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02])
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
  });

  it('allows only private LAN targets and blocks cloud metadata', () => {
    expect(privateAddress('192.168.1.10')).toBe(true);
    expect(privateAddress('10.0.0.5')).toBe(true);
    expect(privateAddress('172.20.1.4')).toBe(true);
    expect(privateAddress('127.0.0.1')).toBe(true);
    expect(privateAddress('::ffff:192.168.1.10')).toBe(true);
    expect(privateAddress('8.8.8.8')).toBe(false);
    expect(privateAddress('169.254.169.254')).toBe(false);
    expect(privateAddress('169.254.170.2')).toBe(false);
    expect(privateAddress('100.100.100.200')).toBe(false);
    expect(privateAddress('fd00:ec2::254')).toBe(false);
  });

  it('rejects unknown paths with a JSON error', async () => {
    const response = await fetch(base + '/nothing-here');
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
  });
});

describe('server guards', () => {
  it('returns SETUP_REQUIRED from /api before installation', async () => {
    const dir = tempDir('sa-uninstalled-');
    const runtime = createRuntime({ dataDir: dir });
    const freshEngine = new SyncEngine({
      dataDir: dir,
      store: runtime.store,
      runtime,
      logger: quietLogger(),
      deviceName: runtime.store.meta.deviceName
    });
    const freshBackup = new BackupManager({
      dataDir: dir,
      store: runtime.store,
      runtime,
      logger: quietLogger(),
      secrets: new Secrets(dir, { safeStorage: null }),
      deviceName: runtime.store.meta.deviceName,
      deviceId: freshEngine.deviceId
    });
    const freshServer = new AppServer({
      runtime,
      engine: freshEngine,
      backup: freshBackup,
      logger: quietLogger(),
      dataDir: dir,
      appVersion: '3.6.0'
    });
    try {
      const port = await freshServer.listen(0);
      const response = await fetch('http://127.0.0.1:' + port + '/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ping', payload: {} })
      });
      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.code).toBe('SETUP_REQUIRED');
    } finally {
      await freshServer.close();
      cleanup(dir);
    }
  });

  it('recognizes only loopback addresses', () => {
    expect(isLoopback({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(isLoopback({ socket: { remoteAddress: '::1' } })).toBe(true);
    expect(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
    expect(isLoopback({ socket: { remoteAddress: '192.168.1.20' } })).toBe(false);
  });

  it('compares sync keys without leaking length information', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});
