import { describe, it, expect, afterEach, vi } from 'vitest';
import { BackupManager } from '../backup/manager.js';
import { Secrets } from '../lib/secrets.js';
import { WebAppClient, validateCloudConfig } from '../backup/webapp.js';
import { installRuntime, quietLogger, cleanup } from './helpers.js';

const dirs = [];
const URL = 'https://script.google.com/macros/s/AKfycbx-test-script-id/exec';
const SECRET = 'cloud-secret-1234567890-abcdef';

function envelope(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, code: 'SUCCESS', message: '', data })
  };
}

function stubFetch(handler) {
  vi.stubGlobal('fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    expect(url).toBe(URL);
    expect(body.secret).toBe(SECRET);
    expect(options.method).toBe('POST');
    return envelope(handler(body.action, body.payload));
  });
}

async function setup() {
  const primary = await installRuntime();
  dirs.push(primary.dataDir);
  const backup = new BackupManager({
    dataDir: primary.dataDir,
    store: primary.runtime.store,
    runtime: primary.runtime,
    logger: quietLogger(),
    secrets: new Secrets(primary.dataDir, { safeStorage: null }),
    deviceName: primary.runtime.store.meta.deviceName,
    deviceId: primary.runtime.store.meta.deviceId
  });
  return { primary, backup };
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop());
});

describe('Web App backup client', () => {
  it('accepts only published script URLs and a real secret', () => {
    expect(() => validateCloudConfig({ url: 'http://localhost/exec', secret: SECRET })).toThrow(/Web App/);
    expect(() => validateCloudConfig({ url: URL, secret: 'short' })).toThrow(/16/);
    expect(validateCloudConfig({ url: ' ' + URL + ' ', secret: SECRET })).toEqual({ url: URL, secret: SECRET });
    expect(validateCloudConfig({ url: 'https://script.googleusercontent.com/macros/s/abc/exec', secret: SECRET }).url)
      .toContain('script.googleusercontent.com');
  });

  it('sends the restricted actions and unwraps the JSON envelope', async () => {
    const calls = [];
    stubFetch((action, payload) => { calls.push({ action, payload }); return { count: 2 }; });
    const client = new WebAppClient({ url: URL, secret: SECRET });
    expect(await client.list()).toEqual({ count: 2 });
    await client.put({ format: 'school-attendance-backup' });
    await client.get('file-1');
    expect(calls.map((call) => call.action)).toEqual(['cloudBackupList', 'cloudBackupPut', 'cloudBackupGet']);
    expect(calls[2].payload).toEqual({ id: 'file-1' });

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: false, code: 'FORBIDDEN', message: 'كلمة النسخ غير صحيحة.' })
    }));
    await expect(client.list()).rejects.toThrow(/كلمة النسخ/);
  });

  it('saves the URL and secret encrypted, uploads, then imports the newest archive', async () => {
    const { primary, backup } = await setup();
    const snapshot = primary.runtime.snapshot();
    stubFetch((action) => {
      if (action === 'cloudBackupList') {
        return [{ id: 'f1', name: 'cloud-attendance-old.json', createdAt: '2026-01-01T00:00:00.000Z', size: 100 }];
      }
      if (action === 'cloudBackupPut') {
        return { id: 'f2', name: 'cloud-attendance-new.json', url: 'https://drive.google.com/file/d/f2', size: 100, pruned: 0 };
      }
      if (action === 'cloudBackupGet') {
        return { id: 'f1', name: 'cloud-attendance-old.json', text: JSON.stringify(snapshot), createdAt: '2026-01-01T00:00:00.000Z' };
      }
      throw new Error('unexpected action ' + action);
    });

    const saved = await backup.saveCloudConfig({ url: URL, secret: SECRET, test: true });
    expect(saved.test.count).toBe(1);
    expect(saved.status.cloud.present).toBe(true);
    expect(saved.status.cloud.url).toBe(URL);
    expect(backup.cloudSecrets.load()).toEqual({ url: URL, secret: SECRET });

    const run = await backup.runNow('test');
    expect(run.cloud.archiveMode).toBe('script-drive');
    expect(run.cloud.json.name).toBe('cloud-attendance-new.json');
    expect(backup.status().state.lastCloudFile).toBe('f2');

    const imported = await backup.importLatest();
    expect(imported.name).toBe('cloud-attendance-old.json');
    expect(imported.archiveMode).toBe('script-drive');
    expect(primary.runtime.store.readFile(imported.id)).toBe(JSON.stringify(snapshot));
    const status = await primary.runtime.callInternal('getBackupStatus_', []);
    expect(status.files.some((file) => file.id === imported.id && file.name === 'attendance-old.json')).toBe(true);
  });
});
