// Row-level classroom scope: empty = every classroom, admin = every classroom.
import { describe, it, expect } from 'vitest';
import { setup, ok, fail, okAs, failAs, createUser, loginAs } from './harness.mjs';

const STUDENTS = [
  { id: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', phone: '0511111111' },
  { id: '1002', name: 'سعود علي', classroom: 'الصف الأول', phone: '0522222222' },
  { id: '1003', name: 'فهد سالم', classroom: 'الصف الثاني', phone: '0533333333' }
];

function base() {
  return setup({ students: STUDENTS });
}

function ids(rows) {
  return rows.map((row) => row.id).sort();
}

describe('classroom scope', () => {
  it('filters the student list and blocks reads, moves and creates outside the scope', () => {
    const app = base();
    const user = createUser(app, { username: 'reg1', role: 'registrar', classrooms: ['الصف الأول'] });
    expect(user.classrooms).toEqual(['الصف الأول']);
    const token = loginAs(app, 'reg1', user.password);

    expect(ids(okAs(app, token, 'getStudents'))).toEqual(['1001', '1002']);
    expect(ok(app, 'getUsers').find((item) => item.username === 'reg1').classrooms).toEqual(['الصف الأول']);

    // Reading/editing an out-of-scope student is refused.
    expect(failAs(app, token, 'saveStudent', {
      id: '1003', originalId: '1003', name: 'فهد سالم', classroom: 'الصف الثاني'
    }).code).toBe('PERMISSION_DENIED');
    // Moving a scoped student out of the scope is refused.
    expect(failAs(app, token, 'saveStudent', {
      id: '1001', originalId: '1001', name: 'أحمد محمد', classroom: 'الصف الثاني'
    }).code).toBe('PERMISSION_DENIED');
    // Creating a student in another classroom is refused.
    expect(failAs(app, token, 'saveStudent', {
      id: '1004', name: 'طالب جديد', classroom: 'الصف الثاني'
    }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, token, 'importStudents', {
      rows: [{ id: '1005', name: 'طالب مستورد', classroom: 'الصف الثاني' }]
    }).code).toBe('PERMISSION_DENIED');
    expect(ok(app, 'getStudents')).toHaveLength(3);

    // Editing inside the scope still works.
    const edited = okAs(app, token, 'saveStudent', {
      id: '1001', originalId: '1001', name: 'أحمد محمد', classroom: 'الصف الأول', phone: '0500000000'
    });
    expect(edited.student.phone).toBe('0500000000');
  });

  it('filters day records and reports, while an empty scope and admin see everything', () => {
    const app = base();
    ok(app, 'scanStudent', { mode: 'in', input: '1001', reason: 'اختبار' }, 'req-scope-day-01');
    ok(app, 'scanStudent', { mode: 'in', input: '1003', reason: 'اختبار' }, 'req-scope-day-02');
    ok(app, 'closeDay', {}, 'req-scope-day-03');
    const date = ok(app, 'getDay', {}).date;

    const gate = createUser(app, { username: 'gate1', role: 'gate', classrooms: ['الصف الثاني'] });
    const gateToken = loginAs(app, 'gate1', gate.password);
    const day = okAs(app, gateToken, 'getDay', {});
    expect(ids(day.records)).toEqual(['1003']);
    expect(day.summary).toMatchObject({ total: 1, present: 1 });

    const viewer = createUser(app, { username: 'view1', role: 'viewer', classrooms: ['الصف الأول'] });
    const viewerToken = loginAs(app, 'view1', viewer.password);
    const report = okAs(app, viewerToken, 'getReport', { from: date, to: date, type: 'daily' });
    expect(ids(report.rows)).toEqual(['1001', '1002']);
    expect(report.summary).toMatchObject({ records: 2, present: 1 });

    // An account without classrooms sees every classroom.
    const open = createUser(app, { username: 'gate2', role: 'gate', classrooms: [] });
    const openToken = loginAs(app, 'gate2', open.password);
    expect(ids(okAs(app, openToken, 'getDay', {}).records)).toEqual(['1001', '1002', '1003']);

    // Admin always sees everything, even if a scope is sent.
    const wide = createUser(app, { username: 'adm2', role: 'admin', classrooms: ['الصف الأول'] });
    expect(wide.classrooms).toEqual([]);
    const adminToken = loginAs(app, 'adm2', wide.password);
    expect(ids(okAs(app, adminToken, 'getStudents'))).toEqual(['1001', '1002', '1003']);
  });

  it('validates classroom names when saving a user', () => {
    const app = base();
    expect(fail(app, 'saveUser', {
      username: 'bad1', name: 'مستخدم', role: 'gate', active: true, password: 'Temp!2026',
      classrooms: ['صف غير موجود']
    }).code).toBe('VALIDATION');
    const saved = ok(app, 'saveUser', {
      username: 'good1', name: 'مستخدم', role: 'gate', active: true, password: 'Temp!2026',
      classrooms: ['الصف الأول', 'الصف الأول']
    });
    expect(saved.user.classrooms).toEqual(['الصف الأول']);
    expect(fail(app, 'saveUser', {
      username: 'many1', name: 'مستخدم', role: 'gate', active: true, password: 'Temp!2026',
      classrooms: Array.from({ length: 31 }, (_, index) => 'صف ' + index)
    }).code).toBe('VALIDATION');
  });
});
