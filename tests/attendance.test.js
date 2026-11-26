import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setup, ok, fail, okAs, failAs, createUser, loginAs } from './harness.mjs';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T08:30:00+03:00'));
});
afterAll(() => vi.useRealTimers());

const STUDENTS = [
  { id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', phone: '0511111111' },
  { id: '1002', name: 'سعود علي', classroom: 'الصف الأول', phone: '0522222222' },
  { id: '1003', name: 'فهد سالم', classroom: 'الصف الثاني', phone: '0533333333' }
];

function base(extra = {}) {
  return setup({ students: STUDENTS, ...extra });
}

function recordFor(day, id) {
  return day.records.find((record) => record.id === id);
}

describe('attendance', () => {
  it('opens one row per active student and records arrival and departure independently', () => {
    const app = base();
    const day = ok(app, 'getDay', {});
    expect(day.date).toBe(app.call('today_'));
    expect(day.offDay).toBe(false);
    expect(day.day.closed).toBe(false);
    expect(day.records).toHaveLength(3);
    expect(day.summary).toMatchObject({ total: 3, present: 0, absent: 0, pending: 3, out: 0, notOut: 0 });

    const arrival = ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'مسح يدوي للاختبار' }, 'req-att-in-0001');
    expect(arrival.method).toBe('manual');
    expect(arrival.record.status).toBe('present');
    expect(arrival.record.inAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/);
    expect(arrival.record.outAt).toBe('');
    expect(arrival.summary).toMatchObject({ present: 1, pending: 2, out: 0, notOut: 1 });

    const departure = ok(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'انصراف مبكر' }, 'req-att-out-0001');
    expect(departure.record.inAt).toBe(arrival.record.inAt);
    expect(departure.record.outAt).toBeTruthy();
    expect(departure.record.outAt >= departure.record.inAt).toBe(true);
    expect(departure.summary).toMatchObject({ present: 1, out: 1, notOut: 0 });

    const rows = app.call('readTable_', 'Attendance');
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.id === '1001')).toHaveLength(1);

    // Reading again must not open a second block or duplicate rows.
    const again = ok(app, 'getDay', {});
    expect(again.records).toHaveLength(3);
    expect(app.call('readTable_', 'Attendance')).toHaveLength(3);
    expect(ok(app, 'getDay', { date: day.date }).records).toHaveLength(3);
  });

  it('rejects duplicate transitions and departures before arrival', () => {
    const app = base();
    expect(fail(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'اختبار' }).code).toBe('NOT_CHECKED_IN');

    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-dup-0001');
    expect(fail(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }).code).toBe('ALREADY_CHECKED_IN');
    ok(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'اختبار' }, 'req-att-dup-0002');
    expect(fail(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'اختبار' }).code).toBe('ALREADY_CHECKED_OUT');

    expect(fail(app, 'scanStudent', { mode: 'sideways', input: '1001', reason: 'اختبار' }).code).toBe('VALIDATION');
    expect(fail(app, 'scanStudent', { mode: 'in', input: '' }).code).toBe('VALIDATION');
  });

  it('requires a reason for manual entry and stores it in the audit log', () => {
    const app = base();
    expect(fail(app, 'scanStudent', { mode: 'in', input: '1001' }).code).toBe('VALIDATION');
    const scanned = ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'تعطل قارئ الباركود' }, 'req-att-reason-01');
    expect(scanned.method).toBe('manual');

    const audit = ok(app, 'getAudit', { limit: 50 });
    const row = audit.find((entry) => entry.action === 'تسجيل حضور' && entry.targetId === '1001');
    expect(row).toBeTruthy();
    expect(row.reason).toBe('تعطل قارئ الباركود');
    expect(row.result).toBe('SUCCESS');
    expect(row.before).toBeTruthy();
    expect(row.after).toBeTruthy();
  });

  it('closes the day, marks missing students absent, blocks new arrivals, and still allows departures', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-close-0001');

    const closed = ok(app, 'closeDay', {}, 'req-att-close-0002');
    expect(closed.alreadyClosed).toBe(false);
    expect(closed.absent).toBe(2);
    expect(closed.summary).toMatchObject({ total: 3, present: 1, absent: 2, pending: 0 });

    const day = ok(app, 'getDay', {});
    expect(day.day.closed).toBe(true);
    expect(day.day.closedAt).toBeTruthy();
    expect(recordFor(day, '1002').status).toBe('absent');
    expect(recordFor(day, '1001').status).toBe('present');

    expect(fail(app, 'scanStudent', { mode: 'in', input: '1002', reason: 'اختبار' }).code).toBe('DAY_CLOSED');
    const lateOut = ok(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'انصراف بعد الإغلاق' }, 'req-att-close-0003');
    expect(lateOut.record.outAt).toBeTruthy();
    expect(lateOut.record.status).toBe('present');
    expect(recordFor(ok(app, 'getDay', {}), '1002').status).toBe('absent');

    const again = ok(app, 'closeDay', {});
    expect(again.alreadyClosed).toBe(true);
    expect(again.absent).toBeUndefined();

    const audit = ok(app, 'getAudit', { limit: 50 });
    expect(audit.filter((entry) => entry.action === 'إنهاء حضور اليوم')).toHaveLength(1);
  });

  it('replays an idempotent request exactly once and rejects a repeated action with a new request id', () => {
    const app = base();
    const first = ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-idem-0001');
    const replay = ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-idem-0001');
    expect(replay).toEqual(first);
    expect(app.call('readTable_', 'Attendance').filter((row) => row.inAt)).toHaveLength(1);

    expect(fail(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-idem-0002').code).toBe('ALREADY_CHECKED_IN');
    expect(fail(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'short').code).toBe('BAD_REQUEST');
  });

  it('keeps the closed day immutable for late student changes while extending open days', () => {
    const app = base();
    ok(app, 'getDay', {});
    const students = ok(app, 'getStudents', {});
    const second = students.find((student) => student.id === '1002');
    ok(app, 'saveStudent', { ...second, originalId: second.id, active: false });

    const stillThere = ok(app, 'getDay', {});
    expect(stillThere.records.map((record) => record.id).sort()).toEqual(['1001', '1002', '1003']);

    ok(app, 'saveStudent', {
      id: '1004', name: 'ناصر عبدالله', classroom: 'الصف الثاني', phone: '0544444444', active: true
    });
    const extended = ok(app, 'getDay', {});
    expect(extended.records.map((record) => record.id).sort()).toEqual(['1001', '1002', '1003', '1004']);
    expect(extended.records).toHaveLength(4);

    // The block stays contiguous: the new row follows the existing rows.
    const day = app.call('readTable_', 'Days')[0];
    expect(day.startRow + day.rowCount - 1).toBe(app.activeBook.getSheetByName('Attendance').getLastRow());
  });

  it('applies audited corrections with time and clearing rules', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-correct-01');
    ok(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'انصراف' }, 'req-att-correct-02');
    const date = app.call('today_');

    expect(fail(app, 'correctAttendance', { date, studentId: '1001', field: 'in', time: '07:00', reason: 'قصير' }, 'req-att-correct-03').code).toBe('VALIDATION');
    expect(fail(app, 'correctAttendance', { date, studentId: '1001', field: 'bogus', time: '07:00', reason: 'سبب كافٍ' }, 'req-att-correct-04').code).toBe('VALIDATION');
    expect(fail(app, 'correctAttendance', { date, studentId: '1001', field: 'in', time: '25:00', reason: 'سبب كافٍ' }, 'req-att-correct-05').code).toBe('VALIDATION');
    expect(fail(app, 'correctAttendance', { date: '2099-01-01', studentId: '1001', field: 'in', time: '07:00', reason: 'سبب كافٍ' }, 'req-att-correct-06').code).toBe('VALIDATION');
    expect(fail(app, 'correctAttendance', { date, studentId: '9999', field: 'in', time: '07:00', reason: 'سبب كافٍ' }, 'req-att-correct-07').code).toBe('NOT_FOUND');
    expect(fail(app, 'correctAttendance', { date: '2020-01-01', studentId: '1001', field: 'in', time: '07:00', reason: 'سبب كافٍ' }, 'req-att-correct-08').code).toBe('NOT_FOUND');

    const fixed = ok(app, 'correctAttendance', {
      date, studentId: '1001', field: 'in', time: '06:45', reason: 'تصحيح وقت الوصول'
    }, 'req-att-correct-09');
    expect(fixed.record.inAt).toBe(date + 'T06:45:00+03:00');
    expect(fixed.record.status).toBe('present');

    // Applying departure before arrival is rejected.
    expect(fail(app, 'correctAttendance', {
      date, studentId: '1002', field: 'out', time: '13:00', reason: 'تصحيح الانصراف'
    }, 'req-att-correct-10').code).toBe('NOT_CHECKED_IN');

    const cleared = ok(app, 'correctAttendance', {
      date, studentId: '1001', field: 'clearOut', reason: 'إلغاء الانصراف الخاطئ'
    }, 'req-att-correct-11');
    expect(cleared.record.outAt).toBe('');
    expect(cleared.record.inAt).toBe(date + 'T06:45:00+03:00');

    const clearedIn = ok(app, 'correctAttendance', {
      date, studentId: '1001', field: 'clearIn', reason: 'إلغاء الحضور الخاطئ'
    }, 'req-att-correct-12');
    expect(clearedIn.record.inAt).toBe('');
    expect(clearedIn.record.status).toBe('pending');

    const audit = ok(app, 'getAudit', { limit: 100 });
    const corrections = audit.filter((entry) => entry.action === 'تصحيح سجل حضور');
    expect(corrections.length).toBe(3);
    expect(corrections.every((entry) => entry.reason && entry.reason.length >= 5)).toBe(true);
    expect(corrections.some((entry) => entry.before && entry.after)).toBe(true);
  });

  it('treats non-school days as closed and never opens a roster', () => {
    const weekdayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayNames[new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Riyadh', weekday: 'short'
    }).format(new Date())];
    const app = base({ workdays: [(weekday + 1) % 7] });

    const day = ok(app, 'getDay', {});
    expect(day.offDay).toBe(true);
    expect(day.day).toBeNull();
    expect(day.records).toEqual([]);

    expect(fail(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-att-offday-1').code).toBe('DAY_CLOSED');
    expect(fail(app, 'closeDay', {}, 'req-att-offday-2').code).toBe('DAY_NOT_OPEN');
    expect(app.call('readTable_', 'Attendance')).toHaveLength(0);
    expect(app.call('readTable_', 'Days')).toHaveLength(0);
  });

  it('separates gate scanning from administrative closing', () => {
    const app = base();
    const gate = createUser(app, { username: 'gate_att', role: 'gate' });
    const gateToken = loginAs(app, gate.username, gate.password);

    const scanned = okAs(app, gateToken, 'scanStudent', { mode: 'in', input: '1001', reason: 'مسح المناوب' }, 'req-att-gate-0001');
    expect(scanned.student.id).toBe('1001');
    expect(okAs(app, gateToken, 'getDay', {}).records).toHaveLength(3);
    expect(failAs(app, gateToken, 'closeDay', {}, 'req-att-gate-0002').code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'correctAttendance', {
      date: app.call('today_'), studentId: '1001', field: 'in', time: '07:00', reason: 'محاولة غير مصرح'
    }, 'req-att-gate-0003').code).toBe('PERMISSION_DENIED');

    const closed = ok(app, 'closeDay', {}, 'req-att-gate-0004');
    expect(closed.alreadyClosed).toBe(false);
    expect(failAs(app, gateToken, 'scanStudent', { mode: 'in', input: '1002', reason: 'بعد الإغلاق' }, 'req-att-gate-0005').code).toBe('DAY_CLOSED');
  });
});
