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
  return setup({
    students: STUDENTS,
    drivers: [{ code: '9001', name: 'سائق الاختبار', area: 'حي النور', students: ['1001', '1002'] }],
    ...extra
  });
}

function attendanceRow(date, id, name, classroom, options = {}) {
  return {
    date, id, name, classroom,
    status: options.in ? 'present' : options.closed ? 'absent' : 'pending',
    inAt: options.in || '', outAt: options.out || '', operator: 'test',
    inMethod: options.inMethod || (options.in ? 'manual' : ''),
    inJourney: '', outMethod: options.outMethod || (options.out ? 'manual' : ''), outJourney: ''
  };
}

// Appends a complete closed day block directly to the fake sheets so reports can span dates.
function addClosedDay(app, date, rows) {
  const startRow = app.activeBook.getSheetByName('Attendance').getLastRow() + 1;
  app.call('appendRows_', 'Attendance', rows);
  app.call('appendRows_', 'Days', [{
    date, closed: true, closedAt: date + 'T08:00:00+03:00', operator: 'test',
    startRow, rowCount: rows.length
  }]);
}

describe('reports', () => {
  it('reports a daily view and a closed-day summary with late and absence filters', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-report-day-01');
    ok(app, 'scanStudent', { mode: 'out', input: '1001', reason: 'اختبار' }, 'req-report-day-02');
    ok(app, 'scanStudent', { mode: 'in', input: '1002', reason: 'اختبار' }, 'req-report-day-03');
    ok(app, 'closeDay', {}, 'req-report-day-04');

    const date = app.call('today_');
    const daily = ok(app, 'getReport', { from: date, to: date, type: 'daily' });
    expect(daily.type).toBe('daily');
    expect(daily.lateAfter).toBe('07:30');
    expect(daily.summary).toMatchObject({
      days: 1, closedDays: 1, records: 3, closedRecords: 3,
      present: 2, absent: 1, checkedOut: 1, percentage: 66.7
    });
    expect(daily.rows).toHaveLength(3);
    const absent = daily.rows.find((row) => row.id === '1003');
    expect(absent.status).toBe('absent');
    expect(absent.inAt).toBe('');
    expect(absent.late).toBe(false);
    expect(daily.rows.find((row) => row.id === '1001').checkedOut).toBeUndefined();
    expect(daily.rows.find((row) => row.id === '1001').outAt).toBeTruthy();

    const onlyAbsent = ok(app, 'getReport', { from: date, to: date, type: 'daily', status: 'absent' });
    expect(onlyAbsent.rows.map((row) => row.id)).toEqual(['1003']);
    expect(onlyAbsent.summary).toMatchObject({ records: 1, present: 0, absent: 1, percentage: 0 });

    const onlyDeparted = ok(app, 'getReport', { from: date, to: date, type: 'daily', status: 'departed' });
    expect(onlyDeparted.rows.map((row) => row.id)).toEqual(['1001']);

    const manual = ok(app, 'getReport', { from: date, to: date, type: 'method', method: 'manual' });
    expect(manual.summary.records).toBe(2);
    expect(manual.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'in', method: 'manual', count: 2 }),
      expect.objectContaining({ direction: 'out', method: 'manual', count: 1 })
    ]));

    const settings = ok(app, 'getSettings', {});
    settings.lateAfter = '23:59';
    ok(app, 'saveSettings', { settings });
    const relaxed = ok(app, 'getReport', { from: date, to: date, type: 'daily' });
    expect(relaxed.summary.late).toBe(0);
    expect(relaxed.rows.every((row) => row.late === false)).toBe(true);
  });

  it('does not count an open day as absent and returns a null percentage', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-report-open-01');

    const date = app.call('today_');
    const report = ok(app, 'getReport', { from: date, to: date, type: 'daily' });
    expect(report.summary).toMatchObject({
      days: 1, closedDays: 0, records: 3, closedRecords: 0,
      present: 0, absent: 0, percentage: null
    });

    const monthly = ok(app, 'getReport', { from: date, to: date, type: 'monthly' });
    expect(monthly.rows).toHaveLength(1);
    expect(monthly.rows[0]).toMatchObject({ date, total: 3, present: 1, absent: 0, checkedOut: 0, late: 1, percentage: null, closed: false });

    const absentFilter = ok(app, 'getReport', { from: date, to: date, type: 'absence' });
    expect(absentFilter.rows).toEqual([]);
  });

  it('groups multiple closed days by day, student, class, method, and absence', () => {
    const app = base();
    const first = app.call('addDays_', app.call('today_'), -2);
    const second = app.call('addDays_', app.call('today_'), -1);
    addClosedDay(app, first, [
      attendanceRow(first, '1001', 'أحمد محمد', 'الصف الأول', { in: first + 'T07:10:00+03:00', out: first + 'T13:00:00+03:00' }),
      attendanceRow(first, '1002', 'سعود علي', 'الصف الأول', { closed: true })
    ]);
    addClosedDay(app, second, [
      attendanceRow(second, '1001', 'أحمد محمد', 'الصف الأول', { in: second + 'T08:00:00+03:00' }),
      attendanceRow(second, '1002', 'سعود علي', 'الصف الأول', {
        in: second + 'T07:00:00+03:00', out: second + 'T12:00:00+03:00', inMethod: 'guardian', outMethod: 'guardian'
      }),
      attendanceRow(second, '1003', 'فهد سالم', 'الصف الثاني', { closed: true })
    ]);

    const monthly = ok(app, 'getReport', { from: first, to: second, type: 'monthly' });
    expect(monthly.summary).toMatchObject({
      days: 2, closedDays: 2, records: 5, closedRecords: 5,
      present: 3, absent: 2, checkedOut: 2, late: 1, percentage: 60
    });
    expect(monthly.rows).toHaveLength(2);
    expect(monthly.rows[0]).toMatchObject({ date: first, total: 2, present: 1, absent: 1, checkedOut: 1, late: 0, percentage: 50, closed: true });
    expect(monthly.rows[1]).toMatchObject({ date: second, total: 3, present: 2, absent: 1, checkedOut: 1, late: 1, percentage: 66.7, closed: true });

    const students = ok(app, 'getReport', { from: first, to: second, type: 'student' });
    expect(students.rows.map((row) => row.id)).toEqual(['1001', '1002', '1003']);
    expect(students.rows[0]).toMatchObject({ total: 2, present: 2, absent: 0, late: 1, percentage: 100 });
    expect(students.rows[1]).toMatchObject({ total: 2, present: 1, absent: 1, percentage: 50 });
    expect(students.rows[2]).toMatchObject({ total: 1, present: 0, absent: 1, percentage: 0 });

    const classes = ok(app, 'getReport', { from: first, to: second, type: 'class' });
    expect(classes.rows.map((row) => row.name)).toEqual(['الصف الأول', 'الصف الثاني']);
    expect(classes.rows[0]).toMatchObject({ total: 4, present: 3, absent: 1, percentage: 75 });

    const methods = ok(app, 'getReport', { from: first, to: second, type: 'method' });
    const byKey = Object.fromEntries(methods.rows.map((row) => [row.direction + '|' + row.method, row.count]));
    expect(byKey).toEqual({ 'in|manual': 2, 'in|guardian': 1, 'out|manual': 1, 'out|guardian': 1 });

    const absence = ok(app, 'getReport', { from: first, to: second, type: 'absence' });
    expect(absence.rows.map((row) => row.date + ':' + row.id)).toEqual([first + ':1002', second + ':1003']);
    expect(absence.summary).toMatchObject({ present: 3, absent: 2 });

    const firstOnly = ok(app, 'getReport', { from: first, to: first, type: 'monthly' });
    expect(firstOnly.rows).toHaveLength(1);
    expect(firstOnly.rows[0].date).toBe(first);
  });

  it('reports confirmed trips only and filters by driver', () => {
    const app = base();
    const opened = ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-report-trip-01');
    ok(app, 'scanTrip', { tripId: opened.trip.id, input: '1001', reason: 'اختبار' }, 'req-report-trip-02');
    ok(app, 'scanTrip', { tripId: opened.trip.id, input: '1002', choice: 'guardian', reason: 'اختبار' }, 'req-report-trip-03');
    ok(app, 'confirmTrip', { tripId: opened.trip.id }, 'req-report-trip-04');
    ok(app, 'openTrip', { mode: 'in', driver: '9001' }, 'req-report-trip-05');

    const date = app.call('today_');
    const trips = ok(app, 'getReport', { from: date, to: date, type: 'trips' });
    expect(trips.rows).toHaveLength(1);
    expect(trips.rows[0]).toMatchObject({
      tripId: opened.trip.id, date, driverCode: '9001', mode: 'in', total: 2, applied: 2
    });
    expect(trips.rows[0].confirmedAt).toBeTruthy();

    expect(ok(app, 'getReport', { from: date, to: date, type: 'trips', driverCode: '9001' }).rows).toHaveLength(1);
    expect(ok(app, 'getReport', { from: date, to: date, type: 'trips', driverCode: '9002' }).rows).toHaveLength(0);
  });

  it('validates report inputs and enforces report permissions', () => {
    const app = base();
    const date = app.call('today_');
    expect(fail(app, 'getReport', { from: date, to: date, type: 'nope' }).code).toBe('VALIDATION');
    expect(fail(app, 'getReport', { from: date, to: date, type: 'daily', method: 'nope' }).code).toBe('VALIDATION');
    expect(fail(app, 'getReport', { from: date, to: date, type: 'daily', status: 'nope' }).code).toBe('VALIDATION');
    expect(fail(app, 'getReport', { from: date, to: '2020-01-01', type: 'daily' }).code).toBe('VALIDATION');
    expect(fail(app, 'getReport', { from: '2020-01-01', to: '2022-01-01', type: 'daily' }).code).toBe('VALIDATION');

    const viewer = createUser(app, { username: 'view_reports', role: 'viewer' });
    const gate = createUser(app, { username: 'gate_reports', role: 'gate' });
    const registrar = createUser(app, { username: 'reg_reports', role: 'registrar' });
    const viewerToken = loginAs(app, viewer.username, viewer.password);
    const gateToken = loginAs(app, gate.username, gate.password);
    const registrarToken = loginAs(app, registrar.username, registrar.password);

    expect(okAs(app, viewerToken, 'getReport', { from: date, to: date, type: 'daily' }).rows).toEqual([]);
    expect(failAs(app, gateToken, 'getReport', { from: date, to: date, type: 'daily' }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, registrarToken, 'getReport', { from: date, to: date, type: 'daily' }).code).toBe('PERMISSION_DENIED');
  });
});
