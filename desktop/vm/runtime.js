'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../data/store');
const { createServices } = require('./services');
const { Mutex } = require('../lib/mutex');
const { requestId, uuid } = require('../lib/ids');

function sourcePath() {
  if (process.env.SCHOOL_ATTENDANCE_SRC) return path.resolve(process.env.SCHOOL_ATTENDANCE_SRC);
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'app-src');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.resolve(__dirname, '..', '..', 'src');
}

function loadSources() {
  const dir = sourcePath();
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.gs')).sort();
  if (!files.length) throw new Error('لم تُعثر على ملفات النظام في ' + dir);
  return {
    dir,
    code: files.map((name) => '\n// ==== ' + name + ' ====\n' + fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
  };
}

function errorEnvelope(error, id) {
  return {
    success: false,
    code: (error && error.code) || 'INTERNAL',
    message: (error && error.message) || 'تعذر تنفيذ العملية.',
    data: null,
    timestamp: new Date().toISOString(),
    requestId: id || ''
  };
}

class Runtime {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.onMutation = options.onMutation || function () {};
    this.store = new Store(this.dataDir, { deviceName: options.deviceName });
    this.mutex = new Mutex();
    this.sandbox = null;
    this.sources = null;
    this.renderCache = null;
    this.installed = false;
    this.role = 'primary';
  }

  init() {
    this.store.init();
    this.installed = !!this.store.meta.installed;
    this.role = this.store.meta.role || 'primary';
    return this;
  }

  loadContext() {
    if (this.sandbox) return this.sandbox;
    this.sources = loadSources();
    const services = createServices(this.store, { logger: this.logger, email: this.store.meta.ownerEmail || 'owner@school.local' });
    this.services = services;
    const sandbox = services.sandbox;
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(this.sources.code, sandbox, { filename: 'school-attendance-bundle.gs' });
    this.sandbox = sandbox;
    return sandbox;
  }

  setSessionEmail(email) {
    if (this.services) this.services.session.email = String(email || 'owner@school.local').toLowerCase();
  }

  // بعد تطبيق عمليات المزامنة مباشرة على المتجر، يجب إسقاط ذاكرة الصفوف
  // داخل الـVM كي لا يقرأ النظام بيانات قديمة.
  clearCache() {
    if (!this.sandbox) return;
    try {
      if (typeof this.sandbox.clearCache_ === 'function') this.sandbox.clearCache_();
    } catch (error) {
      this.logger.warn('sandbox_cache_clear_failed', { message: error && error.message });
    }
  }

  requireContext() {
    if (!this.installed) {
      const error = new Error('لم يُجهَّز النظام بعد. أكمل الإعداد الأول.');
      error.code = 'SETUP_REQUIRED';
      throw error;
    }
    return this.loadContext();
  }

  finishMutation(changes) {
    if (!changes) return;
    if (!changes.rows.length && !changes.props.length && !changes.bulkReset) return;
    try {
      this.onMutation(changes);
    } catch (error) {
      this.logger.error('mutation_journal_failed', { message: error && error.message });
    }
  }

  callApi(request) {
    return this.mutex.run(() => {
      const sandbox = this.requireContext();
      const id = (request && request.requestId) || requestId();
      const action = request && request.action;
      this.store.beginCapture();
      let result;
      try {
        result = sandbox.api(request);
      } catch (error) {
        this.finishMutation(this.store.endCapture());
        this.store.save();
        this.logger.error('api_crash', { action, message: error && error.message });
        return errorEnvelope(error, id);
      }
      const changes = this.store.endCapture();
      this.finishMutation(changes);
      this.store.save();
      if (result && result.success && result.data) {
        if (action === 'bootstrap') result.data.ssoEnabled = false;
        if (action === 'publicConfig') result.data.ssoAvailable = false;
      }
      return result;
    });
  }

  callInternal(name, args) {
    return this.mutex.run(() => {
      const sandbox = this.loadContext();
      if (typeof sandbox[name] !== 'function') throw new Error('unknown server function: ' + name);
      this.store.beginCapture();
      try {
        return sandbox[name].apply(sandbox, args || []);
      } finally {
        this.finishMutation(this.store.endCapture());
        this.store.save();
      }
    });
  }

  getPublicConfig() {
    if (!this.installed) {
      return {
        systemName: 'نظام الحضور والانصراف',
        schoolName: '',
        version: '3.6.0',
        ssoAvailable: false,
        desktop: true
      };
    }
    try {
      const config = this.callRaw('publicConfig_') || {};
      return {
        systemName: config.systemName || 'نظام الحضور والانصراف',
        schoolName: config.schoolName || '',
        version: config.version || '3.6.0',
        ssoAvailable: false,
        desktop: true
      };
    } catch (error) {
      this.logger.warn('public_config_failed', { message: error && error.message });
      return { systemName: 'نظام الحضور والانصراف', schoolName: '', version: '3.6.0', ssoAvailable: false, desktop: true };
    }
  }

  callRaw(name) {
    const sandbox = this.loadContext();
    if (typeof sandbox[name] !== 'function') throw new Error('unknown server function: ' + name);
    return sandbox[name]();
  }

  // يتحقق من رمز جلسة واجهة الإدارة ويُرجع الحساب العام (بالصلاحيات) أو null.
  // يُستخدم لحماية مسارات /desktop/* من أي طلب محلي غير مُصادق.
  resolveSession(token) {
    if (!this.installed) return null;
    const raw = String(token || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return null;
    try {
      const sandbox = this.loadContext();
      const account = sandbox.sessionAccount_(raw);
      if (!account || !account.active) return null;
      return sandbox.publicAccount_(account);
    } catch (error) {
      this.logger.warn('session_resolve_failed', { message: error && error.message });
      return null;
    }
  }

  install(options) {
    return this.mutex.run(() => {
      if (this.installed) {
        const error = new Error('النظام مُجهَّز مسبقًا على هذا الجهاز.');
        error.code = 'ALREADY_INSTALLED';
        throw error;
      }
      if (this.sandbox) throw new Error('runtime already loaded');
      const before = this.store.snapshotWorkbook();
      const beforeMeta = JSON.parse(JSON.stringify(this.store.meta));
      const sandbox = this.loadContext();
      this.store.beginCapture();
      try {
        const account = sandbox.installSchool();
        const settings = sandbox.readSettings_();
        settings.systemName = String(options.systemName || settings.systemName || 'نظام الحضور والانصراف').slice(0, 100);
        settings.schoolName = String(options.schoolName || settings.schoolName || 'اسم المدرسة').slice(0, 100);
        if (options.autoBackup !== undefined) settings.autoBackup = !!options.autoBackup;
        if (options.backupTime) settings.backupTime = String(options.backupTime).slice(0, 5);
        sandbox.setSettings_(settings);
        if (Array.isArray(options.students) && options.students.length) {
          sandbox.importStudents_({ account: { username: 'setup', id: '' }, requestId: '' }, { rows: options.students });
        }
        this.store.meta.installed = true;
        this.store.meta.role = 'primary';
        this.store.meta.ownerEmail = 'owner@school.local';
        this.store.meta.installedAt = new Date().toISOString();
        this.store.meta.appVersion = '3.6.0';
        this.installed = true;
        this.role = 'primary';
        this.finishMutation(this.store.endCapture());
        this.store.save();
        return {
          account: account && account.account ? account.account : account,
          students: sandbox.readTable_('Students').length,
          bookId: this.store.workbook.bookId
        };
      } catch (error) {
        this.store.endCapture();
        this.store.replaceWorkbook(before.workbook, before.properties);
        this.store.meta = beforeMeta;
        this.store.saveMeta();
        this.installed = false;
        this.sandbox = null;
        this.services = null;
        this.logger.error('install_failed', { message: error && error.message });
        throw error;
      }
    });
  }

  join(payload) {
    return this.mutex.run(() => {
      if (!payload || !payload.workbook || !payload.workbook.sheets) throw new Error('بيانات المزامنة غير صحيحة');
      const before = this.store.snapshotWorkbook();
      try {
        const properties = Object.assign({}, payload.properties || {});
        properties.DB_ID = payload.workbook.bookId;
        this.store.replaceWorkbook(payload.workbook, properties);
        this.store.meta.installed = true;
        this.store.meta.role = 'replica';
        this.store.meta.ownerEmail = payload.ownerEmail || this.store.meta.ownerEmail || 'owner@school.local';
        this.store.meta.joinedAt = new Date().toISOString();
        this.store.meta.appVersion = '3.6.0';
        this.store.saveMeta();
        this.installed = true;
        this.role = 'replica';
        this.sandbox = null;
        this.services = null;
        const sandbox = this.loadContext();
        return {
          students: sandbox.readTable_('Students').length,
          records: sandbox.readTable_('Attendance').length,
          bookId: this.store.workbook.bookId
        };
      } catch (error) {
        this.store.replaceWorkbook(before.workbook, before.properties);
        this.installed = false;
        this.sandbox = null;
        this.services = null;
        throw error;
      }
    });
  }

  snapshot() {
    const sandbox = this.requireContext();
    return sandbox.snapshot_();
  }

  maintenance() {
    if (!this.installed) return { skipped: 'not_installed' };
    return this.mutex.run(() => {
      const sandbox = this.requireContext();
      this.store.beginCapture();
      try {
        return sandbox.maintenance_();
      } finally {
        this.finishMutation(this.store.endCapture());
        this.store.save();
      }
    });
  }

  recoverAdmin() {
    return this.mutex.run(() => {
      const sandbox = this.requireContext();
      this.store.beginCapture();
      try {
        return sandbox.recoverSupervisorPassword_();
      } finally {
        this.finishMutation(this.store.endCapture());
        this.store.save();
      }
    });
  }

  counts() {
    if (!this.installed) return { students: 0, records: 0, days: 0, trips: 0 };
    try {
      const sandbox = this.loadContext();
      return {
        students: sandbox.readTable_('Students').length,
        records: sandbox.readTable_('Attendance').length,
        days: sandbox.readTable_('Days').length,
        trips: sandbox.readTable_('Journeys').length
      };
    } catch (error) {
      return { students: 0, records: 0, days: 0, trips: 0 };
    }
  }

  databaseJson() {
    return JSON.stringify(this.store.workbook, null, 2);
  }

  renderIndex() {
    if (!this.renderCache) {
      const dir = sourcePath();
      const index = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
      const rendered = index.replace(/<\?!= include\('([^']+)'\) \?>/g, (_match, name) => {
        const file = path.join(dir, name + '.html');
        if (!fs.existsSync(file)) throw new Error('include missing: ' + name);
        return fs.readFileSync(file, 'utf8');
      });
      this.renderCache = rendered
        .replace('<?!= configJson ?>', '__APP_CONFIG_JSON__')
        .replace(
          '<script>SA.boot();</script>',
          '<link rel="stylesheet" href="/desktop/desktop-settings.css">\n  <script src="/desktop/bridge.js"></script>\n  <script src="/desktop/desktop-settings.js"></script>\n  <script>SA.boot();</script>'
        );
    }
    const config = this.getPublicConfig();
    const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return this.renderCache.replace('__APP_CONFIG_JSON__', json);
  }

  static newRequestId() { return 'rq_' + uuid().replace(/-/g, '').slice(0, 20); }
}

module.exports = { Runtime, loadSources, sourcePath };
