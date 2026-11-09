'use strict';

const XLSX = require('xlsx');
const { TABLES, TABLES: TABLE_DEFINITIONS } = require('../sync/model');

// أسماء عربية مقروءة، وضمن حد Google Sheets (31 حرفًا).
const TABLE_TITLES = {
  Students: 'الطلاب',
  Attendance: 'الحضور',
  Days: 'الأيام',
  Audit: 'التدقيق',
  Drivers: 'السائقون',
  Journeys: 'الرحلات',
  JourneyDays: 'أيام الرحلات',
  Cards: 'البطاقات',
  TripDetails: 'تفاصيل الرحلات'
};

const TITLE_TABLES = Object.keys(TABLE_TITLES).reduce((map, name) => {
  map[TABLE_TITLES[name]] = name;
  return map;
}, {});

function tableRows(snapshot, name) {
  const header = TABLES[name] ? TABLES[name].header : [];
  const rows = [header.slice()];
  const records = (snapshot && snapshot.tables && snapshot.tables[name]) || [];
  records.forEach((record) => {
    rows.push(header.map((key) => {
      const value = record[key];
      return value === undefined || value === null ? '' : value;
    }));
  });
  return rows;
}

function settingsRows(snapshot) {
  const rows = [['الإعداد', 'القيمة']];
  const settings = (snapshot && snapshot.settings) || {};
  Object.keys(settings).forEach((key) => {
    const value = settings[key];
    rows.push([key, Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : value]);
  });
  rows.push(['appVersion', (snapshot && snapshot.appVersion) || '']);
  rows.push(['createdAt', (snapshot && snapshot.createdAt) || '']);
  return rows;
}

function accountRows(snapshot) {
  const rows = [['id', 'username', 'name', 'email', 'role', 'active']];
  ((snapshot && snapshot.accounts) || []).forEach((account) => {
    rows.push([account.id || '', account.username || '', account.name || '', account.email || '', account.role || '', account.active ? 'نعم' : 'لا']);
  });
  return rows;
}

function readableTabs(snapshot) {
  const tabs = Object.keys(TABLE_TITLES).map((name) => ({
    title: TABLE_TITLES[name],
    rows: tableRows(snapshot, name)
  }));
  tabs.push({ title: 'الإعدادات', rows: settingsRows(snapshot) });
  tabs.push({ title: 'الحسابات', rows: accountRows(snapshot) });
  return tabs;
}

function buildWorkbook(snapshot) {
  const book = XLSX.utils.book_new();
  readableTabs(snapshot).forEach((tab) => {
    const sheet = XLSX.utils.aoa_to_sheet(tab.rows);
    sheet['!cols'] = tab.rows[0].map((value, index) => ({ wch: index === 0 ? 18 : 22 }));
    XLSX.utils.book_append_sheet(book, sheet, tab.title.slice(0, 31));
  });
  return book;
}

function writeWorkbook(snapshot) {
  return XLSX.write(buildWorkbook(snapshot), { type: 'buffer', bookType: 'xlsx', compression: true });
}

function text(value) {
  return String(value == null ? '' : value).replace(/\u00a0/g, ' ').trim();
}

function normalizeHeader(value) {
  return text(value).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

const HEADER_MAP = {
  'رقم الطالب': 'id', 'رقم الطالب ': 'id', 'الرقم': 'id', 'id': 'id', 'student id': 'id',
  'اسم الطالب': 'name', 'الاسم': 'name', 'name': 'name', 'student name': 'name',
  'الصف والفصل': 'classroom', 'الصف': 'classroom', 'الفصل': 'classroom', 'class': 'classroom', 'classroom': 'classroom',
  'هاتف ولي الأمر': 'phone', 'هاتف ولي الامر': 'phone', 'الجوال': 'phone', 'الهاتف': 'phone', 'phone': 'phone', 'mobile': 'phone'
};

function sheetValues(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const preferred = book.SheetNames.find((name) => /الطلاب|students/i.test(name)) || book.SheetNames[0];
  const sheet = book.Sheets[preferred];
  if (!sheet) throw new Error('الملف لا يحتوي على ورقة بيانات.');
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  return { sheetName: preferred, values };
}

function parseStudentsBuffer(buffer) {
  const { sheetName, values } = sheetValues(buffer);
  let headerIndex = -1;
  let columns = null;
  for (let index = 0; index < Math.min(values.length, 15); index += 1) {
    const row = values[index] || [];
    const candidate = {};
    row.forEach((cell, position) => {
      const key = HEADER_MAP[normalizeHeader(cell)];
      if (key && candidate[key] === undefined) candidate[key] = position;
    });
    if (candidate.id !== undefined && candidate.name !== undefined) {
      headerIndex = index;
      columns = candidate;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new Error('تعذر العثور على أعمدة الطلاب. يجب أن يحتوي الملف على «رقم الطالب» و«اسم الطالب».');
  }
  if (columns.classroom === undefined) {
    throw new Error('عمود «الصف والفصل» مطلوب.');
  }
  const students = [];
  const errors = [];
  const duplicates = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (let index = headerIndex + 1; index < values.length; index += 1) {
    const row = values[index] || [];
    const pick = (key) => (columns[key] === undefined ? '' : text(row[columns[key]]));
    const student = {
      id: pick('id'),
      name: pick('name'),
      classroom: pick('classroom'),
      phone: pick('phone')
    };
    if (!student.id && !student.name && !student.classroom) continue;
    const line = index + 1;
    if (!student.id || !student.name || !student.classroom) {
      errors.push({ line, message: 'رقم الطالب والاسم والصف مطلوبة.', student });
      continue;
    }
    if (!/^[0-9]{4}$/.test(student.id) && !/^STU[-_]?[0-9]{3,}$/i.test(student.id)) {
      errors.push({ line, message: 'رقم الطالب يجب أن يكون 4 أرقام أو STU-####.', student });
      continue;
    }
    if (student.name.length > 120) {
      errors.push({ line, message: 'اسم الطالب أطول من الحد المسموح.', student });
      continue;
    }
    if (student.classroom.length > 80) {
      errors.push({ line, message: 'الصف أطول من الحد المسموح.', student });
      continue;
    }
    if (student.phone.length > 30) {
      errors.push({ line, message: 'رقم الهاتف أطول من الحد المسموح.', student });
      continue;
    }
    const idKey = student.id.toUpperCase();
    const nameKey = student.name.replace(/\s+/g, ' ').toLowerCase();
    if (seenIds.has(idKey) || seenNames.has(nameKey)) {
      duplicates.push({ line, student });
      continue;
    }
    seenIds.add(idKey);
    seenNames.add(nameKey);
    students.push(Object.assign({ active: true }, student));
  }
  return {
    sheetName,
    students,
    errors,
    duplicates,
    total: students.length + errors.length + duplicates.length
  };
}

module.exports = {
  TABLE_TITLES,
  TITLE_TABLES,
  readableTabs,
  buildWorkbook,
  writeWorkbook,
  parseStudentsBuffer,
  tableRows,
  settingsRows,
  accountRows,
  TABLE_DEFINITIONS
};
