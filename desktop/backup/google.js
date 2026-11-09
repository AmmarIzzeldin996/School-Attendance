'use strict';

const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
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
    this.credentials = validateCredentials(credentials);
    this.logger = (options && options.logger) || { debug() {}, warn() {} };
    this.timeoutMs = (options && options.timeoutMs) || 30000;
    this.token = '';
    this.tokenExpiry = 0;
  }

  async accessToken() {
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

module.exports = { GoogleClient, validateCredentials, loadCredentialsFile, SCOPES, JSON_ARCHIVE_TAB };
