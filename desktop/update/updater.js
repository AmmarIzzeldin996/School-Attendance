'use strict';

// فحص تحديثات التطبيق: ملف update.json على GitHub يعلن الإصدار ورابط المثبّت.
// التثبيت فوق الإصدار القديم يحفظ البيانات؛ هذا الفحص لا يلمس أي بيانات محلية.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/Ammarlzzeldin996/School-Attendance/main/update.json';

function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  for (let i = 0; i < 3; i += 1) {
    const x = Number(pa[i]) || 0;
    const y = Number(pb[i]) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// لا يثق بالبيان إلا بعد فحص كل حقل: إصدار رقمي، رابط https، اسم مثبّت exe.
function parseManifest(data, currentVersion) {
  if (!data || typeof data !== 'object') throw new Error('ملف التحديث غير صالح.');
  const version = String(data.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('إصدار التحديث غير صالح.');
  const url = String(data.url || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('رابط التحديث يجب أن يكون https.');
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (error) { name = ''; }
  if (!/^[\w.-]+\.exe$/i.test(name)) throw new Error('رابط التحديث لا يشير إلى مثبّت exe.');
  const sha256 = String(data.sha256 || '').trim().toLowerCase();
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('بصمة sha256 في ملف التحديث غير صالحة.');
  return {
    version,
    url,
    name,
    notes: String(data.notes || ''),
    sha256,
    newer: compareVersions(version, currentVersion) > 0
  };
}

class Updater {
  constructor(options) {
    options = options || {};
    this.manifestUrl = options.manifestUrl || process.env.SCHOOL_ATTENDANCE_UPDATE_URL || DEFAULT_MANIFEST_URL;
    this.currentVersion = options.currentVersion || '';
    this.downloadDir = options.downloadDir;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 60000;
    this.logger = options.logger || { debug() {}, warn() {}, info() {} };
    this.state = { checkedAt: '', error: '', available: false, manifest: null, downloaded: '' };
  }

  status() {
    return Object.assign({ manifestUrl: this.manifestUrl, currentVersion: this.currentVersion }, this.state);
  }

  async check() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.manifestUrl, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error('تعذر قراءة ملف التحديث (HTTP ' + response.status + ').');
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = null; }
      const manifest = parseManifest(data, this.currentVersion);
      this.state = {
        checkedAt: new Date().toISOString(),
        error: '',
        available: manifest.newer,
        manifest,
        downloaded: ''
      };
      this.logger.info('update_checked', { remote: manifest.version, current: this.currentVersion, available: manifest.newer });
      return this.status();
    } catch (error) {
      this.state.checkedAt = new Date().toISOString();
      this.state.error = error.message || 'تعذر فحص التحديث.';
      this.logger.warn('update_check_failed', { message: this.state.error });
      return this.status();
    } finally {
      clearTimeout(timer);
    }
  }

  async download() {
    const manifest = this.state.manifest;
    if (!manifest || !manifest.newer) throw new Error('لا يوجد تحديث متاح للتنزيل.');
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const target = path.join(this.downloadDir, manifest.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const response = await this.fetchImpl(manifest.url, { signal: controller.signal });
      if (!response.ok) throw new Error('تعذر تنزيل التحديث (HTTP ' + response.status + ').');
      const buffer = Buffer.from(await response.arrayBuffer());
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      if (manifest.sha256 && digest !== manifest.sha256) {
        this.logger.warn('update_sha_mismatch', { expected: manifest.sha256, got: digest });
        throw new Error('بصمة الملف المنزّل لا تطابق sha256 المعلن؛ أُلغي الحفظ.');
      }
      if (!manifest.sha256) this.logger.warn('update_sha_missing', { version: manifest.version });
      fs.writeFileSync(target, buffer);
      this.state.downloaded = target;
      this.logger.info('update_downloaded', { version: manifest.version, bytes: buffer.length });
      return this.status();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { Updater, compareVersions, parseManifest, DEFAULT_MANIFEST_URL };
