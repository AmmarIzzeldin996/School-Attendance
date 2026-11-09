'use strict';

const crypto = require('node:crypto');
const { clone } = require('../data/store');

function normalizeId(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().toUpperCase();
}

function isEmpty(value) {
  return value === '' || value === null || value === undefined;
}

function rowIsEmpty(row) {
  return !Array.isArray(row) || !row.some((value) => !isEmpty(value));
}

function naturalCompare(left, right) {
  const a = String(left == null ? '' : left);
  const b = String(right == null ? '' : right);
  const ax = a.match(/\d+|\D+/g) || [];
  const bx = b.match(/\d+|\D+/g) || [];
  for (let index = 0; index < Math.max(ax.length, bx.length); index += 1) {
    const av = ax[index];
    const bv = bx[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff;
    } else {
      const diff = av.localeCompare(bv, 'ar');
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(String(value || '')); } catch (error) { return fallback; }
}

const TABLES = {
  Students: {
    header: ['id', 'name', 'classroom', 'phone', 'active', 'token'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) { return naturalCompare(a[0], b[0]); }
  },
  Attendance: {
    header: ['date', 'id', 'name', 'classroom', 'status', 'inAt', 'outAt', 'operator', 'inMethod', 'inJourney', 'outMethod', 'outJourney'],
    key(row) { return normalizeId(row[0]) + '/' + normalizeId(row[1]); },
    sort() { return 0; }
  },
  Days: {
    header: ['date', 'closed', 'closedAt', 'operator', 'startRow', 'rowCount'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) { return String(a[0]).localeCompare(String(b[0])); }
  },
  Audit: {
    header: ['at', 'operator', 'action', 'details', 'event_id', 'request_id', 'target_type', 'target_id', 'result', 'reason', 'before_json', 'after_json'],
    key(row) { return normalizeId(row[4]) || crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 24); },
    sort(a, b) {
      const at = String(a[0]).localeCompare(String(b[0]));
      return at !== 0 ? at : naturalCompare(a[4], b[4]);
    }
  },
  Drivers: {
    header: ['code', 'name', 'area', 'phone', 'identity', 'studentIds', 'active', 'updatedAt', 'deleted', 'deletedReason'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) { return naturalCompare(a[0], b[0]); }
  },
  Journeys: {
    header: ['id', 'date', 'driverCode', 'driverName', 'area', 'mode', 'revision', 'at', 'operator', 'items', 'history', 'requestId', 'lastRequestId', 'status', 'confirmedAt', 'confirmedBy', 'appliedAt'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) {
      const date = String(a[1]).localeCompare(String(b[1]));
      if (date !== 0) return date;
      const at = String(a[7]).localeCompare(String(b[7]));
      return at !== 0 ? at : naturalCompare(a[0], b[0]);
    }
  },
  JourneyDays: {
    header: ['date', 'startRow', 'rowCount'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) { return String(a[0]).localeCompare(String(b[0])); }
  },
  Cards: {
    header: ['card_id', 'type', 'owner_id', 'token_hash', 'status', 'issued_at', 'issued_by', 'revoked_at', 'revoked_by', 'last_used_at', 'note'],
    key(row) { return normalizeId(row[0]); },
    sort(a, b) { return naturalCompare(a[0], b[0]); }
  },
  TripDetails: {
    header: ['trip_id', 'student_id', 'method', 'applied_at', 'request_id'],
    key(row) { return normalizeId(row[0]) + '/' + normalizeId(row[1]); },
    sort(a, b) {
      const trip = naturalCompare(a[0], b[0]);
      return trip !== 0 ? trip : naturalCompare(a[1], b[1]);
    }
  }
};

const TABLE_NAMES = Object.keys(TABLES);

function rowKey(table, row) {
  const definition = TABLES[table];
  if (!definition || !Array.isArray(row) || rowIsEmpty(row)) return '';
  return definition.key(row);
}

function syncableProperty(key) {
  if (key === 'SETTINGS' || key === 'AUTH_SECRET' || key === 'AUTH_PRIMARY_ADMIN' ||
      key === 'AUTH_SCHEMA' || key === 'AUTH_DUMMY' || key === 'DB_ID' ||
      key === 'INSTALL_VERSION' || key === 'SCHEMA_VERSION') return true;
  return key.indexOf('ACCOUNT_') === 0;
}

function filterSyncableProperties(properties) {
  const out = {};
  Object.keys(properties || {}).forEach((key) => {
    if (syncableProperty(key)) out[key] = properties[key];
  });
  return out;
}

function dataRows(store, name) {
  const sheets = store.workbook.sheets;
  const rows = sheets[name];
  if (!Array.isArray(rows) || rows.length < 2) return [];
  return rows.slice(1).filter((row) => !rowIsEmpty(row));
}

function headerFor(store, name) {
  const rows = store.workbook.sheets[name];
  if (Array.isArray(rows) && rows.length && Array.isArray(rows[0]) && rows[0].some((value) => !isEmpty(value))) {
    return rows[0].slice();
  }
  return TABLES[name].header.slice();
}

function canonicalize(store) {
  const workbook = store.workbook;
  const result = { attendance: 0, days: 0, journeys: 0 };
  if (!workbook || !workbook.sheets) return result;

  const students = dataRows(store, 'Students').slice().sort((a, b) => naturalCompare(a[0], b[0]));
  const drivers = dataRows(store, 'Drivers').slice().sort((a, b) => naturalCompare(a[0], b[0]));
  const cards = dataRows(store, 'Cards').slice().sort((a, b) => naturalCompare(a[0], b[0]));
  const audit = dataRows(store, 'Audit').slice().sort((a, b) => {
    const at = String(a[0]).localeCompare(String(b[0]));
    return at !== 0 ? at : naturalCompare(a[4], b[4]);
  });

  const dayRows = dataRows(store, 'Days').slice();
  const dayByDate = new Map();
  dayRows.forEach((row) => {
    const date = String(row[0] || '');
    if (!date) return;
    const existing = dayByDate.get(date);
    if (!existing || String(row[2] || '') > String(existing[2] || '')) dayByDate.set(date, row);
  });

  const attendanceByDay = new Map();
  const attendanceSeen = new Set();
  dataRows(store, 'Attendance').forEach((row) => {
    const date = String(row[0] || '');
    const id = normalizeId(row[1]);
    if (!date || !id) return;
    const key = date + '/' + id;
    if (attendanceSeen.has(key)) return;
    attendanceSeen.add(key);
    if (!attendanceByDay.has(date)) attendanceByDay.set(date, []);
    attendanceByDay.get(date).push(row);
  });

  const dates = new Set(Array.from(dayByDate.keys()).concat(Array.from(attendanceByDay.keys())));
  const orderedDates = Array.from(dates).sort();
  const attendance = [];
  const days = [];
  orderedDates.forEach((date) => {
    const rows = (attendanceByDay.get(date) || []).slice().sort((a, b) => naturalCompare(a[1], b[1]));
    const source = dayByDate.get(date);
    if (!rows.length) return;
    const startRow = attendance.length + 2;
    attendance.push(...rows);
    const day = source ? source.slice() : ['', '', '', '', '', ''];
    day[0] = date;
    day[1] = source ? source[1] : false;
    day[2] = source ? source[2] : '';
    day[3] = source ? source[3] : '';
    day[4] = startRow;
    day[5] = rows.length;
    days.push(day);
  });

  const journeyRows = dataRows(store, 'Journeys').slice().sort((a, b) => {
    const date = String(a[1]).localeCompare(String(b[1]));
    if (date !== 0) return date;
    const at = String(a[7]).localeCompare(String(b[7]));
    return at !== 0 ? at : naturalCompare(a[0], b[0]);
  });
  const journeysByDay = new Map();
  journeyRows.forEach((row) => {
    const date = String(row[1] || '');
    if (!date) return;
    if (!journeysByDay.has(date)) journeysByDay.set(date, []);
    journeysByDay.get(date).push(row);
  });
  const journeys = [];
  const journeyDays = [];
  Array.from(journeysByDay.keys()).sort().forEach((date) => {
    const rows = journeysByDay.get(date);
    const startRow = journeys.length + 2;
    journeys.push(...rows);
    journeyDays.push([date, startRow, rows.length]);
    result.journeys += rows.length;
  });
  const tripDetails = dataRows(store, 'TripDetails').slice().sort((a, b) => {
    const trip = naturalCompare(a[0], b[0]);
    return trip !== 0 ? trip : naturalCompare(a[1], b[1]);
  });

  const write = (name, rows) => {
    workbook.sheets[name] = [headerFor(store, name)].concat(rows.map((row) => {
      const width = Math.max(row.length, TABLES[name].header.length);
      const next = [];
      for (let index = 0; index < width; index += 1) next.push(row[index] === undefined || row[index] === null ? '' : row[index]);
      return next;
    }));
  };

  write('Students', students);
  write('Attendance', attendance);
  write('Days', days);
  write('Audit', audit);
  write('Drivers', drivers);
  write('Journeys', journeys);
  write('JourneyDays', journeyDays);
  write('Cards', cards);
  write('TripDetails', tripDetails);

  result.attendance = attendance.length;
  result.days = days.length;
  store.touch();
  return result;
}

function findRowNumber(store, table, key) {
  if (!key) return -1;
  const rows = store.workbook.sheets[table] || [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rowIsEmpty(rows[index])) continue;
    if (rowKey(table, rows[index]) === key) return index + 1;
  }
  return -1;
}

function buildIndex(store, tables) {
  const index = new Map();
  (tables || TABLE_NAMES).forEach((table) => {
    const rows = store.workbook.sheets[table] || [];
    const map = new Map();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (rowIsEmpty(row)) continue;
      const key = rowKey(table, row);
      if (key && !map.has(key)) map.set(key, rowIndex + 1);
    }
    index.set(table, map);
  });
  return index;
}

function rowAt(store, table, rowNumber) {
  const rows = store.workbook.sheets[table] || [];
  return rows[rowNumber - 1] || [];
}

function putRow(store, index, table, key, row) {
  const map = index.get(table);
  const existing = map ? map.get(key) : -1;
  let rowNumber = existing;
  if (!rowNumber) {
    const rows = store.workbook.sheets[table] || (store.workbook.sheets[table] = [headerFor(store, table).slice()]);
    rowNumber = rows.length + 1;
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = [];
    map.set(key, rowNumber);
  }
  const rows = store.workbook.sheets[table];
  const width = Math.max(row.length, TABLES[table].header.length);
  const next = [];
  for (let position = 0; position < width; position += 1) {
    next.push(row[position] === undefined || row[position] === null ? '' : row[position]);
  }
  rows[rowNumber - 1] = next;
  store.touch();
  return rowNumber;
}

function removeRow(store, index, table, key) {
  const map = index.get(table);
  const rowNumber = map ? map.get(key) : -1;
  if (!rowNumber) return false;
  const rows = store.workbook.sheets[table];
  rows[rowNumber - 1] = [];
  map.delete(key);
  store.touch();
  return true;
}

function copyRow(row) {
  return Array.isArray(row) ? row.slice() : [];
}

function mergeHistory(existing, incoming) {
  const merged = [];
  const seen = new Set();
  const add = (event) => {
    if (!event || typeof event !== 'object') return;
    const key = [event.at || '', event.operator || '', event.action || '', event.details || ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(event);
  };
  (parseJson(existing, []) || []).forEach(add);
  (parseJson(incoming, []) || []).forEach(add);
  merged.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return merged.slice(-40);
}

function mergeJourneyItems(existingItems, incomingItems, itemOps, incomingHlc, itemVersions, tripId) {
  const map = new Map();
  const order = [];
  (Array.isArray(existingItems) ? existingItems : []).forEach((item) => {
    const id = normalizeId(item && item.id);
    if (!id) return;
    map.set(id, item);
    order.push(id);
  });
  (Array.isArray(incomingItems) ? incomingItems : []).forEach((item) => {
    const id = normalizeId(item && item.id);
    if (!id) return;
    if (!map.has(id)) order.push(id);
    const version = itemVersions[tripId + '|' + id] || '';
    if (!map.has(id) || incomingHlc > version) map.set(id, item);
  });
  (Array.isArray(itemOps) ? itemOps : []).forEach((op) => {
    const id = normalizeId(op && op.id);
    if (!id) return;
    const versionKey = tripId + '|' + id;
    if ((op.hlc || incomingHlc) <= (itemVersions[versionKey] || '')) return;
    if (op.item) {
      if (!map.has(id)) order.push(id);
      map.set(id, op.item);
      itemVersions[versionKey] = op.hlc || incomingHlc;
    } else {
      map.delete(id);
      itemVersions[versionKey] = op.hlc || incomingHlc;
    }
  });
  return order.filter((id) => map.has(id)).map((id) => map.get(id));
}

module.exports = {
  TABLES,
  TABLE_NAMES,
  rowKey,
  rowIsEmpty,
  normalizeId,
  naturalCompare,
  syncableProperty,
  filterSyncableProperties,
  canonicalize,
  findRowNumber,
  buildIndex,
  rowAt,
  putRow,
  removeRow,
  copyRow,
  mergeHistory,
  mergeJourneyItems,
  parseJson,
  clone
};
