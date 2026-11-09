'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../vm/runtime');
const { Store } = require('../data/store');

function tempDir(prefix) {
  const base = process.env.OPENCODE_TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix || 'sa-desktop-'));
}

function quietLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function sampleStudents() {
  return [
    { id: 'STU-1001', name: 'أحمد محمد', classroom: 'الصف الأول أ', phone: '0500000001', active: true },
    { id: 'STU-1002', name: 'سارة علي', classroom: 'الصف الأول أ', phone: '0500000002', active: true },
    { id: 'STU-1003', name: 'خالد سعيد', classroom: 'الصف الثاني ب', phone: '', active: true }
  ];
}

function createRuntime(options) {
  const settings = options || {};
  const runtime = new Runtime({
    dataDir: settings.dataDir || tempDir(),
    logger: settings.logger || quietLogger(),
    deviceName: settings.deviceName || 'جهاز اختبار',
    onMutation: settings.onMutation
  });
  runtime.init();
  return runtime;
}

async function installRuntime(options) {
  const settings = options || {};
  const dataDir = settings.dataDir || tempDir();
  const runtime = createRuntime(Object.assign({}, settings, { dataDir }));
  const result = await runtime.install({
    schoolName: settings.schoolName || 'مدرسة الاختبار',
    systemName: settings.systemName || 'نظام الحضور والانصراف',
    students: settings.students === undefined ? sampleStudents() : settings.students,
    autoBackup: settings.autoBackup === undefined ? false : settings.autoBackup
  });
  return { dataDir, runtime, result };
}

function openStore(dataDir) {
  const store = new Store(dataDir, { deviceName: 'جهاز اختبار' });
  store.init();
  return store;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ignored) { /* تجاهل */ }
}

module.exports = {
  tempDir,
  quietLogger,
  sampleStudents,
  createRuntime,
  installRuntime,
  openStore,
  cleanup
};
