'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USER_SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const JSON_ARCHIVE_TAB = 'JSON';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') throw new Error('ملف حساب الخدمة غير صحيح.');
  const required = ['client_email', 'private_key', 'project_id'];
  required.forEach((key) => {
    if (!credentials[key]) throw new Error('ملف حساب الخدمة ينقصه الحقل: ' + key);
  });
  if (String(credentials.private_key).indexOf('BEGIN PRIVATE KEY') < 0) {
    throw new Error('المفتاح الخاص في ملف حساب الخدمة غير صحيح.');
  }
  return {
    client_email: String(credentials.client_email),
    private_key: String(credentials.private_key),
    project_id: String(credentials.project_id),
    client_id: String(credentials.client_id || ''),
    token_uri: String(credentials.token_uri || TOKEN_URL)
  };
}

function loadCredentialsFile(file) {
  const text = readFileSync(file, 'utf8');
  return validateCredentials(JSON.parse(text));
}

class GoogleClient {
  constructor(credentials, options) {
    options = options || {};
    // بديل الرمز: عند ربط حساب Google للمشرف يُمرَّر مزوّد رمز بدل مفتاح حساب الخدمة.
    this.tokenProvider = options.tokenProvider || null;
    this.credentials = this.tokenProvider ? null : validateCredentials(credentials);
    this.logger = options.logger || { debug() {}, warn() {} };
    this.timeoutMs = options.timeoutMs || 30000;
    this.token = '';
    this.tokenExpiry = 0;
  }

  async accessToken() {
    if (this.tokenProvider) return this.tokenProvider();
    if (this.token && Date.now() < this.tokenExpiry - 60000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(JSON.stringify({
      iss: this.credentials.client_email,
      scope: SCOPES.join(' '),
      aud: this.credentials.token_uri || TOKEN_URL,
      iat: now - 30,
      exp: now + 3600
    }));
    const unsigned = header + '.' + claim;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.credentials.private_key);
    const assertion = unsigned + '.' + signature.toString('base64url');
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    });
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }, false);
    if (!response.ok) {
      throw new Error('تعذر الحصول على تصريح Google: ' + (response.data && response.data.error_description ? response.data.error_description : response.status));
    }
    this.token = response.data.access_token;
    this.tokenExpiry = Date.now() + Number(response.data.expires_in || 3600) * 1000;
    return this.token;
  }

  async fetch(url, options, auth) {
    options = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = Object.assign({}, options.headers || {});
      if (auth !== false) headers.authorization = 'Bearer ' + await this.accessToken();
      const response = await fetch(url, Object.assign({}, options, { headers, signal: controller.signal }));
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (error) { data = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        const message = data && data.error && (data.error.message || data.error)
          ? (typeof data.error === 'string' ? data.error : data.error.message)
          : 'HTTP ' + response.status;
        this.logger.warn('google_api_failed', { url: url.split('?')[0], status: response.status, message: String(message).slice(0, 300) });
        const failure = new Error('Google API: ' + message);
        failure.status = response.status;
        failure.data = data;
        throw failure;
      }
      return { ok: true, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async json(url, options) {
    return (await this.fetch(url, options)).data;
  }

  async findFiles(query) {
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: query,
        fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink)',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.json(DRIVE + '/files?' + params.toString());
      (data.files || []).forEach((file) => files.push(file));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async findOrCreateFolder(name, parentId) {
    const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '" + escaped + "'";
    if (parentId) query += " and '" + parentId + "' in parents";
    const found = await this.findFiles(query);
    if (found.length) return found[0];
    const body = {
      name: String(name),
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) body.parents = [parentId];
    return this.json(DRIVE + '/files?fields=id,name,mimeType,webViewLink,supportsAllDrives=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async ensureSpreadsheet(name, folderId) {
    const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let query = "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name = '" + escaped + "'";
    if (folderId) query += " and '" + folderId + "' in parents";
    const found = await this.findFiles(query);
    if (found.length) return found[0];
    const created = await this.json(SHEETS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ properties: { title: String(name), locale: 'ar' } })
    });
    if (folderId) {
      await this.fetch(DRIVE + '/files/' + created.spreadsheetId + '?addParents=' + encodeURIComponent(folderId) + '&fields=id,parents&supportsAllDrives=true', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
    }
    return { id: created.spreadsheetId, name: String(name), mimeType: 'application/vnd.google-apps.spreadsheet' };
  }

  async uploadBuffer(folderId, name, buffer, mimeType) {
    const boundary = 'sa36-' + crypto.randomBytes(12).toString('hex');
    const metadata = { name: String(name), parents: folderId ? [folderId] : undefined };
    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mimeType + '\r\n\r\n',
      'utf8'
    );
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
    const body = Buffer.concat([head, buffer, tail]);
    return this.json(UPLOAD + '/files?uploadType=multipart&fields=id,name,size,createdTime,webViewLink&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'content-type': 'multipart/related; boundary=' + boundary },
      body
    });
  }

  async download(fileId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(DRIVE + '/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', {
        headers: { authorization: 'Bearer ' + await this.accessToken() },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('تعذر تنزيل الملف من Google Drive (' + response.status + ')');
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  async remove(fileId) {
    await this.fetch(DRIVE + '/files/' + encodeURIComponent(fileId) + '?supportsAllDrives=true', { method: 'DELETE' });
  }

  async sheetTitles(spreadsheetId) {
    const data = await this.json(SHEETS + '/' + encodeURIComponent(spreadsheetId) + '?fields=sheets(properties(sheetId,title))');
    return (data.sheets || []).map((sheet) => sheet.properties.title);
  }

  async ensureTabs(spreadsheetId, titles) {
    const existing = await this.sheetTitles(spreadsheetId);
    const missing = titles.filter((title) => !existing.includes(title));
    if (!missing.length) return;
    await this.json(SHEETS + '/' + encodeURIComponent(spreadsheetId) + ':batchUpdate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } }))
      })
    });
  }

  async clearAndWrite(spreadsheetId, title, rows, chunkSize) {
    const quoted = "'" + String(title).replace(/'/g, "''") + "'";
    const size = Math.max(200, Number(chunkSize) || 1500);
    await this.json(SHEETS + '/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(quoted) + ':clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!rows.length) return;
    for (let start = 0; start < rows.length; start += size) {
      const batch = rows.slice(start, start + size);
      const range = quoted + '!A' + (start + 1);
      await this.json(SHEETS + '/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range, majorDimension: 'ROWS', values: batch })
      });
    }
  }

  async writeTabs(spreadsheetId, tabs) {
    await this.ensureTabs(spreadsheetId, tabs.map((tab) => tab.title));
    for (const tab of tabs) {
      await this.clearAndWrite(spreadsheetId, tab.title, tab.rows);
    }
  }

  quotedTitle(title) {
    return "'" + String(title).replace(/'/g, "''") + "'";
  }

  async readTab(spreadsheetId, title) {
    const data = await this.json(
      SHEETS + '/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(this.quotedTitle(title))
    );
    return data.values || [];
  }

  // أرشيف JSON داخل جدول Google. يُستخدم عندما يمنع Google على حساب الخدمة
  // رفع ملفات ثنائية إلى Drive الشخصي (Service Accounts have no storage quota).
  async writeJsonArchive(spreadsheetId, title, name, text) {
    const limit = 45000;
    const body = String(text || '');
    const rows = [['archive', String(name || ''), new Date().toISOString(), String(body.length)]];
    for (let index = 0; index < body.length; index += limit) {
      rows.push([body.slice(index, index + limit)]);
    }
    await this.ensureTabs(spreadsheetId, [title]);
    await this.clearAndWrite(spreadsheetId, title, rows);
    return {
      tab: title,
      name: String(name || ''),
      size: body.length,
      chunks: rows.length - 1
    };
  }

  async readJsonArchive(spreadsheetId, title) {
    const values = await this.readTab(spreadsheetId, title);
    if (!values.length || !values[0] || values[0][0] !== 'archive') return null;
    const text = values.slice(1).map((row) => String((row && row[0]) || '')).join('');
    if (!text) return null;
    let snapshot = null;
    try { snapshot = JSON.parse(text); } catch (error) { throw new Error('أرشيف JSON داخل جدول Google تالف.'); }
    if (!snapshot || !snapshot.tables) throw new Error('أرشيف JSON داخل جدول Google غير صالح.');
    return {
      name: String(values[0][1] || ''),
      createdAt: String(values[0][2] || ''),
      size: text.length,
      text,
      snapshot
    };
  }
}

// ربط حساب Google للمشرف (OAuth + PKCE) للحصول على مساحة Drive حقيقية؛
// حساب الخدمة لا يملك مساحة لرفع الملفات الثنائية.
function validateUserAuth(input) {
  const data = input && typeof input === 'object' ? input : {};
  const clientId = String(data.client_id || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('معرّف عميل OAuth غير صحيح؛ يجب أن ينتهي بـ .apps.googleusercontent.com');
  }
  return {
    client_id: clientId,
    client_secret: String(data.client_secret || '').trim(),
    refresh_token: String(data.refresh_token || ''),
    email: String(data.email || ''),
    scope: String(data.scope || USER_SCOPES),
    linked_at: String(data.linked_at || '')
  };
}

function idTokenEmail(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return '';
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return String(json.email || '');
  } catch (error) {
    return '';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

class GoogleUserAuth {
  constructor(secrets, options) {
    options = options || {};
    this.secrets = secrets;
    this.logger = options.logger || { debug() {}, warn() {} };
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 30000;
    this.token = '';
    this.expiry = 0;
  }

  data() {
    try { return this.secrets.load(); } catch (error) { return null; }
  }

  info() {
    const data = this.data();
    return {
      present: !!(data && data.client_id),
      linked: !!(data && data.refresh_token),
      email: (data && data.email) || '',
      clientId: (data && data.client_id) || ''
    };
  }

  saveClient(input) {
    let source = input;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch (error) { throw new Error('ملف عميل OAuth ليس JSON صالحًا.'); }
    }
    const installed = (source && (source.installed || source.web)) || source || {};
    const clientId = String(installed.client_id || '').trim();
    const existing = this.data();
    const sameClient = !!(existing && existing.client_id === clientId);
    const data = validateUserAuth({
      client_id: clientId,
      client_secret: installed.client_secret,
      refresh_token: sameClient ? existing.refresh_token : '',
      email: sameClient ? existing.email : ''
    });
    this.token = '';
    this.expiry = 0;
    this.secrets.save(data);
    return this.info();
  }

  async begin() {
    const data = this.data();
    if (!data || !data.client_id) throw new Error('ارفع ملف عميل OAuth أولًا.');

    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = 'http://127.0.0.1:' + server.address().port;
    const url = AUTH_URL + '?' + new URLSearchParams({
      client_id: data.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: USER_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();

    let settle = null;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { server.close(); } catch (ignored) { /* مغلق مسبقًا */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(settle.reject, new Error('انتهت مهلة ربط حساب Google؛ أعد المحاولة.')), 5 * 60 * 1000);
    if (timer.unref) timer.unref();

    server.on('request', (req, res) => {
      const page = (status, html) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>ربط حساب Google</title>' +
          '<body style="font-family:system-ui;padding:48px;text-align:center;line-height:1.8">' + html + '</body>');
      };
      let requestUrl;
      try { requestUrl = new URL(req.url, redirectUri); } catch (error) { page(400, 'طلب غير صالح.'); return; }
      if (requestUrl.pathname !== '/') { page(404, 'مسار غير معروف.'); return; }

      const failure = requestUrl.searchParams.get('error');
      if (failure) {
        page(400, 'لم تكتمل الموافقة: ' + escapeHtml(failure));
        finish(settle.reject, new Error('لم تُمنح الموافقة على ربط حساب Google: ' + failure));
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        page(400, 'طلب غير صالح.');
        finish(settle.reject, new Error('طلب ربط غير صالح؛ أعد المحاولة.'));
        return;
      }
      this.exchange(requestUrl.searchParams.get('code'), redirectUri, verifier)
        .then((info) => {
          page(200, 'تم ربط حساب Google بنجاح.<br>يمكنك إغلاق هذه الصفحة والعودة إلى التطبيق.');
          finish(settle.resolve, info);
        })
        .catch((error) => {
          page(500, 'تعذر إكمال الربط. أغلق الصفحة وحاول مرة أخرى.');
          finish(settle.reject, error);
        });
    });

    return {
      url,
      redirectUri,
      state,
      done,
      close: () => { if (!finished) { finished = true; clearTimeout(timer); try { server.close(); } catch (ignored) { /* مغلق */ } } }
    };
  }

  async exchange(code, redirectUri, verifier) {
    if (!code) throw new Error('لم يصل رمز التفويض من Google.');
    const data = this.data();
    if (!data || !data.client_id) throw new Error('ارفع ملف عميل OAuth أولًا.');
    const body = new URLSearchParams({
      client_id: data.client_id,
      code: String(code),
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    if (data.client_secret) body.set('client_secret', data.client_secret);
    const token = await this.tokenRequest(body);
    const email = idTokenEmail(token.id_token) || data.email;
    this.secrets.save(validateUserAuth({
      client_id: data.client_id,
      client_secret: data.client_secret,
      refresh_token: token.refresh_token || data.refresh_token,
      email,
      linked_at: new Date().toISOString()
    }));
    this.token = token.access_token || '';
    this.expiry = Date.now() + Number(token.expires_in || 3600) * 1000;
    this.logger.info('google_user_linked', { email });
    return this.info();
  }

  async tokenRequest(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
      if (!response.ok) {
        const message = data && (data.error_description || data.error)
          ? String(data.error_description || data.error)
          : 'HTTP ' + response.status;
        throw new Error('تعذر الحصول على تصريح Google: ' + message);
      }
      if (!data || !data.access_token) throw new Error('استجابة Google لا تحتوي على رمز وصول.');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async accessToken() {
    if (this.token && Date.now() < this.expiry - 60000) return this.token;
    const data = this.data();
    if (!data || !data.refresh_token) throw new Error('حساب Google غير مرتبط؛ اربطه من تبويب النسخ السحابي.');
    const body = new URLSearchParams({
      client_id: data.client_id,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token'
    });
    if (data.client_secret) body.set('client_secret', data.client_secret);
    const token = await this.tokenRequest(body);
    this.token = token.access_token;
    this.expiry = Date.now() + Number(token.expires_in || 3600) * 1000;
    return this.token;
  }

  client() {
    return new GoogleClient(null, { tokenProvider: () => this.accessToken(), logger: this.logger });
  }

  remove() {
    this.token = '';
    this.expiry = 0;
    return this.secrets.remove();
  }
}

module.exports = {
  GoogleClient,
  GoogleUserAuth,
  validateCredentials,
  validateUserAuth,
  idTokenEmail,
  loadCredentialsFile,
  SCOPES,
  USER_SCOPES,
  JSON_ARCHIVE_TAB
};
