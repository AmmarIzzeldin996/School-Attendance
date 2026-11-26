// Loads the real Apps Script sources into a VM with in-memory Google services.
// The tests therefore exercise the same code that ships to Apps Script.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const SRC = resolve(here, '..', 'src');

let sourceCache = null;
export function sources() {
  if (sourceCache) return sourceCache;
  const files = readdirSync(SRC).filter((name) => name.endsWith('.gs')).sort();
  sourceCache = files.map((name) => `\n// ==== ${name} ====\n` + readFileSync(resolve(SRC, name), 'utf8')).join('\n');
  return sourceCache;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const value = this.sheet.cell(this.row + r, this.col + c);
        line.push(value === undefined ? '' : value);
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(value) { return this.setValues([[value]]); }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) throw new Error('setValues: row count mismatch');
    values.forEach((row) => {
      if (!Array.isArray(row) || row.length !== this.numCols) throw new Error('setValues: column count mismatch');
    });
    values.forEach((row, r) => row.forEach((value, c) => this.sheet.setCell(this.row + r, this.col + c, value)));
    return this;
  }
  setNumberFormat() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet.setCell(this.row + r, this.col + c, '');
    }
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.frozen = 0;
  }
  getName() { return this.name; }
  setName(name) { this.name = name; }
  cell(row, col) {
    const line = this.rows[row - 1];
    return line ? line[col - 1] : undefined;
  }
  setCell(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    const line = this.rows[row - 1];
    while (line.length < col) line.push('');
    line[col - 1] = value;
  }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if ((this.rows[r - 1] || []).some((value) => value !== '' && value !== null && value !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach((line) => {
      for (let c = line.length; c >= 1; c--) {
        if (line[c - 1] !== '' && line[c - 1] !== null && line[c - 1] !== undefined) { last = Math.max(last, c); break; }
      }
    });
    return last;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1) throw new Error('getRange: invalid start');
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  setFrozenRows(count) { this.frozen = count; return this; }
  getFrozenRows() { return this.frozen; }
  setRightToLeft() { return this; }
  clear() { this.rows = []; return this; }
}

class FakeBook {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [];
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((sheet) => sheet.name === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('sheet exists: ' + name);
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  setSpreadsheetTimeZone() { return this; }
}

function cloneData(data) { return JSON.parse(JSON.stringify(data)); }

function tzParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const map = {};
  parts.forEach((part) => { map[part.type] = part.value; });
  if (map.hour === '24') map.hour = '00';
  return map;
}

function formatDate(date, timeZone, pattern) {
  const p = tzParts(date, timeZone);
  const values = {
    yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second,
    XXX: '+03:00'
  };
  return pattern.replace(/'/g, '').replace(/yyyy|MM|dd|HH|mm|ss|XXX/g, (token) => values[token]);
}

export function createApp(options = {}) {
  const email = (options.email || 'owner@example.com').toLowerCase();
  const books = new Map();
  let activeBook = null;
  let bookSeq = 0;
  const files = new Map();
  let fileSeq = 0;
  const folders = new Map();
  const props = new Map();
  const cache = new Map();
  const logs = [];
  const state = { email, activeEmail: email, effectiveEmail: email, triggers: [] };

  function newBook(name = 'School') {
    bookSeq += 1;
    const book = new FakeBook('book-' + bookSeq, name);
    books.set(book.id, book);
    return book;
  }

  function folder(id) {
    if (!folders.has(id)) folders.set(id, { id, files: [] });
    return folders.get(id);
  }

  const SpreadsheetApp = {
    openById(id) {
      const book = books.get(id);
      if (!book) throw new Error('spreadsheet not found: ' + id);
      return book;
    },
    getActiveSpreadsheet() { return activeBook; },
    flush() {}
  };

  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) { return props.has(key) ? props.get(key) : null; },
        setProperty(key, value) { props.set(key, String(value)); },
        setProperties(object) { Object.keys(object).forEach((key) => props.set(key, String(object[key]))); },
        getProperties() { const out = {}; props.forEach((value, key) => { out[key] = value; }); return out; },
        deleteProperty(key) { props.delete(key); }
      };
    },
    getUserProperties() { return this.getScriptProperties(); },
    getDocumentProperties() { return this.getScriptProperties(); }
  };

  const CacheService = {
    getScriptCache() {
      return {
        get(key) {
          const entry = cache.get(key);
          if (!entry) return null;
          if (entry.expires && Date.now() > entry.expires) { cache.delete(key); return null; }
          return entry.value;
        },
        put(key, value, seconds = 600) { cache.set(key, { value: String(value), expires: seconds ? Date.now() + seconds * 1000 : 0 }); },
        remove(key) { cache.delete(key); }
      };
    }
  };

  const LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {}, tryLock() { return true; }, hasLock() { return true; } }; }
  };

  const Utilities = {
    getUuid() { return crypto.randomUUID(); },
    computeDigest(_algorithm, value) { return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()); },
    computeHmacSha256Signature(value, key) {
      return Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe(bytes) { return Buffer.from(bytes).toString('base64url'); },
    formatDate(date, timeZone, pattern) { return formatDate(date, timeZone, pattern); },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  };

  const Session = {
    getActiveUser() { return { getEmail() { return state.activeEmail; } }; },
    getEffectiveUser() { return { getEmail() { return state.effectiveEmail; } }; }
  };

  const ScriptApp = {
    getProjectTriggers() { return state.triggers.slice(); },
    newTrigger(handler) {
      const builder = {
        timeBased() { return builder; },
        everyMinutes(minutes) { builder.minutes = minutes; return builder; },
        create() { state.triggers.push({ handler, minutes: builder.minutes, getHandlerFunction() { return handler; } }); return builder; }
      };
      return builder;
    }
  };

  const DriveApp = {
    createFolder(name) {
      const id = 'folder-' + (folders.size + 1);
      const entry = folder(id);
      entry.name = name;
      return folderApi(id);
    },
    getFolderById(id) {
      if (!folders.has(id)) throw new Error('folder not found');
      return folderApi(id);
    }
  };

  function folderApi(id) {
    const entry = folder(id);
    return {
      getId() { return id; },
      createFile(name, content) {
        fileSeq += 1;
        const fileId = 'file-' + fileSeq;
        const file = { id: fileId, name, content: String(content), created: new Date(), trashed: false };
        files.set(fileId, file);
        entry.files.push(fileId);
        return fileApi(fileId);
      },
      getFiles() {
        let index = 0;
        const items = entry.files.map((fileId) => files.get(fileId)).filter(Boolean);
        return {
          hasNext() { return index < items.length; },
          next() { return fileApi(items[index++].id); }
        };
      }
    };
  }

  function fileApi(id) {
    const file = files.get(id);
    if (!file) throw new Error('file not found');
    return {
      getId() { return file.id; },
      getName() { return file.name; },
      getUrl() { return 'https://drive.google.com/file/d/' + file.id; },
      getSize() { return Buffer.byteLength(file.content, 'utf8'); },
      getDateCreated() { return file.created; },
      isTrashed() { return file.trashed; },
      setTrashed(value) { file.trashed = !!value; },
      getBlob() { return { getDataAsString() { return file.content; } }; }
    };
  }

  const HtmlService = {
    createTemplateFromFile() {
      return {
        configJson: '',
        evaluate() {
          return {
            setTitle() { return this; },
            addMetaTag() { return this; },
            setXFrameOptionsMode() { return this; },
            getContent() { return '<html></html>'; }
          };
        }
      };
    },
    createHtmlOutputFromFile() { return { getContent() { return ''; } }; },
    XFrameOptionsMode: { DEFAULT: 'DEFAULT' }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return { text: String(text), setMimeType(type) { this.mimeType = type; return this; } };
    }
  };

  const sandbox = {
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    SpreadsheetApp, PropertiesService, CacheService, LockService, Utilities, Session, ScriptApp,
    DriveApp, HtmlService, ContentService, MimeType: { PLAIN_TEXT: 'text/plain' },
    URL: { fetch: () => { throw new Error('no network'); } },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Error, RegExp,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sources(), sandbox, { filename: 'bundle.gs' });

  const app = {
    sandbox,
    props,
    cache,
    logs,
    books,
    files,
    folders,
    state,
    newBook,
    useBook(book) { activeBook = book; return book; },
    get activeBook() { return activeBook; },
    call(fn, ...args) { return sandbox[fn](...args); },
    api(token, action, payload = {}, requestId = crypto.randomUUID().replace(/-/g, '')) {
      return sandbox.api({ action, token, payload, requestId });
    },
    setEmail(value) { state.activeEmail = value; state.effectiveEmail = value; state.email = value; }
  };
  return app;
}

export function install(app) {
  const book = app.newBook();
  app.useBook(book);
  const result = app.call('installSchool');
  app.installResult = result;
  return result;
}

export function login(app, username, password, requestId) {
  const response = app.api('', 'login', { username, password }, requestId);
  if (!response.success) throw new Error('login failed: ' + response.code + ' ' + response.message);
  return response.data;
}

export function bootstrap(app) {
  install(app);
  const data = login(app, app.installResult.account.username, app.installResult.account.temporaryPassword);
  app.token = data.token;
  const changed = app.api(app.token, 'changePassword', {
    currentPassword: app.installResult.account.temporaryPassword,
    newPassword: 'School!2026'
  });
  if (!changed.success) throw new Error('changePassword failed: ' + changed.code);
  const relogin = login(app, app.installResult.account.username, 'School!2026');
  app.token = relogin.token;
  app.user = relogin.user;
  app.password = 'School!2026';
  return relogin;
}

export function ok(app, action, payload, requestId) {
  const response = app.api(app.token, action, payload, requestId);
  if (!response.success) {
    const error = new Error(action + ' failed: ' + response.code + ' — ' + response.message);
    error.response = response;
    throw error;
  }
  return response.data;
}

export function fail(app, action, payload, requestId) {
  const response = app.api(app.token, action, payload, requestId);
  if (response.success) throw new Error(action + ' unexpectedly succeeded');
  return response;
}

export function enableAllDays(app) {
  const settings = JSON.parse(app.props.get('SETTINGS'));
  settings.workdays = [0, 1, 2, 3, 4, 5, 6];
  app.props.set('SETTINGS', JSON.stringify(settings));
}

export function okAs(app, token, action, payload = {}, requestId) {
  const response = app.api(token, action, payload, requestId);
  if (!response.success) {
    const error = new Error(action + ' failed: ' + response.code + ' — ' + response.message);
    error.response = response;
    throw error;
  }
  return response.data;
}

export function failAs(app, token, action, payload = {}, requestId) {
  const response = app.api(token, action, payload, requestId);
  if (response.success) throw new Error(action + ' unexpectedly succeeded');
  return response;
}

export function createUser(app, options = {}) {
  const username = options.username || 'gate1';
  const password = options.password || 'Temp!2026';
  const data = ok(app, 'saveUser', {
    username,
    name: options.name || 'مستخدم اختبار',
    email: options.email || `${username}@example.com`,
    role: options.role || 'gate',
    classrooms: options.classrooms || [],
    active: options.active !== false,
    password
  });
  return { ...data.user, password };
}

// Logs in with a temporary password, completes the forced change, and returns a fresh token.
export function loginAs(app, username, password, newPassword = 'User!2026') {
  const first = login(app, username, password);
  if (!first.user.mustChange) return first.token;
  okAs(app, first.token, 'changePassword', { currentPassword: password, newPassword });
  return login(app, username, newPassword).token;
}

export function setup(options = {}) {
  const app = createApp(options);
  bootstrap(app);
  if (options.workdays) {
    const settings = JSON.parse(app.props.get('SETTINGS'));
    settings.workdays = options.workdays;
    app.props.set('SETTINGS', JSON.stringify(settings));
  } else {
    enableAllDays(app);
  }
  if (options.settings) {
    const settings = JSON.parse(app.props.get('SETTINGS'));
    Object.assign(settings, options.settings);
    app.props.set('SETTINGS', JSON.stringify(settings));
  }
  if (options.students) {
    ok(app, 'importStudents', { rows: options.students });
  }
  (options.drivers || []).forEach((driver) => {
    ok(app, 'saveDriver', {
      code: driver.code,
      name: driver.name,
      area: driver.area || 'حي الاختبار',
      phone: driver.phone || '0500000000',
      identity: driver.identity || '1000000000',
      students: driver.students || [],
      active: driver.active !== false
    });
  });
  return app;
}

export function today(app) {
  return app.call('today_');
}

export { cloneData };
