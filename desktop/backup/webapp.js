'use strict';

// عميل WEB APP للنسخ السحابي: بلا Google Cloud ولا OAuth، رابط /exec وسر مستقل.
const WEBAPP_URL = /^https:\/\/script\.google(?:usercontent)?\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

function validateCloudConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('بيانات السحابة غير صحيحة.');
  const url = String(input.url || '').trim();
  const secret = String(input.secret || '').trim();
  if (!WEBAPP_URL.test(url)) {
    throw new Error('رابط Web App غير صحيح. يجب أن يبدأ بـ https://script.google.com/macros/s/ وينتهي بـ /exec.');
  }
  if (secret.length < 16) throw new Error('كلمة النسخ السحابي غير صحيحة (الحد الأدنى 16 حرفًا).');
  return { url, secret };
}

function describeCloudConfig(config) {
  return { email: config.url, project: '' };
}

class WebAppClient {
  constructor(config, options = {}) {
    this.config = validateCloudConfig(config);
    this.timeoutMs = options.timeoutMs || 120000;
  }

  async call(action, payload = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ action, secret: this.config.secret, payload }),
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = null; }
      if (!data || typeof data.success !== 'boolean') {
        throw new Error('ردّ السكربت ليس JSON. تأكد من نشره كـ Web app بصلاحية وصول عامة.');
      }
      if (!data.success) throw new Error(data.message || 'فشل طلب السحابة (' + data.code + ').');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return data.data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بالسحابة.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  list() { return this.call('cloudBackupList'); }
  put(snapshot) { return this.call('cloudBackupPut', { snapshot }); }
  get(id) { return this.call('cloudBackupGet', { id }); }
}

module.exports = { WebAppClient, validateCloudConfig, describeCloudConfig };
