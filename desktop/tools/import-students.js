'use strict';

// استيراد أسماء الطلاب فقط من ملف Excel/CSV إلى قاعدة بيانات سطح المكتب.
// لا يستورد أي سجلات حضور تاريخية. التشغيل من جذر المشروع:
//   node desktop/tools/import-students.js --file "E:\projects\بيانات الطلاب.xlsx" --data-dir "<مجلد البيانات>" --dry-run
//   node desktop/tools/import-students.js --file "..." --data-dir "..." --install --school "اسم المدرسة"
//   node desktop/tools/import-students.js --file "..." --data-dir "..."   (إضافة إلى نظام مُهيأ)
// أوقف التطبيق قبل الاستيراد في قاعدة بيانات قائمة.

const fs = require('node:fs');
const path = require('node:path');
const { parseStudentsBuffer } = require('../backup/workbook');
const { Runtime } = require('../vm/runtime');
const { SyncEngine } = require('../sync/engine');
const { Logger } = require('../lib/logger');

const BATCH_SIZE = 400;

function usage() {
  return [
    'استيراد الطلاب إلى نظام الحضور — سطح المكتب',
    '',
    'الخيارات:',
    '  --file <path>       ملف Excel أو CSV (مطلوب)',
    '  --data-dir <path>   مجلد بيانات سطح المكتب (مطلوب ما لم يكن --dry-run)',
    '  --install           تهيئة نظام جديد في مجلد البيانات ثم استيراد الطلاب',
    '  --school <name>     اسم المدرسة عند التهيئة',
    '  --system <name>     اسم النظام الظاهر عند التهيئة',
    '  --dry-run           تحليل الملف وعرض النتيجة دون كتابة',
    '  --help              عرض هذه التعليمات',
    '',
    'ملاحظة: أعمدة الملف المطلوبة: رقم الطالب، اسم الطالب، الصف والفصل.',
    'تُهمل التكرارات والسجلات غير الصالحة، ويُبلَّغ عنها في المخرجات.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dryRun: false, install: false, help: false };
  const requireValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || String(value).startsWith('--')) {
      throw new Error('قيمة مفقودة بعد ' + flag);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--file': options.file = requireValue(index, arg); index += 1; break;
      case '--data-dir': options.dataDir = requireValue(index, arg); index += 1; break;
      case '--school': options.school = requireValue(index, arg); index += 1; break;
      case '--system': options.system = requireValue(index, arg); index += 1; break;
      case '--install': options.install = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error('خيار غير معروف: ' + arg);
    }
  }
  return options;
}

function normalizeId(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().toUpperCase();
}

function normalizeName(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function report(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

async function importIntoExisting(runtime, engine, students) {
  const existing = await runtime.callInternal('readTable_', ['Students']);
  const ids = new Set();
  const names = new Set();
  (existing || []).forEach((student) => {
    const id = normalizeId(student && student.id);
    const name = normalizeName(student && student.name);
    if (id) ids.add(id);
    if (name) names.add(name);
  });

  const fresh = [];
  const alreadyPresent = [];
  students.forEach((student) => {
    const id = normalizeId(student.id);
    const name = normalizeName(student.name);
    if (ids.has(id) || names.has(name)) {
      alreadyPresent.push(student.id);
      return;
    }
    ids.add(id);
    names.add(name);
    fresh.push(student);
  });

  let added = 0;
  for (let index = 0; index < fresh.length; index += BATCH_SIZE) {
    const rows = fresh.slice(index, index + BATCH_SIZE);
    const result = await runtime.callInternal('importStudents_', [
      { account: { username: 'استيراد الطلاب', id: '' }, requestId: '' },
      { rows }
    ]);
    added += Number(result && result.count) || rows.length;
  }

  // سجّل العمليات في سجل المزامنة عبر onMutation أثناء الاستيراد.
  const counts = runtime.counts();
  return { added, alreadyPresent, counts };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (!options.file) throw new Error('--file مطلوب. استخدم --help لعرض التعليمات.');
  const file = path.resolve(options.file);
  if (!fs.existsSync(file)) throw new Error('الملف غير موجود: ' + file);

  const parsed = parseStudentsBuffer(fs.readFileSync(file));
  const summary = {
    file,
    sheetName: parsed.sheetName,
    total: parsed.total,
    valid: parsed.students.length,
    errors: parsed.errors,
    duplicates: parsed.duplicates
  };

  if (options.dryRun) {
    report(Object.assign({ mode: 'dry-run', wrote: false }, summary));
    return 0;
  }

  if (!options.dataDir) throw new Error('--data-dir مطلوب ما لم تستخدم --dry-run.');
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const logger = new Logger(dataDir, { verbose: false });
  const runtime = new Runtime({ dataDir, logger, deviceName: 'استيراد الطلاب' });
  runtime.init();

  if (options.install) {
    if (runtime.installed) throw new Error('النظام مُجهَّز مسبقًا في هذا المجلد. أزل --install أو استخدم مجلدًا آخر.');
    const result = await runtime.install({
      schoolName: options.school || 'اسم المدرسة',
      systemName: options.system || 'نظام الحضور والانصراف',
      students: parsed.students,
      autoBackup: true
    });
    report(Object.assign({
      mode: 'install',
      wrote: true,
      bookId: result.bookId,
      students: result.students,
      account: result.account
    }, summary));
    return 0;
  }

  if (!runtime.installed) throw new Error('لا يوجد نظام مُهيأ في هذا المجلد. استخدم --install للتهيئة أولًا.');

  const engine = new SyncEngine({
    dataDir,
    store: runtime.store,
    runtime,
    logger,
    deviceName: runtime.store.meta.deviceName
  });
  runtime.onMutation = (changes) => engine.onMutation(changes);

  const result = await importIntoExisting(runtime, engine, parsed.students);
  report(Object.assign({
    mode: 'import',
    wrote: true,
    added: result.added,
    alreadyPresent: result.alreadyPresent,
    counts: result.counts
  }, summary));
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write('فشل الاستيراد: ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
