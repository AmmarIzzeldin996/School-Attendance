'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } = require('../lib/atomic');
const { Mutex } = require('../lib/mutex');
const { GoogleClient, validateCredentials, JSON_ARCHIVE_TAB } = require('./google');
const { readableTabs, writeWorkbook } = require('./workbook');

const DEFAULT_FOLDER = 'School Attendance Backups';
const DEFAULT_SHEET = 'School Attendance Backup';

function stampForFile(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function cleanName(value, fallback) {
  return String(value || fallback || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || fallback;
}

// حسابات الخدمة لا تملك مساحة تخزين في Drive الشخصي. في هذه الحالة نحفظ
// أرشيف JSON داخل جدول Google بدلًا من ملف .json.
function isStorageQuotaError(error) {
  const message = String((error && error.message) || '').toLowerCase();
  return Number(error && error.status) === 403 &&
    (message.includes('storage quota') || message.includes('does not have storage') || message.includes('no storage'));
}

class BackupManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.store = options.store;
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.secrets = options.secrets;
    this.deviceName = options.deviceName || 'جهاز الحضور';
    this.deviceId = options.deviceId || this.store.meta.deviceId;
    this.dir = path.join(this.dataDir, 'backup');
    this.exportDir = path.join(this.dataDir, 'backups', 'exports');
    this.configFile = path.join(this.dir, 'config.json');
    this.stateFile = path.join(this.dir, 'state.json');
    this.mutex = new Mutex();
    this.busy = false;
    ensureDir(this.dir);
    ensureDir(this.exportDir);
    this.config = Object.assign({
      enabled: true,
      auto: true,
      folderName: DEFAULT_FOLDER,
      spreadsheetName: DEFAULT_SHEET,
      spreadsheetId: '',
      folderId: ''
    }, readJson(this.configFile, {}));
    this.state = Object.assign({
      lastRunAt: '',
      lastSuccessAt: '',
      lastCloudAt: '',
      lastAutoDate: '',
      lastError: '',
      lastFile: '',
      lastCloudFile: '',
      lastArchiveMode: '',
      lastArchiveNote: '',
      lastCounts: null
    }, readJson(this.stateFile, {}));
  }

  saveConfig() { writeJsonAtomic(this.configFile, this.config); }

  saveState() { writeJsonAtomic(this.stateFile, this.state); }

  credentialsInfo() {
    try { return this.secrets.info(); } catch (error) { return { present: false, error: error.message }; }
  }

  configured() {
    return !!this.credentialsInfo().present;
  }

  saveCredentials(input) {
    let credentials;
    if (Buffer.isBuffer(input)) {
      try { credentials = JSON.parse(input.toString('utf8')); } catch (error) { throw new Error('ملف حساب الخدمة ليس JSON صالحًا.'); }
    } else if (typeof input === 'string') {
      try { credentials = JSON.parse(input); } catch (error) { throw new Error('ملف حساب الخدمة ليس JSON صالحًا.'); }
    } else {
      credentials = input;
    }
    const clean = validateCredentials(credentials);
    return this.secrets.save(clean);
  }

  removeCredentials() {
    this.secrets.remove();
    this.state.lastError = '';
    this.saveState();
    return { ok: true };
  }

  configure(input) {
    this.config.enabled = input && input.enabled !== false;
    if (input && input.auto !== undefined) this.config.auto = input.auto !== false;
    if (input && input.folderName) this.config.folderName = cleanName(input.folderName, DEFAULT_FOLDER);
    if (input && input.spreadsheetName) this.config.spreadsheetName = cleanName(input.spreadsheetName, DEFAULT_SHEET);
    if (input && input.spreadsheetId !== undefined) this.config.spreadsheetId = String(input.spreadsheetId || '').trim();
    this.saveConfig();
    return this.status();
  }

  status() {
    return {
      configured: this.configured(),
      credentials: this.credentialsInfo(),
      config: {
        enabled: this.config.enabled !== false,
        auto: this.config.auto !== false,
        folderName: this.config.folderName,
        spreadsheetName: this.config.spreadsheetName,
        spreadsheetId: this.config.spreadsheetId,
        folderId: this.config.folderId
      },
      state: this.state,
      busy: this.busy
    };
  }

  client() {
    const credentials = this.secrets.load();
    if (!credentials) throw new Error('لم تُضف بيانات حساب خدمة Google بعد.');
    return new GoogleClient(credentials, { logger: this.logger });
  }

  async ensureRemote(client) {
    const parentId = process.env.SCHOOL_ATTENDANCE_DRIVE_PARENT || '';
    const folder = await client.findOrCreateFolder(this.config.folderName, parentId);
    this.config.folderId = folder.id;
    this.saveConfig();

    let spreadsheet = null;
    if (this.config.spreadsheetId) {
      spreadsheet = { id: this.config.spreadsheetId, name: this.config.spreadsheetName };
    } else {
      const escaped = String(this.config.spreadsheetName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const found = await client.findFiles(
        "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name = '" + escaped + "'"
      );
      if (found.length) spreadsheet = { id: found[0].id, name: found[0].name, url: found[0].webViewLink };
      else spreadsheet = await client.ensureSpreadsheet(this.config.spreadsheetName, folder.id);
      this.config.spreadsheetId = spreadsheet.id;
      this.saveConfig();
    }
    return { folder, spreadsheet };
  }

  async testConnection() {
    const client = this.client();
    const remote = await this.ensureRemote(client);
    return {
      email: client.credentials.client_email,
      folderId: remote.folder.id,
      folderName: remote.folder.name,
      folderUrl: 'https://drive.google.com/drive/folders/' + remote.folder.id,
      spreadsheetId: remote.spreadsheet.id,
      spreadsheetName: remote.spreadsheet.name || this.config.spreadsheetName,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + remote.spreadsheet.id
    };
  }

  createLocalBackup() {
    return this.runtime.callInternal('createBackup_', [{
      account: { username: 'النسخ السحابي', id: '' },
      requestId: ''
    }]);
  }

  pruneExports(keep) {
    const limit = Math.max(2, Number(keep) || 30);
    let files = [];
    try {
      files = fs.readdirSync(this.exportDir)
        .filter((name) => /^(attendance-.*\.json|attendance-.*\.xlsx)$/.test(name))
        .map((name) => ({ name, time: fs.statSync(path.join(this.exportDir, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
    } catch (error) { return 0; }
    let removed = 0;
    files.slice(limit * 2).forEach((file) => {
      try { fs.unlinkSync(path.join(this.exportDir, file.name)); removed += 1; } catch (ignored) { /* تجاهل */ }
    });
    return removed;
  }

  async runNow(reason) {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    return this.mutex.run(async () => {
      const startedAt = new Date();
      this.state.lastRunAt = startedAt.toISOString();
      try {
        if (!this.runtime.installed) throw new Error('لم يُجهَّز النظام بعد.');
        const settings = await this.runtime.callInternal('readSettings_', []);
        const local = await this.createLocalBackup();
        const snapshot = this.runtime.snapshot();
        const stamp = stampForFile(startedAt);
        const jsonName = 'attendance-' + this.deviceId + '-' + stamp + '.json';
        const jsonText = JSON.stringify(snapshot, null, 2);
        writeTextAtomic(path.join(this.exportDir, jsonName), jsonText);
        const xlsxName = jsonName.replace(/\.json$/, '.xlsx');
        const xlsx = writeWorkbook(snapshot);
        writeTextAtomic(path.join(this.exportDir, xlsxName), xlsx);
        this.pruneExports(settings.retention);
        this.state.lastFile = local && local.id ? local.id : '';
        this.state.lastCounts = local && local.counts ? local.counts : null;

        let cloud = null;
        if (this.configured() && this.config.enabled !== false) {
          cloud = await this.uploadToCloud(snapshot, jsonName, jsonText, xlsxName, xlsx, settings, reason);
          this.state.lastCloudAt = new Date().toISOString();
          this.state.lastCloudFile = cloud.json && cloud.json.id
            ? cloud.json.id
            : (cloud.archiveMode === 'google-sheet' ? 'tab:' + JSON_ARCHIVE_TAB : '');
          this.state.lastArchiveMode = cloud.archiveMode || '';
          this.state.lastArchiveNote = cloud.archiveNote || '';
        }

        this.state.lastSuccessAt = new Date().toISOString();
        this.state.lastError = '';
        this.saveState();
        this.store.setProperty('LAST_CLOUD_BACKUP', this.state.lastSuccessAt);
        this.store.save();
        try {
          await this.runtime.callInternal('audit_', [{
            account: { username: 'النسخ السحابي', id: '' },
            requestId: ''
          }, 'نسخ احتياطي سحابي', {
            targetType: 'backup',
            targetId: (cloud && cloud.json && cloud.json.id) || this.state.lastFile,
            details: 'محلي: ' + jsonName + ' | سحابي: ' + (cloud ? 'نعم' : 'لا') + ' | السبب: ' + (reason || 'يدوي')
          }]);
        } catch (error) {
          this.logger.warn('backup_audit_failed', { message: error.message });
        }
        return {
          ok: true,
          local: { id: this.state.lastFile, counts: this.state.lastCounts, jsonName, xlsxName },
          cloud
        };
      } catch (error) {
        this.state.lastError = (error && error.message ? error.message : 'تعذر النسخ الاحتياطي') + ' — ' + new Date().toISOString();
        this.saveState();
        this.logger.error('backup_failed', { message: error && error.message });
        try {
          await this.runtime.callInternal('log_', ['ERROR', 'desktop_backup_failed', { message: String(error.message || '').slice(0, 300) }]);
        } catch (ignored) { /* تسجيل إضافي فقط */ }
        throw error;
      } finally {
        this.busy = false;
      }
    });
  }

  async uploadToCloud(snapshot, jsonName, jsonText, xlsxName, xlsx, settings, reason) {
    const client = this.client();
    const remote = await this.ensureRemote(client);

    // الجدول المقروء أولًا: هذا المسار يعمل دائمًا مع حساب الخدمة.
    await client.writeTabs(remote.spreadsheet.id, readableTabs(snapshot));

    let json = null;
    let excel = null;
    let archiveMode = 'drive-files';
    let archiveNote = '';
    try {
      json = await client.uploadBuffer(remote.folder.id, jsonName, Buffer.from(jsonText, 'utf8'), 'application/json');
      excel = await client.uploadBuffer(
        remote.folder.id,
        xlsxName,
        xlsx,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
      // بديل موثّق: أرشيف JSON داخل تبويب في جدول Google نفسه.
      await client.writeJsonArchive(remote.spreadsheet.id, JSON_ARCHIVE_TAB, jsonName, jsonText);
      archiveMode = 'google-sheet';
      archiveNote = 'حساب الخدمة لا يملك مساحة Drive لرفع ملفات ثنائية؛ حُفظ أرشيف JSON داخل تبويب «' +
        JSON_ARCHIVE_TAB + '» في جدول Google. النسختان المحليتان JSON وXLSX محفوظتان على الجهاز.';
      this.logger.warn('backup_drive_quota_fallback', { tab: JSON_ARCHIVE_TAB, size: jsonText.length });
    }

    let pruned = 0;
    if (json) {
      const prefix = "name contains 'attendance-" + this.deviceId + "-' and trashed = false";
      let old = [];
      try {
        old = await client.findFiles(prefix + " and '" + remote.folder.id + "' in parents");
      } catch (error) {
        this.logger.warn('backup_list_failed', { message: error.message });
      }
      const limit = Math.max(2, Number(settings.retention) || 30);
      const keep = old
        .filter((file) => /\.json$/.test(file.name))
        .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
      for (const file of keep.slice(limit)) {
        try { await client.remove(file.id); pruned += 1; } catch (error) {
          this.logger.warn('backup_prune_failed', { file: file.id, message: error.message });
        }
      }
    }
    return {
      json,
      excel,
      folderId: remote.folder.id,
      folderUrl: 'https://drive.google.com/drive/folders/' + remote.folder.id,
      spreadsheetId: remote.spreadsheet.id,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + remote.spreadsheet.id,
      pruned,
      reason: reason || '',
      archiveMode,
      archiveNote
    };
  }

  async importLatest() {
    return this.mutex.run(async () => {
      const client = this.client();
      const remote = await this.ensureRemote(client);
      let files = [];
      try {
        files = await client.findFiles(
          "name contains 'attendance-' and trashed = false and '" + remote.folder.id + "' in parents and mimeType = 'application/json'"
        );
      } catch (error) {
        this.logger.warn('backup_list_failed', { message: error.message });
      }
      if (!files.length) {
        try {
          const all = await client.findFiles("name contains 'attendance-' and trashed = false and '" + remote.folder.id + "' in parents");
          files = all.filter((file) => /\.json$/.test(file.name));
        } catch (error) {
          this.logger.warn('backup_list_failed', { message: error.message });
        }
      }

      const folder = await this.runtime.callInternal('backupFolder_', []);
      const folderId = folder.getId();

      if (files.length) {
        const latest = files.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))[0];
        const buffer = await client.download(latest.id);
        const target = this.store.createFile(folderId, 'cloud-' + latest.name, buffer.toString('utf8'));
        this.store.save();
        this.logger.info('backup_cloud_imported', { file: latest.name, mode: 'drive-files' });
        return {
          name: latest.name,
          id: target.id,
          createdAt: latest.createdTime,
          size: buffer.length,
          spreadsheetId: remote.spreadsheet.id,
          archiveMode: 'drive-files'
        };
      }

      const archived = await client.readJsonArchive(remote.spreadsheet.id, JSON_ARCHIVE_TAB);
      if (!archived) throw new Error('لا توجد نسخة احتياطية سحابية قابلة للاستعادة.');
      const name = archived.name || ('attendance-' + JSON_ARCHIVE_TAB + '.json');
      const target = this.store.createFile(folderId, 'cloud-' + name, archived.text);
      this.store.save();
      this.logger.info('backup_cloud_imported', { file: name, mode: 'google-sheet' });
      return {
        name,
        id: target.id,
        createdAt: archived.createdAt,
        size: archived.size,
        spreadsheetId: remote.spreadsheet.id,
        archiveMode: 'google-sheet'
      };
    });
  }

  // نسخ تلقائي يومي في وقت الإعدادات؛ لا يعيد النسخ لنفس اليوم.
  async tick() {
    if (!this.runtime.installed || this.busy) return { skipped: 'idle' };
    let settings;
    try { settings = await this.runtime.callInternal('readSettings_', []); } catch (error) { return { skipped: 'settings' }; }
    if (this.config.auto === false || this.config.enabled === false) return { skipped: 'disabled' };
    if (!this.configured()) return { skipped: 'not_configured' };
    const now = new Date();
    const timeZone = 'Asia/Riyadh';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
    }).formatToParts(now);
    const map = {};
    parts.forEach((part) => { map[part.type] = part.value; });
    const date = map.year + '-' + map.month + '-' + map.day;
    const clock = (map.hour === '24' ? '00' : map.hour) + ':' + map.minute;
    if (clock < String(settings.backupTime || '15:00')) return { skipped: 'not_due' };
    if (this.state.lastAutoDate === date) return { skipped: 'done' };
    const result = await this.runNow('auto');
    this.state.lastAutoDate = date;
    this.saveState();
    return result;
  }
}

module.exports = { BackupManager, stampForFile, DEFAULT_FOLDER, DEFAULT_SHEET };
