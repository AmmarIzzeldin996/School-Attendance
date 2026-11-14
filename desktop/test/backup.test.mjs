import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { BackupManager } from '../backup/manager.js';
import { Secrets } from '../lib/secrets.js';
import { validateCredentials, validateUserAuth } from '../backup/google.js';
import { installRuntime, quietLogger, cleanup, tempDir } from './helpers.js';

const dirs = [];

async function setup() {
  const primary = await installRuntime();
  dirs.push(primary.dataDir);
  const secrets = new Secrets(primary.dataDir, { safeStorage: null });
  const backup = new BackupManager({
    dataDir: primary.dataDir,
    store: primary.runtime.store,
    runtime: primary.runtime,
    logger: quietLogger(),
    secrets,
    deviceName: primary.runtime.store.meta.deviceName,
    deviceId: primary.runtime.store.meta.deviceId
  });
  return { primary, secrets, backup };
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('backup manager', () => {
  it('creates a verified local backup plus JSON and XLSX exports without cloud credentials', async () => {
    const { primary, backup } = await setup();
    expect(backup.status().configured).toBe(false);

    const result = await backup.runNow('test');
    expect(result.ok).toBe(true);
    expect(result.cloud).toBeNull();
    expect(result.local.counts.students).toBe(3);
    expect(result.local.jsonName).toMatch(/^attendance-[a-f0-9]+-\d{8}-\d{6}\.json$/);

    const exportDir = path.join(primary.dataDir, 'backups', 'exports');
    const json = path.join(exportDir, result.local.jsonName);
    const xlsx = path.join(exportDir, result.local.xlsxName);
    expect(fs.existsSync(json)).toBe(true);
    expect(fs.existsSync(xlsx)).toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(snapshot.format).toBe('school-attendance-backup');
    expect(snapshot.tables.Students).toHaveLength(3);

    const book = XLSX.read(fs.readFileSync(xlsx), { type: 'buffer' });
    const students = XLSX.utils.sheet_to_json(book.Sheets['الطلاب'], { header: 1 });
    expect(students[1][0]).toBe('STU-1001');
    expect(book.SheetNames).toContain('الحضور');

    const status = backup.status();
    expect(status.state.lastSuccessAt).toBeTruthy();
    expect(status.state.lastError).toBe('');
    expect(status.state.lastFile).toBeTruthy();
  });

  it('reports not configured instead of attempting a cloud upload', async () => {
    const { backup } = await setup();
    expect(await backup.tick()).toEqual({ skipped: 'not_configured' });
    await expect(backup.importLatest()).rejects.toThrow(/بيانات حساب خدمة/);
  });

  it('stores and removes service account credentials without network calls', async () => {
    const { backup } = await setup();
    const credentials = {
      project_id: 'demo-project',
      client_email: 'backup@demo-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'
    };
    const info = backup.saveCredentials(JSON.stringify(credentials));
    expect(info.present).toBe(true);
    expect(backup.status().configured).toBe(true);
    expect(backup.status().credentials.clientEmail).toBe(credentials.client_email);

    backup.removeCredentials();
    expect(backup.status().configured).toBe(false);
    expect(() => backup.saveCredentials('{bad json')).toThrow(/JSON/);
  });

  it('normalizes backup configuration and export retention', async () => {
    const { primary, backup } = await setup();
    const status = backup.configure({
      enabled: true,
      auto: false,
      folderName: 'مجلد الاختبار',
      spreadsheetName: 'جدول الاختبار'
    });
    expect(status.config.folderName).toBe('مجلد الاختبار');
    expect(status.config.auto).toBe(false);

    // أنشئ ملفات تصدير قديمة وتأكد أن التقليم يبقي الحد الأدنى.
    const exportDir = path.join(primary.dataDir, 'backups', 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(exportDir, 'attendance-dev-2026010' + index + '-000000.json'), '{}');
      fs.writeFileSync(path.join(exportDir, 'attendance-dev-2026010' + index + '-000000.xlsx'), 'x');
    }
    const before = fs.readdirSync(exportDir).length;
    const removed = backup.pruneExports(2);
    expect(removed).toBeGreaterThan(0);
    expect(fs.readdirSync(exportDir).length).toBeLessThan(before);
  });

  it('validates service account key files before use', () => {
    expect(() => validateCredentials(null)).toThrow();
    expect(() => validateCredentials({ project_id: 'x' })).toThrow(/client_email/);
    expect(() => validateCredentials({
      project_id: 'x', client_email: 'a@b.c', private_key: 'no pem header'
    })).toThrow(/المفتاح الخاص/);
    const clean = validateCredentials({
      project_id: 'x', client_email: 'a@b.c', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
    });
    expect(clean.token_uri).toContain('oauth2');
  });

  it('prepares a Google user link with PKCE without network calls', async () => {
    const { backup } = await setup();
    expect(backup.status().userAuth.linked).toBe(false);
    expect(() => backup.saveUserClient({ client_id: 'not-a-client' })).toThrow(/apps\.googleusercontent/);

    backup.saveUserClient({
      installed: { client_id: 'demo.apps.googleusercontent.com', client_secret: 'desktop-secret' }
    });
    expect(backup.status().userAuth.present).toBe(true);

    const started = await backup.startUserAuth();
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('scope')).toContain('drive.file');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    backup.pendingAuth.close();

    backup.removeUserAuth();
    expect(backup.status().userAuth.present).toBe(false);
  });

  it('refreshes the linked user token with the stored refresh token', async () => {
    const { backup } = await setup();
    backup.saveUserClient({ installed: { client_id: 'demo.apps.googleusercontent.com', client_secret: 's' } });
    backup.userAuth.secrets.save(validateUserAuth({
      client_id: 'demo.apps.googleusercontent.com',
      refresh_token: 'refresh-1',
      email: 'owner@example.com'
    }));
    let body = '';
    backup.userAuth.fetchImpl = async (url, options) => {
      body = String(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'access-1', expires_in: 3600 }) };
    };
    const token = await backup.userAuth.client().accessToken();
    expect(token).toBe('access-1');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-1');
    expect(backup.status().userAuth.linked).toBe(true);
    expect(backup.status().userAuth.email).toBe('owner@example.com');
  });

  it('stores the refresh token and email returned by the code exchange', async () => {
    const { backup } = await setup();
    backup.saveUserClient({ installed: { client_id: 'demo.apps.googleusercontent.com', client_secret: 's' } });
    const claims = Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url');
    backup.userAuth.fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        id_token: 'header.' + claims + '.signature'
      })
    });
    const info = await backup.userAuth.exchange('code-1', 'http://127.0.0.1:5555', 'verifier-1');
    expect(info.linked).toBe(true);
    expect(info.email).toBe('owner@example.com');
    backup.removeUserAuth();
    expect(backup.userAuth.info().linked).toBe(false);
  });
});
