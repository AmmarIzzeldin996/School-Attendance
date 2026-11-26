// imperative cloud archive: doPost is a closed endpoint, separate from api().
import { describe, it, expect } from 'vitest';
import { setup } from './harness.mjs';

function post(app, body) {
  const output = app.sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
  expect(output.mimeType).toBe('application/json');
  return JSON.parse(output.text);
}

function cloud(app, secret, action, payload = {}) {
  return post(app, { action, secret, payload });
}

describe('cloud backup Web App endpoint', () => {
  it('allows only the three cloud actions and requires the independent secret', () => {
    const app = setup();
    const secret = app.call('getCloudBackupSecret');
    expect(secret.length).toBeGreaterThan(30);
    expect(app.props.get('CLOUD_BACKUP_SECRET')).toBe(secret);

    const listed = cloud(app, secret, 'cloudBackupList');
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual([]);

    expect(cloud(app, 'wrong', 'cloudBackupList').code).toBe('FORBIDDEN');
    expect(cloud(app, secret, 'installSchool').code).toBe('UNKNOWN_ACTION');
    expect(cloud(app, secret, 'createBackup').code).toBe('UNKNOWN_ACTION');
    expect(cloud(app, secret, 'CloudBackupList').code).toBe('UNKNOWN_ACTION');
    expect(post(app, { action: 'cloudBackupList', secret, payload: [] }).code).toBe('BAD_REQUEST');
    expect(post(app, { action: 'cloudBackupList', secret, payload: {} }).data).toEqual([]);
    expect(listed.data.join(' ')).not.toContain(secret);
  });

  it('stores validated snapshots, downloads them, and keeps only ten files', () => {
    const app = setup();
    const secret = app.call('getCloudBackupSecret');
    const snapshot = app.call('snapshot_');

    const put = cloud(app, secret, 'cloudBackupPut', { snapshot });
    expect(put.success).toBe(true);
    expect(put.data.name).toMatch(/^cloud-attendance-.*\.json$/);
    expect(put.data.size).toBeGreaterThan(100);

    const listed = cloud(app, secret, 'cloudBackupList').data;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(put.data.id);

    const got = cloud(app, secret, 'cloudBackupGet', { id: put.data.id });
    expect(JSON.parse(got.data.text)).toEqual(snapshot);
    expect(cloud(app, secret, 'cloudBackupGet', { id: 'file-999' }).code).toBe('NOT_FOUND');

    for (let index = 0; index < 11; index += 1) {
      expect(cloud(app, secret, 'cloudBackupPut', { snapshot }).success).toBe(true);
    }
    const remaining = cloud(app, secret, 'cloudBackupList').data;
    expect(remaining).toHaveLength(10);
    expect(remaining.map((file) => file.id)).not.toContain(put.data.id);
    expect(cloud(app, secret, 'cloudBackupGet', { id: put.data.id }).code).toBe('NOT_FOUND');
    expect(cloud(app, secret, 'cloudBackupPut', { snapshot: { format: 'other' } }).success).toBe(false);
  });
});
