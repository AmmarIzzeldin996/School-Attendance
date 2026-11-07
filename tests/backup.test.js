import { describe, it, expect } from 'vitest';
import { setup, ok, fail, okAs, failAs, createUser, loginAs } from './harness.mjs';

const STUDENTS = [
  { id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', phone: '0511111111' },
  { id: '1002', name: 'سعود علي', classroom: 'الصف الأول', phone: '0522222222' },
  { id: '1003', name: 'فهد سالم', classroom: 'الصف الثاني', phone: '0533333333' }
];

function base(extra = {}) {
  return setup({
    students: STUDENTS,
    drivers: [{ code: '9001', name: 'سائق الاختبار', area: 'حي النور', students: ['1001'] }],
    ...extra
  });
}

function backupPayload(app, id) {
  return JSON.parse(app.files.get(id).content);
}

describe('backup and restore', () => {
  it('creates a verifiable snapshot with counts and status information', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-backup-create-1');
    ok(app, 'closeDay', {}, 'req-backup-create-2');

    const backup = ok(app, 'createBackup', {}, 'req-backup-create-3');
    expect(backup.id).toBeTruthy();
    expect(backup.url).toContain(backup.id);
    expect(backup.counts).toMatchObject({ students: 3, records: 3, days: 1, trips: 0 });
    expect(backup.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(app.props.get('LAST_BACKUP')).toBe(backup.createdAt);
    expect(app.call('readTable_', 'Audit').some((row) => row.action === 'نسخة احتياطية')).toBe(true);

    const status = ok(app, 'getBackupStatus', {});
    expect(status.lastSuccess).toBe(backup.createdAt);
    expect(status.files.map((file) => file.id)).toContain(backup.id);
    expect(status.triggerActive).toBe(true);

    const preview = ok(app, 'previewRestore', { id: backup.id });
    expect(preview).toMatchObject({ students: 3, records: 3, days: 1, drivers: 1, cards: 0, trips: 0 });
    expect(preview.createdAt).toBe(backup.createdAt);

    const payload = backupPayload(app, backup.id);
    expect(payload.format).toBe('school-attendance-backup');
    expect(payload.version).toBe(6);
    expect(payload.accounts.length).toBeGreaterThanOrEqual(1);
    expect(payload.settings.systemName).toBeTruthy();
    expect(JSON.stringify(payload)).not.toContain('passwordHash');
  });

  it('restores a verified snapshot after confirmation and keeps a safety copy', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-backup-restore-1');
    ok(app, 'closeDay', {}, 'req-backup-restore-2');

    const settings = ok(app, 'getSettings', {});
    settings.lateAfter = '07:00';
    settings.autoBackup = false;
    ok(app, 'saveSettings', { settings });

    const backup = ok(app, 'createBackup', {}, 'req-backup-restore-3');
    const filesBefore = ok(app, 'getBackupStatus', {}).files.length;

    settings.lateAfter = '09:00';
    settings.autoBackup = true;
    ok(app, 'saveSettings', { settings });
    ok(app, 'saveStudent', {
      id: '1004', name: 'ناصر عبدالله', classroom: 'الصف الثاني', phone: '0544444444', active: true
    });

    expect(fail(app, 'restoreBackup', { id: backup.id }, 'req-backup-restore-4').code).toBe('VALIDATION');
    expect(fail(app, 'restoreBackup', { id: backup.id, confirmation: 'نعم' }, 'req-backup-restore-5').code).toBe('VALIDATION');
    expect(fail(app, 'previewRestore', { id: 'file-missing' }).code).toBe('NOT_FOUND');

    const restored = ok(app, 'restoreBackup', {
      id: backup.id, confirmation: 'استعادة'
    }, 'req-backup-restore-6');
    expect(restored.counts).toMatchObject({ students: 3, records: 3, days: 1 });
    expect(restored.safetyUrl).toBeTruthy();

    expect(ok(app, 'getStudents', {}).map((student) => student.id)).toEqual(['1001', '1002', '1003']);
    const day = ok(app, 'getDay', {});
    expect(day.records).toHaveLength(3);
    expect(day.records.find((record) => record.id === '1001').inAt).toBeTruthy();
    expect(day.day.closed).toBe(true);

    const after = ok(app, 'getSettings', {});
    expect(after.lateAfter).toBe('07:00');
    expect(after.autoBackup).toBe(true);
    expect(after.supervisors).toEqual(settings.supervisors);

    const files = ok(app, 'getBackupStatus', {}).files;
    expect(files.length).toBeGreaterThanOrEqual(filesBefore + 1);
    const audit = ok(app, 'getAudit', { limit: 100 });
    expect(audit.some((entry) => entry.action === 'استعادة نسخة احتياطية')).toBe(true);
    expect(audit.find((entry) => entry.action === 'استعادة نسخة احتياطية').details).toContain('نسخة الأمان');
  });

  it('rejects corrupted, incompatible, and internally inconsistent snapshots', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-backup-invalid-0');
    const backup = ok(app, 'createBackup', {}, 'req-backup-invalid-1');
    const original = backupPayload(app, backup.id);

    const broken = JSON.parse(JSON.stringify(original));
    broken.students = undefined;
    broken.tables.Students.push({ ...broken.tables.Students[0], name: 'اسم آخر' });
    app.files.get(backup.id).content = JSON.stringify(broken);
    expect(fail(app, 'previewRestore', { id: backup.id }).code).toBe('VALIDATION');

    const wrongVersion = JSON.parse(JSON.stringify(original));
    wrongVersion.version = 5;
    app.files.get(backup.id).content = JSON.stringify(wrongVersion);
    expect(fail(app, 'previewRestore', { id: backup.id }).code).toBe('VALIDATION');

    const wrongFormat = JSON.parse(JSON.stringify(original));
    wrongFormat.format = 'other';
    app.files.get(backup.id).content = JSON.stringify(wrongFormat);
    expect(fail(app, 'previewRestore', { id: backup.id }).code).toBe('VALIDATION');

    const badAttendance = JSON.parse(JSON.stringify(original));
    badAttendance.tables.Attendance[0].outAt = '2020-01-01T00:00:00+03:00';
    badAttendance.tables.Attendance[0].inAt = '';
    app.files.get(backup.id).content = JSON.stringify(badAttendance);
    expect(fail(app, 'previewRestore', { id: backup.id }).code).toBe('VALIDATION');

    const badCard = JSON.parse(JSON.stringify(original));
    badCard.tables.Cards.push({
      card_id: 'card-x', type: 'STUDENT', owner_id: '1001', token_hash: 'not-a-hash',
      status: 'ACTIVE', issued_at: '', issued_by: '', revoked_at: '', revoked_by: '', last_used_at: '', note: ''
    });
    app.files.get(backup.id).content = JSON.stringify(badCard);
    expect(fail(app, 'previewRestore', { id: backup.id }).code).toBe('VALIDATION');

    app.files.get(backup.id).content = JSON.stringify(original);
    expect(ok(app, 'previewRestore', { id: backup.id }).students).toBe(3);
  });

  it('prunes old backup files while keeping at least two', () => {
    const app = base();
    const settings = ok(app, 'getSettings', {});
    settings.retention = 2;
    ok(app, 'saveSettings', { settings });

    const created = [];
    for (let index = 0; index < 4; index += 1) {
      const backup = ok(app, 'createBackup', {}, 'req-backup-prune-0' + index);
      app.files.get(backup.id).created = new Date(Date.now() - (4 - index) * 1000);
      created.push(backup);
    }
    const active = ok(app, 'getBackupStatus', {}).files;
    expect(active).toHaveLength(2);
    expect(active.map((file) => file.id).sort()).toEqual(created.slice(2).map((backup) => backup.id).sort());

    const trashed = [...app.files.values()].filter((file) => file.name.startsWith('attendance-') && file.trashed);
    expect(trashed).toHaveLength(2);
  });

  it('denies backup and restore actions to non-administrators', () => {
    const app = base();
    const backup = ok(app, 'createBackup', {}, 'req-backup-perm-1');
    const gate = createUser(app, { username: 'gate_backup', role: 'gate' });
    const gateToken = loginAs(app, gate.username, gate.password);

    expect(failAs(app, gateToken, 'createBackup', {}, 'req-backup-perm-2').code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'getBackupStatus', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'previewRestore', { id: backup.id }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'restoreBackup', {
      id: backup.id, confirmation: 'استعادة'
    }, 'req-backup-perm-3').code).toBe('PERMISSION_DENIED');
  });
});
