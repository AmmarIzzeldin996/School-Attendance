import { describe, it, expect } from 'vitest';
import { setup, ok, fail, okAs, failAs, createUser, loginAs } from './harness.mjs';

const STUDENTS = [
  { id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', phone: '0511111111', active: true },
  { id: '1002', name: 'سعود علي', classroom: 'الصف الأول', phone: '0522222222', active: true },
  { id: '1003', name: 'فهد سالم', classroom: 'الصف الثاني', phone: '0533333333', active: true }
];

function base() {
  return setup({
    students: STUDENTS,
    drivers: [{ code: '9001', name: 'سائق الاختبار', students: ['1001'] }]
  });
}

function sheetValues(app, name) {
  const sheet = app.activeBook.getSheetByName(name);
  return sheet.getRows ? sheet.getRows() : null;
}

describe('cards', () => {
  it('issues an opaque token, stores only its keyed hash, and never returns it again', () => {
    const app = base();
    const issued = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(issued.card.ownerName).toContain('أحمد محمد');
    expect(issued.revoked).toBe(0);

    const rows = app.call('readTable_', 'Cards');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(issued.token);
    expect(JSON.stringify(rows)).not.toContain(issued.token);

    const list = ok(app, 'getCards', {});
    expect(list).toHaveLength(1);
    expect(list[0].token).toBeUndefined();
    expect(list[0].tokenHash).toBeUndefined();
    expect(list[0].status).toBe('ACTIVE');
    expect(list[0].cardId).toBe(issued.card.cardId);
  });

  it('accepts a valid student card, trimmed whitespace, and rejects case changes', () => {
    const app = base();
    const issued = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });

    const scanned = ok(app, 'scanStudent', { mode: 'in', input: issued.token }, 'req-card-0001');
    expect(scanned.method).toBe('qr');
    expect(scanned.student.id).toBe('1001');

    const card = app.call('readTable_', 'Cards')[0];
    expect(card.last_used_at).toBeTruthy();

    const second = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1002' });
    const padded = ok(app, 'scanStudent', { mode: 'in', input: `  ${second.token}\t` }, 'req-card-0002');
    expect(padded.student.id).toBe('1002');

    const flipped = second.token.slice(0, -1) + (second.token.endsWith('A') ? 'B' : 'A');
    expect(fail(app, 'scanStudent', { mode: 'in', input: flipped }).code).toBe('INVALID_QR');
  });

  it('revokes the previous card when a replacement is issued', () => {
    const app = base();
    const first = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });
    const second = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001', note: 'بديلة' });
    expect(second.revoked).toBe(1);
    expect(second.token).not.toBe(first.token);

    const old = fail(app, 'scanStudent', { mode: 'in', input: first.token });
    expect(old.code).toBe('QR_REVOKED');
    const current = ok(app, 'scanStudent', { mode: 'in', input: second.token }, 'req-replace-001');
    expect(current.student.id).toBe('1001');

    const cards = ok(app, 'getCards', {});
    expect(cards.filter((card) => card.status === 'ACTIVE')).toHaveLength(1);
    expect(cards.filter((card) => card.status === 'REVOKED')).toHaveLength(1);
  });

  it('revokes cards explicitly and treats repeated revocation as idempotent', () => {
    const app = base();
    const issued = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });
    const revoked = ok(app, 'revokeCard', { cardId: issued.card.cardId, reason: 'فقدان البطاقة' });
    expect(revoked.revoked).toBe(true);
    expect(ok(app, 'revokeCard', { cardId: issued.card.cardId }).alreadyRevoked).toBe(true);
    expect(fail(app, 'scanStudent', { mode: 'in', input: issued.token }).code).toBe('QR_REVOKED');
    expect(fail(app, 'revokeCard', { cardId: 'missing-card' }).code).toBe('NOT_FOUND');
  });

  it('enforces card type on every path', () => {
    const app = base();
    const driverCard = ok(app, 'issueCard', { type: 'DRIVER', ownerId: '9001' });
    const userCard = ok(app, 'issueCard', { type: 'USER', ownerId: app.user.id });
    const studentCard = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });

    expect(fail(app, 'scanStudent', { mode: 'in', input: driverCard.token }).code).toBe('WRONG_CARD_TYPE');
    expect(fail(app, 'scanStudent', { mode: 'in', input: userCard.token }).code).toBe('WRONG_CARD_TYPE');
    expect(fail(app, 'openTrip', { mode: 'in', driver: studentCard.token }).code).toBe('WRONG_CARD_TYPE');
    expect(fail(app, 'loginCard', { token: studentCard.token }).code).toBe('WRONG_CARD_TYPE');

    const viaDriverCard = ok(app, 'openTrip', { mode: 'in', driver: driverCard.token }, 'req-driver-card-1');
    expect(viaDriverCard.trip.driverCode).toBe('9001');
  });

  it('rejects cards and manual ids for inactive owners', () => {
    const app = base();
    const issued = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1002' });
    const students = ok(app, 'getStudents', {});
    const student = students.find((item) => item.id === '1002');
    ok(app, 'saveStudent', { ...student, originalId: student.id, active: false });

    expect(fail(app, 'scanStudent', { mode: 'in', input: issued.token }).code).toBe('OWNER_INACTIVE');
    expect(fail(app, 'scanStudent', { mode: 'in', input: '1002', reason: 'اختبار' }).code).toBe('OWNER_INACTIVE');
  });

  it('supports manual ids, Arabic digits, and rejects unknown values', () => {
    const app = base();
    const missingReason = fail(app, 'scanStudent', { mode: 'in', input: '1001' });
    expect(missingReason.code).toBe('VALIDATION');

    const manual = ok(app, 'scanStudent', { mode: 'in', input: '١٠٠١', reason: 'قارئ لا يعمل' }, 'req-manual-0001');
    expect(manual.method).toBe('manual');
    expect(manual.student.id).toBe('1001');

    expect(fail(app, 'scanStudent', { mode: 'in', input: '9999', reason: 'اختبار' }).code).toBe('STUDENT_NOT_FOUND');
    expect(fail(app, 'scanStudent', { mode: 'in', input: 'A'.repeat(45) }).code).toBe('INVALID_QR');
  });

  it('accepts printed 3.5 student codes (STU-…) and Code128 delimiters without a manual reason', () => {
    const app = setup({
      students: [
        { id: 'STU-2001', name: 'طالب قديم', classroom: 'الثالث', active: true },
        { id: '2002', name: 'طالب جديد', classroom: 'الثالث', active: true }
      ]
    });
    const legacy = ok(app, 'scanStudent', { mode: 'in', input: 'STU-2001' }, 'req-legacy-0001');
    expect(legacy.method).toBe('qr');
    expect(legacy.student.id).toBe('STU-2001');

    const mapped = ok(app, 'scanStudent', { mode: 'in', input: '*STU-2002*' }, 'req-legacy-0002');
    expect(mapped.method).toBe('qr');
    expect(mapped.student.id).toBe('2002');

    expect(fail(app, 'scanStudent', { mode: 'in', input: 'STU-9999' }).code).toBe('STUDENT_NOT_FOUND');
  });

  it('limits driver cards to driver managers and user cards to the primary admin', () => {
    const app = base();
    const registrar = createUser(app, { username: 'reg_cards', role: 'registrar' });
    const token = loginAs(app, registrar.username, registrar.password);

    const studentCard = okAs(app, token, 'issueCard', { type: 'STUDENT', ownerId: '1001' });
    expect(studentCard.token).toBeTruthy();
    expect(failAs(app, token, 'issueCard', { type: 'DRIVER', ownerId: '9001' }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, token, 'issueCard', { type: 'USER', ownerId: app.user.id }).code).toBe('PERMISSION_DENIED');

    const gate = createUser(app, { username: 'gate_cards', role: 'gate' });
    const gateToken = loginAs(app, gate.username, gate.password);
    expect(failAs(app, gateToken, 'issueCard', { type: 'STUDENT', ownerId: '1002' }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'getCards', {}).code).toBe('PERMISSION_DENIED');
  });

  it('gives user cards a full login session and revokes them on replacement', () => {
    const app = base();
    const first = ok(app, 'issueCard', { type: 'USER', ownerId: app.user.id });
    const login1 = app.api('', 'loginCard', { token: first.token });
    expect(login1.success, JSON.stringify(login1)).toBe(true);
    expect(login1.data.user.id).toBe(app.user.id);

    const second = ok(app, 'issueCard', { type: 'USER', ownerId: app.user.id });
    expect(failAs(app, '', 'loginCard', { token: first.token }).code).toBe('QR_REVOKED');
    const login2 = app.api('', 'loginCard', { token: second.token });
    expect(login2.success).toBe(true);
  });

  it('records rejected card attempts in the audit log', () => {
    const app = base();
    const issued = ok(app, 'issueCard', { type: 'STUDENT', ownerId: '1001' });
    ok(app, 'revokeCard', { cardId: issued.card.cardId });
    fail(app, 'scanStudent', { mode: 'in', input: issued.token });
    fail(app, 'scanStudent', { mode: 'in', input: 'unknown-token-value-1234567890' });

    const audit = ok(app, 'getAudit', { limit: 100 });
    const rejected = audit.filter((row) => row.action === 'محاولة مسح بطاقة مرفوضة');
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected.some((row) => row.result === 'FAIL' && row.reason === 'QR_REVOKED')).toBe(true);
    expect(rejected.some((row) => row.result === 'FAIL' && row.reason === 'INVALID_QR')).toBe(true);
  });
});
