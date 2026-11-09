'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir, readJson, writeJsonAtomic } = require('./atomic');

// تخزين آمن لبيانات حساب الخدمة. في Electron يستخدم DPAPI عبر safeStorage،
// وفي الاختبارات أو البيئات بلا تشفير متاح يُستخدم AES-GCM بمفتاح محلي.
class Secrets {
  constructor(dataDir, options) {
    this.dir = path.join(dataDir, 'secrets');
    this.file = path.join(this.dir, 'service-account.enc');
    this.metaFile = path.join(this.dir, 'service-account.meta.json');
    this.keyFile = path.join(this.dir, 'local.key');
    this.safeStorage = (options && options.safeStorage) || null;
    ensureDir(this.dir);
  }

  available() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable && this.safeStorage.isEncryptionAvailable());
    } catch (error) {
      return false;
    }
  }

  localKey() {
    if (!fs.existsSync(this.keyFile)) {
      fs.writeFileSync(this.keyFile, crypto.randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 });
    }
    return Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
  }

  encrypt(text) {
    if (this.available()) {
      const buffer = this.safeStorage.encryptString(text);
      return { mode: 'dpapi', data: Buffer.from(buffer).toString('base64') };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.localKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { mode: 'aes', data: Buffer.concat([iv, tag, encrypted]).toString('base64') };
  }

  decrypt(payload) {
    const data = Buffer.from(payload.data, 'base64');
    if (payload.mode === 'dpapi') {
      if (!this.available()) throw new Error('بيانات الاعتماد مشفّرة بنظام Windows ولا يمكن فتحها في هذه البيئة.');
      return this.safeStorage.decryptString(data);
    }
    if (payload.mode === 'aes') {
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const body = data.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.localKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }
    throw new Error('صيغة بيانات الاعتماد غير معروفة.');
  }

  save(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('بيانات حساب الخدمة غير صالحة.');
    }
    if (!String(credentials.client_email || '').includes('@')) {
      throw new Error('بيانات حساب الخدمة تفتقد البريد الإلكتروني client_email.');
    }
    if (!String(credentials.project_id || '').trim()) {
      throw new Error('بيانات حساب الخدمة تفتقد معرف المشروع project_id.');
    }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(credentials.private_key || ''))) {
      throw new Error('المفتاح الخاص في بيانات حساب الخدمة غير صالح.');
    }
    const text = JSON.stringify(credentials);
    const payload = this.encrypt(text);
    fs.writeFileSync(this.file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    writeJsonAtomic(this.metaFile, {
      present: true,
      clientEmail: String(credentials.client_email || ''),
      projectId: String(credentials.project_id || ''),
      protectedBy: payload.mode === 'dpapi' ? 'Windows DPAPI' : 'AES-256-GCM محلي',
      savedAt: new Date().toISOString()
    });
    return this.info();
  }

  load() {
    if (!fs.existsSync(this.file)) return null;
    const payload = readJson(this.file, null);
    if (!payload) throw new Error('ملف بيانات الاعتماد تالف.');
    const text = this.decrypt(payload);
    const credentials = JSON.parse(text);
    if (!credentials || !credentials.client_email) throw new Error('بيانات الاعتماد غير صالحة.');
    return credentials;
  }

  info() {
    const meta = readJson(this.metaFile, {});
    if (!fs.existsSync(this.file)) return { present: false, clientEmail: '', projectId: '', protectedBy: '', savedAt: '' };
    return {
      present: true,
      clientEmail: meta.clientEmail || '',
      projectId: meta.projectId || '',
      protectedBy: meta.protectedBy || '',
      savedAt: meta.savedAt || ''
    };
  }

  remove() {
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.unlinkSync(this.metaFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { present: false };
  }
}

module.exports = { Secrets };
