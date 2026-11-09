'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ensureDir, readJson, writeJsonAtomic, readText, writeTextAtomic
} = require('../lib/atomic');

const STORE_VERSION = 1;
const SHEET_META_DEFAULT = { frozenRows: 0, rightToLeft: false };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isEmptyCell(value) {
  return value === '' || value === null || value === undefined;
}

function rowIsEmpty(row) {
  return !Array.isArray(row) || !row.some((value) => !isEmptyCell(value));
}

function defaultWorkbook(bookId) {
  return {
    version: STORE_VERSION,
    bookId,
    name: 'School Attendance (Local)',
    createdAt: new Date().toISOString(),
    timeZone: 'Asia/Riyadh',
    sheets: {},
    sheetMeta: {}
  };
}

class LocalSheet {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  getName() { return this.name; }

  setName(name) {
    const next = String(name || '').trim();
    if (!next) throw new Error('sheet name required');
    if (next === this.name) return this;
    const book = this.store.workbook;
    if (book.sheets[next]) throw new Error('sheet exists: ' + next);
    book.sheets[next] = book.sheets[this.name];
    book.sheetMeta[next] = book.sheetMeta[this.name] || Object.assign({}, SHEET_META_DEFAULT);
    delete book.sheets[this.name];
    delete book.sheetMeta[this.name];
    this.name = next;
    this.store.touch();
    return this;
  }

  rows() { return this.store.workbook.sheets[this.name] || []; }

  getLastRow() {
    const rows = this.rows();
    for (let index = rows.length; index >= 1; index -= 1) {
      if (!rowIsEmpty(rows[index - 1])) return index;
    }
    return 0;
  }

  getLastColumn() {
    const rows = this.rows();
    let last = 0;
    rows.forEach((row) => {
      for (let index = row.length; index >= 1; index -= 1) {
        if (!isEmptyCell(row[index - 1])) { last = Math.max(last, index); break; }
      }
    });
    return last;
  }

  getRange(row, col, numRows, numCols) {
    const startRow = Number(row);
    const startCol = Number(col);
    if (!Number.isInteger(startRow) || startRow < 1) throw new Error('getRange: invalid start row');
    if (!Number.isInteger(startCol) || startCol < 1) throw new Error('getRange: invalid start column');
    return new LocalRange(this, startRow, startCol, numRows == null ? 1 : Number(numRows), numCols == null ? 1 : Number(numCols));
  }

  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  setFrozenRows(count) {
    const meta = this.store.workbook.sheetMeta[this.name] || Object.assign({}, SHEET_META_DEFAULT);
    meta.frozenRows = Number(count) || 0;
    this.store.workbook.sheetMeta[this.name] = meta;
    return this;
  }

  getFrozenRows() {
    const meta = this.store.workbook.sheetMeta[this.name] || SHEET_META_DEFAULT;
    return Number(meta.frozenRows || 0);
  }

  setRightToLeft(value) {
    const meta = this.store.workbook.sheetMeta[this.name] || Object.assign({}, SHEET_META_DEFAULT);
    meta.rightToLeft = !!value;
    this.store.workbook.sheetMeta[this.name] = meta;
    return this;
  }

  clear() {
    this.store.workbook.sheets[this.name] = [];
    this.store.touch();
    return this;
  }
}

class LocalRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
    if (!Number.isInteger(numRows) || numRows < 1) throw new Error('getRange: invalid row count');
    if (!Number.isInteger(numCols) || numCols < 1) throw new Error('getRange: invalid column count');
  }

  getValues() {
    const rows = this.sheet.rows();
    const result = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const line = rows[this.row - 1 + r] || [];
      const values = [];
      for (let c = 0; c < this.numCols; c += 1) {
        const value = line[this.col - 1 + c];
        values.push(value === undefined || value === null ? '' : value);
      }
      result.push(values);
    }
    return result;
  }

  getValue() { return this.getValues()[0][0]; }

  setValue(value) { return this.setValues([[value]]); }

  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error('setValues: row count mismatch');
    }
    values.forEach((line) => {
      if (!Array.isArray(line) || line.length !== this.numCols) throw new Error('setValues: column count mismatch');
    });
    this.sheet.store.writeRange(this.sheet.name, this.row, this.col, values);
    return this;
  }

  clearContent() {
    const blank = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const line = [];
      for (let c = 0; c < this.numCols; c += 1) line.push('');
      blank.push(line);
    }
    this.sheet.store.writeRange(this.sheet.name, this.row, this.col, blank, { bulkReset: this.row <= 2 && this.numRows > 1 });
    return this;
  }

  setNumberFormat() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
}

class LocalBook {
  constructor(store) {
    this.store = store;
  }

  getId() { return this.store.workbook.bookId; }
  getName() { return this.store.workbook.name; }
  getUrl() { return '/desktop/database'; }
  setSpreadsheetTimeZone(zone) { this.store.workbook.timeZone = String(zone || 'Asia/Riyadh'); this.store.touch(); return this; }

  getSheets() {
    return Object.keys(this.store.workbook.sheets).map((name) => new LocalSheet(this.store, name));
  }

  getSheetByName(name) {
    if (!Object.prototype.hasOwnProperty.call(this.store.workbook.sheets, name)) return null;
    return new LocalSheet(this.store, name);
  }

  insertSheet(name) {
    const next = String(name || '').trim();
    if (!next) throw new Error('sheet name required');
    if (this.store.workbook.sheets[next]) throw new Error('sheet exists: ' + next);
    this.store.workbook.sheets[next] = [];
    this.store.workbook.sheetMeta[next] = Object.assign({}, SHEET_META_DEFAULT);
    this.store.touch();
    return new LocalSheet(this.store, next);
  }

  deleteSheet(name) {
    delete this.store.workbook.sheets[name];
    delete this.store.workbook.sheetMeta[name];
    this.store.touch();
  }
}

class Store {
  constructor(dataDir, options) {
    this.dataDir = dataDir;
    this.options = options || {};
    this.dir = path.join(dataDir, 'data');
    this.driveDir = path.join(this.dir, 'drive');
    this.workbookFile = path.join(this.dir, 'workbook.json');
    this.propertiesFile = path.join(this.dir, 'properties.json');
    this.metaFile = path.join(this.dir, 'meta.json');
    this.driveIndexFile = path.join(this.driveDir, 'index.json');
    this.capture = null;
    this.workbook = null;
    this.properties = {};
    this.meta = {};
    this.drive = { folders: [], files: [] };
    this.cache = new Map();
    this.dirty = false;
    this.saveTimer = null;
  }

  init() {
    ensureDir(this.dir);
    ensureDir(this.driveDir);
    ensureDir(path.join(this.driveDir, 'files'));
    this.workbook = readJson(this.workbookFile, null);
    this.properties = readJson(this.propertiesFile, {});
    this.meta = readJson(this.metaFile, {});
    this.drive = readJson(this.driveIndexFile, { folders: [], files: [] });
    if (!this.workbook) {
      this.workbook = defaultWorkbook('local-' + crypto.randomUUID());
      this.workbook.sheets.Sheet1 = [];
      this.workbook.sheetMeta.Sheet1 = Object.assign({}, SHEET_META_DEFAULT);
    }
    if (!this.workbook.sheets || typeof this.workbook.sheets !== 'object') this.workbook.sheets = {};
    if (!this.workbook.sheetMeta || typeof this.workbook.sheetMeta !== 'object') this.workbook.sheetMeta = {};
    Object.keys(this.workbook.sheets).forEach((name) => {
      if (!Array.isArray(this.workbook.sheets[name])) this.workbook.sheets[name] = [];
      if (!this.workbook.sheetMeta[name]) this.workbook.sheetMeta[name] = Object.assign({}, SHEET_META_DEFAULT);
    });
    if (!this.drive || !Array.isArray(this.drive.folders) || !Array.isArray(this.drive.files)) {
      this.drive = { folders: [], files: [] };
    }
    if (!this.meta.createdAt) this.meta.createdAt = new Date().toISOString();
    if (!this.meta.deviceId) this.meta.deviceId = crypto.randomBytes(6).toString('hex');
    if (!this.meta.deviceName) this.meta.deviceName = (this.options.deviceName || 'جهاز الحضور');
    this.saveMeta();
    return this;
  }

  touch() { this.dirty = true; }

  book() { return new LocalBook(this); }

  sheet(name) { return new LocalSheet(this, name); }

  hasSheet(name) { return Object.prototype.hasOwnProperty.call(this.workbook.sheets, name); }

  listSheets() { return Object.keys(this.workbook.sheets); }

  row(name, rowNumber) {
    const rows = this.workbook.sheets[name] || [];
    const row = rows[rowNumber - 1];
    return row ? row.slice() : [];
  }

  setRow(name, rowNumber, row) {
    if (!this.workbook.sheets[name]) throw new Error('unknown sheet: ' + name);
    if (this.capture) this.noteBefore(name, rowNumber);
    const rows = this.workbook.sheets[name];
    while (rows.length < rowNumber) rows.push([]);
    const width = Math.max(row.length, (rows[rowNumber - 1] || []).length);
    const next = [];
    for (let index = 0; index < width; index += 1) {
      const value = row[index];
      next.push(value === undefined || value === null ? '' : value);
    }
    rows[rowNumber - 1] = next;
    this.noteWrite(name, rowNumber, 1);
    this.touch();
  }

  writeRange(name, startRow, startCol, values, options) {
    if (!this.workbook.sheets[name]) throw new Error('unknown sheet: ' + name);
    if (this.capture) {
      // يجب التقاط الحالة السابقة قبل أي كتابة، وإلا فقدت المزامنة التغيير.
      for (let index = 0; index < values.length; index += 1) this.noteBefore(name, startRow + index);
    }
    const rows = this.workbook.sheets[name];
    const neededRows = startRow + values.length - 1;
    while (rows.length < neededRows) rows.push([]);
    for (let r = 0; r < values.length; r += 1) {
      const line = rows[startRow - 1 + r] || [];
      const neededCols = startCol + values[r].length - 1;
      while (line.length < neededCols) line.push('');
      for (let c = 0; c < values[r].length; c += 1) {
        const value = values[r][c];
        line[startCol - 1 + c] = value === undefined || value === null ? '' : value;
      }
      rows[startRow - 1 + r] = line;
    }
    this.noteWrite(name, startRow, values.length);
    if (options && options.bulkReset) this.noteBulkReset();
    this.touch();
  }

  appendRows(name, values) {
    if (!Array.isArray(values) || !values.length) return;
    const sheet = new LocalSheet(this, name);
    this.writeRange(name, sheet.getLastRow() + 1, 1, values);
  }

  noteWrite(name, startRow, count) {
    if (!this.capture) return;
    const key = name;
    if (!this.capture.rows.has(key)) this.capture.rows.set(key, new Set());
    for (let index = 0; index < count; index += 1) this.capture.rows.get(key).add(startRow + index);
  }

  noteBefore(name, rowNumber) {
    if (!this.capture) return;
    const key = name + '|' + rowNumber;
    if (this.capture.before.has(key)) return;
    this.capture.before.set(key, this.row(name, rowNumber));
  }

  noteBulkReset() {
    if (this.capture) this.capture.bulkReset = true;
  }

  setProperty(key, value) {
    const name = String(key);
    const next = value === undefined || value === null ? '' : String(value);
    const before = Object.prototype.hasOwnProperty.call(this.properties, name) ? this.properties[name] : null;
    if (before === next) return;
    this.properties[name] = next;
    if (this.capture) this.capture.props.set(name, { before, after: next });
    this.touch();
  }

  deleteProperty(key) {
    const name = String(key);
    if (!Object.prototype.hasOwnProperty.call(this.properties, name)) return;
    const before = this.properties[name];
    delete this.properties[name];
    if (this.capture) this.capture.props.set(name, { before, after: null });
    this.touch();
  }

  getProperty(key) {
    return Object.prototype.hasOwnProperty.call(this.properties, key) ? this.properties[key] : null;
  }

  getProperties() { return Object.assign({}, this.properties); }

  beginCapture() {
    this.capture = { rows: new Map(), before: new Map(), props: new Map(), bulkReset: false };
    return this.capture;
  }

  endCapture() {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return { rows: [], props: [], bulkReset: false };
    const rows = [];
    capture.rows.forEach((rowNumbers, name) => {
      Array.from(rowNumbers).sort((a, b) => a - b).forEach((rowNumber) => {
        const before = capture.before.get(name + '|' + rowNumber) || [];
        const after = this.row(name, rowNumber);
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        rows.push({ sheet: name, rowNumber, before, after });
      });
    });
    const props = [];
    capture.props.forEach((change, key) => {
      if (change.before === change.after) return;
      props.push({ key, before: change.before, after: change.after });
    });
    return { rows, props, bulkReset: capture.bulkReset };
  }

  save() {
    this.workbook.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.workbookFile, this.workbook);
    writeJsonAtomic(this.propertiesFile, this.properties);
    this.saveMeta();
    this.saveDrive();
    this.dirty = false;
  }

  saveWorkbook() {
    this.workbook.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.workbookFile, this.workbook);
    this.dirty = false;
  }

  saveProperties() { writeJsonAtomic(this.propertiesFile, this.properties); }

  saveMeta() { writeJsonAtomic(this.metaFile, this.meta); }

  saveDrive() { writeJsonAtomic(this.driveIndexFile, this.drive); }

  snapshotWorkbook() {
    return { workbook: clone(this.workbook), properties: clone(this.properties) };
  }

  replaceWorkbook(workbook, properties) {
    const next = clone(workbook);
    if (!next || !next.sheets || !next.bookId) throw new Error('invalid workbook snapshot');
    this.workbook = next;
    if (!this.workbook.sheetMeta) this.workbook.sheetMeta = {};
    Object.keys(this.workbook.sheets).forEach((name) => {
      if (!this.workbook.sheetMeta[name]) this.workbook.sheetMeta[name] = Object.assign({}, SHEET_META_DEFAULT);
    });
    if (properties && typeof properties === 'object') this.properties = clone(properties);
    this.save();
  }

  // ---------- ذاكرة مؤقتة (CacheService) ----------
  cacheGet(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires && Date.now() > entry.expires) { this.cache.delete(key); return null; }
    return entry.value;
  }

  cachePut(key, value, seconds) {
    this.cache.set(key, { value: String(value), expires: seconds ? Date.now() + Number(seconds) * 1000 : 0 });
  }

  cacheRemove(key) { this.cache.delete(key); }

  // ---------- Drive محلي ----------
  createFolder(name) {
    const id = 'folder-' + crypto.randomBytes(8).toString('hex');
    const folder = { id, name: String(name || 'Folder'), createdAt: new Date().toISOString() };
    this.drive.folders.push(folder);
    this.touch();
    return folder;
  }

  getFolder(id) {
    return this.drive.folders.find((folder) => folder.id === id) || null;
  }

  createFile(folderId, name, content) {
    const folder = this.getFolder(folderId);
    if (!folder) throw new Error('folder not found');
    const id = 'file-' + crypto.randomBytes(8).toString('hex');
    const body = String(content == null ? '' : content);
    const file = {
      id,
      folderId,
      name: String(name || 'file'),
      size: Buffer.byteLength(body, 'utf8'),
      createdAt: new Date().toISOString(),
      trashed: false
    };
    this.drive.files.push(file);
    writeTextAtomic(path.join(this.driveDir, 'files', id), body);
    this.touch();
    return file;
  }

  getFile(id) { return this.drive.files.find((file) => file.id === id) || null; }

  readFile(id) {
    const file = this.getFile(id);
    if (!file) return null;
    return readText(path.join(this.driveDir, 'files', file.id), '');
  }

  trashFile(id) {
    const file = this.getFile(id);
    if (!file) return false;
    file.trashed = true;
    this.touch();
    return true;
  }

  listFolderFiles(folderId) {
    return this.drive.files.filter((file) => file.folderId === folderId && !file.trashed);
  }

  localBackups() {
    return this.listFolderFiles(this.getProperty('BACKUP_FOLDER') || '')
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

module.exports = { Store, LocalBook, LocalSheet, LocalRange, defaultWorkbook, clone };
