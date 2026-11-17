import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Updater, compareVersions, parseManifest } from '../update/updater.js';
import { tempDir, cleanup, quietLogger } from './helpers.js';

const dirs = [];

function makeUpdater(overrides) {
  const dir = tempDir('update-');
  dirs.push(dir);
  return new Updater(Object.assign({
    currentVersion: '3.6.0',
    downloadDir: dir,
    logger: quietLogger()
  }, overrides || {}));
}

const goodManifest = {
  version: '3.6.1',
  url: 'https://github.com/acme/sa/releases/download/v3.6.1/School-Attendance-Setup-3.6.1-x64.exe',
  notes: 'n',
  sha256: ''
};

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('update manifest', () => {
  it('compares numeric versions only', () => {
    expect(compareVersions('3.6.1', '3.6.0')).toBe(1);
    expect(compareVersions('3.10.0', '3.9.9')).toBe(1);
    expect(compareVersions('3.6.0', '3.6.0')).toBe(0);
    expect(compareVersions('3.5.9', '3.6.0')).toBe(-1);
  });

  it('accepts a valid https exe manifest and flags newer versions', () => {
    const manifest = parseManifest(goodManifest, '3.6.0');
    expect(manifest.newer).toBe(true);
    expect(manifest.name).toBe('School-Attendance-Setup-3.6.1-x64.exe');
    expect(parseManifest(goodManifest, '3.6.1').newer).toBe(false);
  });

  it('rejects insecure or malformed manifests', () => {
    expect(() => parseManifest(null, '3.6.0')).toThrow();
    expect(() => parseManifest({ version: 'next', url: goodManifest.url }, '3.6.0')).toThrow(/إصدار/);
    expect(() => parseManifest({ version: '3.6.1', url: 'http://x/a.exe' }, '3.6.0')).toThrow(/https/);
    expect(() => parseManifest({ version: '3.6.1', url: 'https://x/a.html' }, '3.6.0')).toThrow(/exe/);
    expect(() => parseManifest({ version: '3.6.1', url: goodManifest.url, sha256: 'zz' }, '3.6.0')).toThrow(/sha256/);
  });
});

describe('updater', () => {
  it('checks the manifest over https and caches the result', async () => {
    const updater = makeUpdater({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(goodManifest) })
    });
    const status = await updater.check();
    expect(status.error).toBe('');
    expect(status.available).toBe(true);
    expect(status.manifest.version).toBe('3.6.1');
    expect(updater.status().available).toBe(true);
  });

  it('reports fetch failures without throwing', async () => {
    const updater = makeUpdater({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
    const status = await updater.check();
    expect(status.available).toBe(false);
    expect(status.error).toContain('404');
  });

  it('downloads to the updates folder and verifies sha256', async () => {
    const body = Buffer.from('installer-bytes');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const updater = makeUpdater({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(
        Object.assign({}, goodManifest, { sha256: sha })
      ), arrayBuffer: async () => { const ab = new ArrayBuffer(body.length); new Uint8Array(ab).set(body); return ab; } })
    });
    await updater.check();
    const status = await updater.download();
    expect(status.downloaded).toMatch(/School-Attendance-Setup-3\.6\.1-x64\.exe$/);
    expect(fs.readFileSync(status.downloaded, 'utf8')).toBe('installer-bytes');
  });

  it('refuses a file whose hash does not match and refuses download without a newer release', async () => {
    const updater = makeUpdater({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(
        Object.assign({}, goodManifest, { sha256: '0'.repeat(64) })
      ), arrayBuffer: async () => new Uint8Array(Buffer.from('evil').length).buffer })
    });
    await updater.check();
    await expect(updater.download()).rejects.toThrow(/sha256/);

    const fresh = makeUpdater({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }) });
    await expect(fresh.download()).rejects.toThrow(/لا يوجد تحديث/);
  });
});
