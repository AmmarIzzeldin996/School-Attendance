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
    drivers: [{ code: '9001', name: 'سائق الاختبار', area: 'حي النور', students: ['1001', '1002'] }],
    ...extra
  });
}

function itemOf(trip, id) {
  return trip.items.find((item) => item.id === id);
}

describe('trips', () => {
  it('opens a single in-trip draft per driver and day, then resumes it', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: 'DRV:9001' }, 'req-trip-open-0001');
    expect(opened.resumed).toBe(false);
    expect(opened.trip.status).toBe('DRAFT');
    expect(opened.trip.driverCode).toBe('9001');
    expect(opened.trip.items.map((item) => item.id)).toEqual(['1001', '1002']);
    expect(opened.trip.items.every((item) => item.state === 'pending')).toBe(true);
    expect(opened.trip.counts).toEqual({ total: 2, done: 0, absent: 0, pending: 2 });

    const resumed = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-open-0002');
    expect(resumed.resumed).toBe(true);
    expect(resumed.trip.id).toBe(opened.trip.id);
    expect(app.call('readTable_', 'Journeys')).toHaveLength(1);

    const listed = ok(app, 'getTrips', {});
    expect(listed).toHaveLength(1);
    expect(ok(app, 'getTrip', { tripId: opened.trip.id }).trip.id).toBe(opened.trip.id);
    expect(fail(app, 'getTrip', { tripId: 'missing-trip' }).code).toBe('NOT_FOUND');

    expect(fail(app, 'openTrip', { mode: 'sideways', driver: '9001' }).code).toBe('VALIDATION');
    expect(fail(app, 'openTrip', { mode: 'in', driver: '1234' }).code).toBe('VALIDATION');
    expect(fail(app, 'openTrip', { mode: 'in', driver: '9999' }).code).toBe('DRIVER_NOT_FOUND');
  });

  it('scans, marks guardian pickups, unscans, and rejects unrelated students', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-scan-0001');
    const tripId = opened.trip.id;

    const scanned = ok(app, 'scanTrip', {
      tripId, input: '1001', reason: 'قارئ معطل'
    }, 'req-trip-scan-0002');
    expect(scanned.trip.counts).toMatchObject({ total: 2, done: 1, pending: 1 });
    expect(itemOf(scanned.trip, '1001')).toMatchObject({ state: 'scanned', method: 'manual', at: expect.any(String) });

    const duplicate = ok(app, 'scanTrip', {
      tripId, input: '1001', reason: 'قارئ معطل'
    }, 'req-trip-scan-0003');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.trip.revision).toBe(scanned.trip.revision);

    const guardian = ok(app, 'scanTrip', {
      tripId, input: '1002', choice: 'guardian', reason: 'خرج مع ولي الأمر'
    }, 'req-trip-scan-0004');
    expect(itemOf(guardian.trip, '1002')).toMatchObject({ state: 'guardian', method: 'guardian' });

    const unscanned = ok(app, 'unscanTrip', { tripId, studentId: '1002' }, 'req-trip-scan-0005');
    expect(itemOf(unscanned.trip, '1002')).toMatchObject({ state: 'pending', method: '', at: '' });
    expect(unscanned.trip.counts).toMatchObject({ done: 1, pending: 1 });

    expect(fail(app, 'unscanTrip', { tripId, studentId: '1003' }, 'req-trip-scan-0006').code).toBe('NOT_FOUND');
    expect(fail(app, 'scanTrip', {
      tripId, input: '1003', reason: 'قارئ معطل'
    }, 'req-trip-scan-0007').code).toBe('PERMISSION_DENIED');
    expect(fail(app, 'scanTrip', { tripId, input: '1002' }, 'req-trip-scan-0008').code).toBe('VALIDATION');

    ok(app, 'scanTrip', { tripId, input: '1002', reason: 'قارئ معطل' }, 'req-trip-scan-0009');
    const duplicateAgain = ok(app, 'scanTrip', {
      tripId, input: '1002', reason: 'قارئ معطل'
    }, 'req-trip-scan-0010');
    expect(duplicateAgain.duplicate).toBe(true);
  });

  it('confirms a scanned trip once, applies attendance, and records trip details', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-confirm-01');
    const tripId = opened.trip.id;
    ok(app, 'scanTrip', { tripId, input: '1001', reason: 'اختبار' }, 'req-trip-confirm-02');
    ok(app, 'scanTrip', { tripId, input: '1002', choice: 'guardian', reason: 'اختبار' }, 'req-trip-confirm-03');

    const confirmed = ok(app, 'confirmTrip', { tripId }, 'req-trip-confirm-04');
    expect(confirmed.alreadyConfirmed).toBe(false);
    expect(confirmed.applied).toBe(2);
    expect(confirmed.trip.status).toBe('CONFIRMED');
    expect(confirmed.trip.confirmedAt).toBeTruthy();
    expect(confirmed.trip.confirmedBy).toBe(app.user.username);
    expect(confirmed.summary).toMatchObject({ total: 3, present: 2, pending: 1 });

    const day = ok(app, 'getDay', {});
    const first = day.records.find((record) => record.id === '1001');
    const second = day.records.find((record) => record.id === '1002');
    expect(first.status).toBe('present');
    expect(first.inMethod).toBe('manual');
    expect(first.inJourney).toBe(tripId);
    expect(second.inMethod).toBe('guardian');
    expect(day.records.find((record) => record.id === '1003').status).toBe('pending');

    const details = app.call('readTable_', 'TripDetails');
    expect(details).toHaveLength(2);
    expect(details.map((detail) => detail.student_id).sort()).toEqual(['1001', '1002']);
    expect(details.every((detail) => detail.trip_id === tripId && detail.applied_at)).toBe(true);

    const replay = ok(app, 'confirmTrip', { tripId }, 'req-trip-confirm-05');
    expect(replay.alreadyConfirmed).toBe(true);
    expect(app.call('readTable_', 'TripDetails')).toHaveLength(2);
    expect(app.call('readTable_', 'Attendance').filter((record) => record.inAt)).toHaveLength(2);

    const audit = ok(app, 'getAudit', { limit: 100 });
    expect(audit.filter((entry) => entry.action === 'تأكيد رحلة حضور')).toHaveLength(1);
    expect(audit.find((entry) => entry.action === 'تأكيد رحلة حضور').after).toContain('CONFIRMED');
  });

  it('refuses to confirm a draft without any scanned student', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-empty-0001');
    expect(fail(app, 'confirmTrip', { tripId: opened.trip.id }, 'req-trip-empty-0002').code).toBe('VALIDATION');
    expect(ok(app, 'getTrip', { tripId: opened.trip.id }).trip.status).toBe('DRAFT');
    expect(app.call('readTable_', 'TripDetails')).toHaveLength(0);
  });

  it('blocks confirmation when attendance changed outside the trip', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-conflict-01');
    const tripId = opened.trip.id;
    ok(app, 'scanTrip', { tripId, input: '1001', reason: 'اختبار' }, 'req-trip-conflict-02');
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'سجل قبل التأكيد' }, 'req-trip-conflict-03');

    const conflict = fail(app, 'confirmTrip', { tripId }, 'req-trip-conflict-04');
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.message).toContain('أحمد محمد');
    expect(ok(app, 'getTrip', { tripId }).trip.status).toBe('DRAFT');
    expect(app.call('readTable_', 'TripDetails')).toHaveLength(0);
  });

  it('opens and confirms an out-trip only for present students who have not departed', () => {
    const app = base();
    expect(fail(app, 'openTrip', { mode: 'out', driver: '9001' }, 'req-trip-out-0001').code).toBe('NOT_FOUND');

    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-trip-out-0002');
    ok(app, 'scanStudent', { mode: 'in', input: '1002', reason: 'اختبار' }, 'req-trip-out-0003');
    ok(app, 'scanStudent', { mode: 'out', input: '1002', reason: 'انصراف مبكر' }, 'req-trip-out-0004');

    const opened = ok(app, 'openTrip', { mode: 'out', driver: '9001' }, 'req-trip-out-0005');
    expect(opened.trip.items.map((item) => item.id)).toEqual(['1001']);
    ok(app, 'scanTrip', { tripId: opened.trip.id, input: '1001', reason: 'اختبار' }, 'req-trip-out-0006');
    const confirmed = ok(app, 'confirmTrip', { tripId: opened.trip.id }, 'req-trip-out-0007');
    expect(confirmed.applied).toBe(1);
    expect(confirmed.summary.out).toBe(2);
    expect(confirmed.summary.notOut).toBe(0);

    const day = ok(app, 'getDay', {});
    expect(day.records.find((record) => record.id === '1001').outJourney).toBe(opened.trip.id);
    expect(day.records.find((record) => record.id === '1002').outJourney).toBe('');

    // A second out-trip has nothing left to load.
    expect(fail(app, 'openTrip', { mode: 'out', driver: '9001' }, 'req-trip-out-0008').code).toBe('NOT_FOUND');
  });

  it('cancels drafts idempotently and never cancels a confirmed trip', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-cancel-01');
    const tripId = opened.trip.id;

    const cancelled = ok(app, 'cancelTrip', { tripId, reason: 'تأجيل الرحلة' }, 'req-trip-cancel-02');
    expect(cancelled.cancelled).toBe(true);
    expect(ok(app, 'cancelTrip', { tripId }, 'req-trip-cancel-03').alreadyCancelled).toBe(true);
    expect(fail(app, 'confirmTrip', { tripId }, 'req-trip-cancel-04').code).toBe('CONFLICT');
    expect(fail(app, 'scanTrip', { tripId, input: '1001', reason: 'اختبار' }, 'req-trip-cancel-05').code).toBe('CONFLICT');
    expect(app.call('readTable_', 'Journeys')[0].status).toBe('CANCELLED');

    const audit = ok(app, 'getAudit', { limit: 100 });
    const log = audit.find((entry) => entry.action === 'إلغاء رحلة');
    expect(log.reason).toBe('تأجيل الرحلة');

    const second = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-cancel-06');
    expect(second.resumed).toBe(false);
    expect(second.trip.id).not.toBe(tripId);
    ok(app, 'scanTrip', { tripId: second.trip.id, input: '1001', reason: 'اختبار' }, 'req-trip-cancel-07');
    ok(app, 'confirmTrip', { tripId: second.trip.id }, 'req-trip-cancel-08');
    expect(fail(app, 'cancelTrip', { tripId: second.trip.id, reason: 'محاولة' }, 'req-trip-cancel-09').code).toBe('CONFLICT');
  });

  it('stops scanned and confirmed drafts when the driver is deactivated', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-driver-01');
    const tripId = opened.trip.id;
    ok(app, 'scanTrip', { tripId, input: '1001', reason: 'اختبار' }, 'req-trip-driver-02');

    ok(app, 'saveDriver', {
      originalCode: '9001', code: '9001', name: 'سائق الاختبار', area: 'حي النور', phone: '0500000000',
      identity: '1000000000', students: ['1001', '1002'], active: false
    });
    expect(fail(app, 'scanTrip', { tripId, input: '1002', reason: 'اختبار' }, 'req-trip-driver-03').code).toBe('DRIVER_INACTIVE');
    expect(fail(app, 'confirmTrip', { tripId }, 'req-trip-driver-04').code).toBe('DRIVER_INACTIVE');
    expect(fail(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-driver-05').code).toBe('DRIVER_INACTIVE');
  });

  it('does not open an in-trip after the day is closed but allows an out-trip', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-trip-closed-01');
    ok(app, 'closeDay', {}, 'req-trip-closed-02');

    expect(fail(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-closed-03').code).toBe('DAY_CLOSED');
    const out = ok(app, 'openTrip', { mode: 'out', driver: '9001' }, 'req-trip-closed-04');
    expect(out.trip.items.map((item) => item.id)).toEqual(['1001']);
    ok(app, 'scanTrip', { tripId: out.trip.id, input: '1001', reason: 'اختبار' }, 'req-trip-closed-05');
    expect(ok(app, 'confirmTrip', { tripId: out.trip.id }, 'req-trip-closed-06').applied).toBe(1);
  });

  it('adds an unrelated student to a draft trip with a reason, then scans and confirms', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-add-0001');
    const tripId = opened.trip.id;

    // 1003 غير مرتبط بالسائق: المسح العادي مرفوض، والإضافة تتطلب سببًا.
    expect(fail(app, 'scanTrip', { tripId, input: '1003', reason: 'اختبار' }, 'req-trip-add-0002').code).toBe('PERMISSION_DENIED');
    expect(fail(app, 'addTripStudent', { tripId, input: '1003' }, 'req-trip-add-0003').code).toBe('VALIDATION');
    expect(fail(app, 'addTripStudent', { tripId, input: '9999', reason: 'اختبار' }, 'req-trip-add-0004').code).toBe('STUDENT_NOT_FOUND');
    expect(fail(app, 'addTripStudent', { tripId, input: '1001', reason: 'اختبار' }, 'req-trip-add-0005').code).toBe('CONFLICT');

    const added = ok(app, 'addTripStudent', { tripId, input: '1003', reason: 'طلب ولي الأمر' }, 'req-trip-add-0006');
    expect(added.added).toBe(true);
    expect(added.trip.counts).toMatchObject({ total: 3, done: 0, pending: 3 });
    expect(itemOf(added.trip, '1003')).toMatchObject({ state: 'pending', method: '', at: '' });
    expect(fail(app, 'addTripStudent', { tripId, input: '1003', reason: 'مكرر' }, 'req-trip-add-0007').code).toBe('CONFLICT');

    const scanned = ok(app, 'scanTrip', { tripId, input: '1003', reason: 'طلب ولي الأمر' }, 'req-trip-add-0008');
    expect(itemOf(scanned.trip, '1003')).toMatchObject({ state: 'scanned', method: 'manual' });

    const confirmed = ok(app, 'confirmTrip', { tripId }, 'req-trip-add-0009');
    expect(confirmed.applied).toBe(1);
    const day = ok(app, 'getDay', {});
    expect(day.records.find((record) => record.id === '1003').inJourney).toBe(tripId);

    const audit = ok(app, 'getAudit', { limit: 100 });
    const entry = audit.find((row) => row.action === 'إضافة طالب إلى رحلة');
    expect(entry.reason).toBe('طلب ولي الأمر');
    expect(entry.details).toContain('1003');

    expect(fail(app, 'addTripStudent', { tripId, input: '1003', reason: 'بعد التأكيد' }, 'req-trip-add-0010').code).toBe('CONFLICT');
  });

  it('splits trip permissions between managers, viewers, and unrelated roles', () => {
    const app = base();
    const viewer = createUser(app, { username: 'view_trips', role: 'viewer' });
    const registrar = createUser(app, { username: 'reg_trips', role: 'registrar' });
    const gate = createUser(app, { username: 'gate_trips', role: 'gate' });
    const viewerToken = loginAs(app, viewer.username, viewer.password);
    const registrarToken = loginAs(app, registrar.username, registrar.password);
    const gateToken = loginAs(app, gate.username, gate.password);

    const opened = okAs(app, gateToken, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-perm-0001');
    expect(opened.trip.id).toBeTruthy();
    expect(okAs(app, gateToken, 'scanTrip', {
      tripId: opened.trip.id, input: '1001', reason: 'اختبار'
    }, 'req-trip-perm-0002').trip.counts.done).toBe(1);
    const confirmed = okAs(app, gateToken, 'confirmTrip', { tripId: opened.trip.id }, 'req-trip-perm-0003');
    expect(confirmed.trip.status).toBe('CONFIRMED');
    expect(failAs(app, gateToken, 'closeDay', {}, 'req-trip-perm-0003b').code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'correctAttendance', {
      date: app.call('today_'), studentId: '1001', field: 'in', time: '07:00', reason: 'محاولة غير مصرح'
    }, 'req-trip-perm-0003c').code).toBe('PERMISSION_DENIED');

    expect(okAs(app, viewerToken, 'getTrips', {}).length).toBe(1);
    expect(okAs(app, viewerToken, 'getTrip', { tripId: opened.trip.id }).trip.status).toBe('CONFIRMED');
    expect(failAs(app, viewerToken, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-perm-0004').code).toBe('PERMISSION_DENIED');
    expect(failAs(app, viewerToken, 'cancelTrip', { tripId: opened.trip.id }, 'req-trip-perm-0005').code).toBe('PERMISSION_DENIED');

    expect(failAs(app, registrarToken, 'getTrips', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, registrarToken, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-perm-0006').code).toBe('PERMISSION_DENIED');
  });

  it('cancels stale drafts during retention while leaving confirmed trips intact', () => {
    const app = base();
    const stale = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-stale-0001');
    ok(app, 'saveDriver', {
      code: '9002', name: 'سائق ثانٍ', area: 'حي النور', phone: '0500000001',
      identity: '1000000001', students: ['1003'], active: true
    });
    const fresh = ok(app, 'openTrip', { mode: 'in', driver: '9002' }, 'req-trip-stale-0002');
    expect(fresh.trip.id).not.toBe(stale.trip.id);
    ok(app, 'scanTrip', { tripId: fresh.trip.id, input: '1003', reason: 'اختبار' }, 'req-trip-stale-0003');
    ok(app, 'confirmTrip', { tripId: fresh.trip.id }, 'req-trip-stale-0004');

    const journeys = app.activeBook.getSheetByName('Journeys');
    const header = journeys.getRange(1, 1, 1, journeys.getLastColumn()).getValues()[0];
    const dateColumn = header.indexOf('date') + 1;
    for (let row = 2; row <= journeys.getLastRow(); row += 1) {
      const record = app.call('objectFromRow_', 'Journeys', journeys.getRange(row, 1, 1, header.length).getValues()[0], row);
      if (record.id !== stale.trip.id) continue;
      journeys.getRange(row, dateColumn).setValue(app.call('addDays_', app.call('today_'), -3));
    }
    expect(app.call('readTable_', 'Journeys').filter((trip) => trip.status === 'DRAFT')).toHaveLength(1);

    const retention = ok(app, 'runRetention', {}, 'req-trip-stale-0005');
    expect(retention.cancelledTrips).toBe(1);
    expect(ok(app, 'getTrip', { tripId: stale.trip.id }).trip.status).toBe('CANCELLED');
    expect(ok(app, 'getTrip', { tripId: fresh.trip.id }).trip.status).toBe('CONFIRMED');

    const audit = ok(app, 'getAudit', { limit: 100 });
    expect(audit.some((entry) => entry.action === 'تطبيق سياسة الاحتفاظ')).toBe(true);
    expect(app.call('readTable_', 'Attendance').filter((record) => record.inAt)).toHaveLength(1);
  });

  it('maps legacy trip items to the 3.6 state machine during migration', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-trip-legacy-01');
    const journeys = app.activeBook.getSheetByName('Journeys');
    const itemsColumn = journeys.getRange(1, 1, 1, journeys.getLastColumn()).getValues()[0].indexOf('items') + 1;
    const statusColumn = journeys.getRange(1, 1, 1, journeys.getLastColumn()).getValues()[0].indexOf('status') + 1;
    journeys.getRange(2, itemsColumn).setValue(JSON.stringify([
      { id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', choice: 'driver' },
      { id: '1002', name: 'سعود علي', classroom: 'الصف الأول', choice: 'parent' }
    ]));
    journeys.getRange(2, statusColumn).setValue('');

    const report = app.call('migrateV36');
    expect(report.tripsArchived).toBe(1);
    const trip = ok(app, 'getTrip', { tripId: opened.trip.id }).trip;
    expect(trip.status).toBe('CONFIRMED');
    expect(trip.items.map((item) => item.state)).toEqual(['scanned', 'guardian']);
    expect(trip.items.map((item) => item.method)).toEqual(['driver', 'guardian']);
    expect(trip.confirmedAt).toBeTruthy();
  });
});
