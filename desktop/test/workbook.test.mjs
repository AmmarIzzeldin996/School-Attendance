import { describe, it, expect } from 'vitest';
import XLSX from 'xlsx';
import { parseStudentsBuffer, readableTabs, writeWorkbook, TABLE_TITLES } from '../backup/workbook.js';
import { TABLES } from '../sync/model.js';

function bufferFor(rows, sheetName) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName || 'الطلاب');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const HEADER = ['رقم الطالب', 'اسم الطالب', 'الصف والفصل', 'هاتف ولي الأمر'];

describe('student workbook import', () => {
  it('parses Arabic headers and trims values', () => {
    const buffer = bufferFor([
      ['بيانات طلاب المدرسة'],
      [],
      HEADER,
      ['STU-1001', ' أحمد محمد ', 'الصف الأول أ', '0500000001'],
      ['1002', 'سارة علي', 'الصف الأول أ', ''],
      ['', '', '', '']
    ]);
    const result = parseStudentsBuffer(buffer);
    expect(result.sheetName).toBe('الطلاب');
    expect(result.errors).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.students).toHaveLength(2);
    expect(result.students[0]).toMatchObject({
      id: 'STU-1001', name: 'أحمد محمد', classroom: 'الصف الأول أ', active: true
    });
    expect(result.students[1].phone).toBe('');
  });

  it('accepts English header aliases', () => {
    const buffer = bufferFor([
      ['Student ID', 'Student Name', 'Classroom', 'Phone'],
      ['STU-2001', 'Ali', 'Grade 3', '0550000000']
    ], 'Students');
    const result = parseStudentsBuffer(buffer);
    expect(result.students).toHaveLength(1);
    expect(result.students[0].classroom).toBe('Grade 3');
  });

  it('reports invalid rows and skips duplicates without partial acceptance', () => {
    const buffer = bufferFor([
      HEADER,
      ['STU-3001', 'طالب أول', 'الصف الثالث', ''],
      ['STU-3001', 'طالب مكرر الرقم', 'الصف الثالث', ''],
      ['STU-3002', 'طالب أول', 'الصف الثالث', ''],
      ['', 'بدون رقم', 'الصف الثالث', ''],
      ['STU-3003', 'بدون صف', '', ''],
      ['X1', 'رقم غير صحيح', 'الصف الثالث', '']
    ]);
    const result = parseStudentsBuffer(buffer);
    expect(result.students.map((student) => student.id)).toEqual(['STU-3001']);
    expect(result.duplicates).toHaveLength(2);
    expect(result.errors).toHaveLength(3);
    expect(result.total).toBe(6);
  });

  it('fails clearly when the sheet has no recognizable student columns', () => {
    const buffer = bufferFor([['كود', 'وصف'], ['1', 'لا يوجد']]);
    expect(() => parseStudentsBuffer(buffer)).toThrow(/أعمدة الطلاب/);
  });
});

describe('readable backup workbook', () => {
  const snapshot = {
    appVersion: '3.6.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    settings: { schoolName: 'مدرسة الاختبار', workdays: [0, 1, 2] },
    accounts: [{ id: '1', username: 'admin', name: 'مدير', email: '', role: 'admin', active: true }],
    tables: {
      Students: [{ id: 'STU-1001', name: 'طالب', classroom: 'صف', phone: '', active: true, token: '' }],
      Attendance: [],
      Days: [],
      Audit: [],
      Drivers: [],
      Journeys: [],
      JourneyDays: [],
      Cards: [],
      TripDetails: []
    }
  };

  it('includes a readable Arabic tab per table plus settings and accounts', () => {
    const tabs = readableTabs(snapshot);
    const titles = tabs.map((tab) => tab.title);
    expect(titles).toContain(TABLE_TITLES.Students);
    expect(titles).toContain('الإعدادات');
    expect(titles).toContain('الحسابات');
    const students = tabs.find((tab) => tab.title === TABLE_TITLES.Students);
    expect(students.rows[0]).toEqual(TABLES.Students.header);
    expect(students.rows[1][0]).toBe('STU-1001');
  });

  it('builds a valid XLSX buffer with all tabs', () => {
    const buffer = writeWorkbook(snapshot);
    const book = XLSX.read(buffer, { type: 'buffer' });
    expect(book.SheetNames.length).toBe(Object.keys(TABLE_TITLES).length + 2);
    const students = XLSX.utils.sheet_to_json(book.Sheets[TABLE_TITLES.Students], { header: 1 });
    expect(students[1][0]).toBe('STU-1001');
  });
});
