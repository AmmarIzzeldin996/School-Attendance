import { describe, it, expect } from 'vitest';
import { createApp, setup, ok, today, enableAllDays, cloneData } from './harness.mjs';

const LEGACY = {
  Students: ['id', 'name', 'classroom', 'phone', 'active', 'token'],
  Attendance: ['date', 'id', 'name', 'classroom', 'status', 'inAt', 'outAt', 'operator', 'inMethod', 'inJourney', 'outMethod', 'outJourney'],
  Days: ['date', 'closed', 'closedAt', 'operator', 'startRow', 'rowCount'],
  Audit: ['at', 'operator', 'action', 'details'],
  Drivers: ['code', 'name', 'area', 'phone', 'identity', 'studentIds', 'active', 'updatedAt', 'deleted', 'deletedReason'],
  Journeys: ['id', 'date', 'driverCode', 'driverName', 'area', 'mode', 'revision', 'at', 'operator', 'items', 'history', 'requestId', 'lastRequestId'],
  JourneyDays: ['date', 'startRow', 'rowCount']
};

function writeLegacyBook(app) {
  const book = app.newBook('Legacy 3.5');
  app.useBook(book);
  const date = today(app);
  const rowsBySheet = {
    Students: [
      ['1001', 'أحمد محمد', 'الصف الأول', '0511111111', true, 'STU-11111111-1111-4111-8111-111111111111'],
      ['1002', 'سعود علي', 'الصف الأول', '0522222222', true, 'STU-22222222-2222-4222-8222-222222222222']
    ],
    Attendance: [
      [date, '1001', 'أحمد محمد', 'الصف الأول', 'pending', '', '', '', '', '', '', ''],
      [date, '1002', 'سعود علي', 'الصف الأول', 'pending', '', '', '', '', '', '', '']
    ],
    Days: [[date, false, '', 'legacy-operator', 2, 2]],
    Audit: [['2026-01-01T08:00:00+03:00', 'legacy-operator', 'فتح سجل اليوم', 'سجل قديم']],
    Drivers: [['9001', 'سائق قديم', 'حي النور', '0500000000', '1000000000', '["1001"]', true, '2026-01-01T08:00:00+03:00', false, '']],
    Journeys: [[
      'legacy-trip-1', date, '9001', 'سائق قديم', 'حي النور', 'in', 1,
      '2026-01-01T08:00:00+03:00', 'legacy-operator',
      JSON.stringify([{ id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', choice: 'driver' }]),
      '[]', 'legacy-request', ''
    ]],
    JourneyDays: [[date, 2, 1]]
  };
  Object.keys(LEGACY).forEach((name) => {
    const sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, LEGACY[name].length).setValues([LEGACY[name]]);
    const rows = rowsBySheet[name] || [];
    if (rows.length) sheet.getRange(2, 1, rows.length, LEGACY[name].length).setValues(rows);
  });
  app.props.set('DB_ID', book.getId());
  return { book, date };
}

describe('migration and compatibility', () => {
  it('migrates a 3.5 workbook without losing data or legacy cards', () => {
    const app = setup();
    enableAllDays(app);
    const { book, date } = writeLegacyBook(app);

    const report = app.call('migrateV36');
    expect(report.schema.created).toEqual(expect.arrayContaining(['Cards', 'TripDetails']));
    expect(report.schema.extended).toEqual(expect.arrayContaining(['Audit', 'Journeys']));
    expect(report.cardsCreated).toBe(2);
    expect(report.tokensCleared).toBe(2);
    expect(report.tripsArchived).toBe(1);

    expect(book.getSheetByName('Students').getLastRow()).toBe(3);
    const students = app.call('readTable_', 'Students');
    expect(students.map((student) => student.id)).toEqual(['1001', '1002']);
    expect(students.every((student) => student.token === '')).toBe(true);

    const cards = app.call('readTable_', 'Cards');
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.type === 'STUDENT' && card.status === 'ACTIVE' && /^[0-9a-f]{64}$/.test(card.token_hash))).toBe(true);
    expect(JSON.stringify(cards)).not.toContain('STU-');

    const attendance = app.call('readTable_', 'Attendance');
    expect(attendance).toHaveLength(2);
    expect(attendance.every((record) => record.date === date && record.status === 'pending')).toBe(true);
    expect(app.call('readTable_', 'Audit').some((row) => row.details === 'سجل قديم')).toBe(true);
    expect(app.call('readTable_', 'Drivers')).toHaveLength(1);

    const trip = app.call('readTable_', 'Journeys')[0];
    expect(trip.status).toBe('CONFIRMED');
    expect(JSON.parse(trip.items)[0].state).toBe('scanned');
    expect(trip.confirmedAt).toBeTruthy();

    // The previously printed student card keeps working after migration.
    const scanned = ok(app, 'scanStudent', {
      mode: 'in', input: 'STU-11111111-1111-4111-8111-111111111111'
    }, 'req-migrate-scan-1');
    expect(scanned.student.id).toBe('1001');
    expect(scanned.method).toBe('qr');
  });

  it('is safe to run twice and reports duplicate hashes instead of creating cards again', () => {
    const app = setup();
    enableAllDays(app);
    writeLegacyBook(app);
    app.call('migrateV36');

    const again = app.call('migrateV36');
    expect(again.cardsCreated).toBe(0);
    expect(again.tokensCleared).toBe(0);
    expect(again.duplicateTokens).toBe(0);
    expect(again.tripsArchived).toBe(0);
    expect(app.call('readTable_', 'Cards')).toHaveLength(2);
    expect(app.call('readTable_', 'Journeys')).toHaveLength(1);
    expect(app.call('readTable_', 'Students').every((student) => student.token === '')).toBe(true);
  });

  it('refuses to migrate when a legacy sheet has an unexpected header', () => {
    const app = setup();
    writeLegacyBook(app);
    const audit = app.activeBook.getSheetByName('Audit');
    audit.getRange(1, 5).setValue('unexpected_column');
    expect(() => app.call('migrateV36')).toThrow(/عمود|مخطط|SCHEMA/i);

    // Nothing destructive happened before the header check failed.
    expect(app.call('readTable_', 'Students').length).toBe(2);
    expect(app.activeBook.getSheetByName('Cards')).toBeNull();
  });

  it('keeps installSchool idempotent for the linked workbook', () => {
    const app = setup();
    const before = app.call('readTable_', 'Students').length;
    const existing = app.call('installSchool');
    expect(existing.existing).toBe(true);
    expect(app.call('readTable_', 'Students').length).toBe(before);
    expect(app.props.get('DB_ID')).toBe(app.activeBook.getId());
  });

  it('refuses to install over a non-empty unlinked workbook', () => {
    const app = createApp();
    const book = app.newBook('Legacy 3.5');
    app.useBook(book);
    const sheet = book.insertSheet('Students');
    sheet.getRange(1, 1, 1, 1).setValues([['id']]);
    sheet.getRange(2, 1, 1, 1).setValues([['1001']]);
    expect(() => app.call('installSchool')).toThrow(/فارغ|بيانات/i);
    expect(app.props.get('DB_ID')).toBeUndefined();
  });

  it('preserves the documented legacy column prefixes for every table', () => {
    const app = setup();
    const expected = cloneData(LEGACY);
    const current = cloneData(app.sandbox.TABLES_);
    Object.keys(expected).forEach((name) => {
      expect(current[name].slice(0, expected[name].length)).toEqual(expected[name]);
    });
    expect(current.Audit.slice(4)).toEqual(['event_id', 'request_id', 'target_type', 'target_id', 'result', 'reason', 'before_json', 'after_json']);
    expect(current.Journeys.slice(13)).toEqual(['status', 'confirmedAt', 'confirmedBy', 'appliedAt']);
    expect(current.Cards).toHaveLength(11);
    expect(current.TripDetails).toEqual(['trip_id', 'student_id', 'method', 'applied_at', 'request_id']);
  });
});
