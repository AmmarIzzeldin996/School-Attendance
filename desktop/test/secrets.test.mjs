import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Secrets } from '../lib/secrets.js';
import { tempDir, cleanup } from './helpers.js';

const dirs = [];

function makeSecrets() {
  const dir = tempDir('sa-secrets-');
  dirs.push(dir);
  return new Secrets(dir, { safeStorage: null });
}

const credentials = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'backup@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA\n-----END PRIVATE KEY-----\n'
};

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('Secrets', () => {
  it('encrypts with AES-GCM when DPAPI is unavailable and round-trips', () => {
    const secrets = makeSecrets();
    expect(secrets.available()).toBe(false);
    const info = secrets.save(credentials);
    expect(info.present).toBe(true);
    expect(info.protectedBy).toContain('AES');
    expect(info.clientEmail).toBe(credentials.client_email);

    const raw = readFileSync(path.join(secrets.dir, 'service-account.enc'), 'utf8');
    expect(raw).not.toContain(credentials.private_key);
    expect(JSON.parse(raw).mode).toBe('aes');

    const loaded = secrets.load();
    expect(loaded.client_email).toBe(credentials.client_email);
    expect(loaded.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('fails closed when the encrypted payload is tampered with', () => {
    const secrets = makeSecrets();
    secrets.save(credentials);
    const file = path.join(secrets.dir, 'service-account.enc');
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const bytes = Buffer.from(payload.data, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    payload.data = bytes.toString('base64');
    writeFileSync(file, JSON.stringify(payload));

    expect(() => secrets.load()).toThrow();
  });

  it('removes credentials and reports an empty state', () => {
    const secrets = makeSecrets();
    secrets.save(credentials);
    secrets.remove();
    expect(secrets.info().present).toBe(false);
    expect(secrets.load()).toBeNull();
  });

  it('rejects incomplete service account files', () => {
    const secrets = makeSecrets();
    expect(() => secrets.save({ project_id: 'x' })).toThrow();
    expect(() => secrets.save({ project_id: 'x', client_email: 'a@b.c', private_key: 'not-a-key' })).toThrow();
  });
});
