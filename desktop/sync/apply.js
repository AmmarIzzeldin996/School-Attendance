'use strict';

const { HLC } = require('../lib/hlc');
const {
  TABLES, rowKey, rowIsEmpty, normalizeId, canonicalize, buildIndex,
  findRowNumber, putRow, removeRow, mergeHistory, mergeJourneyItems, parseJson
} = require('./model');

function text(value) { return value == null ? '' : String(value); }

function stateRank(state) {
  if (state === 'scanned' || state === 'guardian' || state === 'absent') return 2;
  return 0;
}

function mergeAttendance(current, incoming) {
  const merged = incoming.slice();
  // الوصول والانصراف حدثان مستقلان: دمج الحقول بدل تغليب الصف كاملًا.
  const currentIn = text(current[5]);
  const incomingIn = text(incoming[5]);
  merged[5] = currentIn && incomingIn ? (currentIn <= incomingIn ? currentIn : incomingIn) : (currentIn || incomingIn);
  const currentOut = text(current[6]);
  const incomingOut = text(incoming[6]);
  merged[6] = currentOut && incomingOut ? (currentOut >= incomingOut ? currentOut : incomingOut) : (currentOut || incomingOut);
  const rankCurrent = current[4] === 'absent' ? 1 : current[4] === 'present' ? 2 : 0;
  const rankIncoming = incoming[4] === 'absent' ? 1 : incoming[4] === 'present' ? 2 : 0;
  if (rankCurrent > rankIncoming) {
    merged[4] = current[4];
    merged[7] = current[7];
    merged[8] = current[8];
    merged[9] = current[9];
    merged[10] = current[10];
    merged[11] = current[11];
  }
  if (merged[6] && !merged[5]) merged[5] = text(incoming[5]) || text(current[5]);
  if (merged[5] && incomingIn && currentIn && merged[5] === currentIn) {
    merged[7] = text(incoming[7]) || text(current[7]);
    merged[8] = text(incoming[8]) || text(current[8]);
    merged[9] = text(incoming[9]) || text(current[9]);
  }
  return merged;
}

function mergeJourney(current, incoming, incomingHlc, versionKey, itemVersions) {
  const merged = incoming.slice();
  const currentItems = parseJson(current[9], []);
  const incomingItems = parseJson(incoming[9], []);
  const items = mergeJourneyItems(currentItems, incomingItems, [], incomingHlc, itemVersions, versionKey);
  merged[9] = JSON.stringify(items);
  merged[10] = JSON.stringify(mergeHistory(current[10], incoming[10]));
  merged[6] = Math.max(Number(current[6]) || 0, Number(incoming[6]) || 0);
  // الرحلة المؤكدة لا تعود مسودة بسبب جهاز لم يستلم التأكيد بعد.
  if (current[13] === 'CONFIRMED' && incoming[13] === 'DRAFT') {
    merged[13] = current[13];
    merged[14] = current[14];
    merged[15] = current[15];
    merged[16] = current[16];
  }
  merged[14] = text(incoming[14]) || text(current[14]);
  merged[15] = text(incoming[15]) || text(current[15]);
  merged[16] = text(incoming[16]) || text(current[16]);
  // لا ينتقل طالب من حالة تأكيد إلى انتظار بسبب وصول متأخر.
  const currentById = new Map();
  currentItems.forEach((item) => currentById.set(normalizeId(item && item.id), item));
  const repaired = items.map((item) => {
    const before = currentById.get(normalizeId(item && item.id));
    if (before && stateRank(before.state) > stateRank(item.state)) return before;
    return item;
  });
  merged[9] = JSON.stringify(repaired);
  return merged;
}

function mergeStudent(current, incoming) {
  const merged = incoming.slice();
  if (!text(merged[1])) merged[1] = text(current[1]);
  if (!text(merged[2])) merged[2] = text(current[2]);
  if (!text(merged[3])) merged[3] = text(current[3]);
  // إعادة تفعيل الطالب تعديل لاحق مشروع؛ تعطيله كذلك.
  return merged;
}

function mergeCard(current, incoming) {
  const merged = incoming.slice();
  if (text(current[4]) === 'REVOKED' && text(incoming[4]) === 'ACTIVE') {
    const revokedAt = text(current[7]);
    const issuedAt = text(incoming[5]);
    if (revokedAt && issuedAt && revokedAt > issuedAt) {
      merged[4] = 'REVOKED';
      merged[7] = revokedAt;
      merged[8] = text(current[8]);
      merged[10] = text(current[10]) || text(incoming[10]);
    }
  }
  return merged;
}

function mergeRows(table, current, incoming, context) {
  if (!current || rowIsEmpty(current)) return incoming.slice();
  if (table === 'Attendance') return mergeAttendance(current, incoming);
  if (table === 'Journeys') {
    return mergeJourney(current, incoming, context.hlc, context.versionKey, context.itemVersions);
  }
  if (table === 'Students') return mergeStudent(current, incoming);
  if (table === 'Cards') return mergeCard(current, incoming);
  return incoming.slice();
}

function normalizeRow(table, row) {
  const definition = TABLES[table];
  if (!definition) return null;
  const width = Math.max(Array.isArray(row) ? row.length : 0, definition.header.length);
  const next = [];
  for (let index = 0; index < width; index += 1) {
    const value = Array.isArray(row) ? row[index] : '';
    next.push(value === undefined || value === null ? '' : value);
  }
  return next;
}

function applyOps(store, ops, versions, options) {
  const logger = (options && options.logger) || { warn() {}, info() {} };
  const stats = { applied: 0, skipped: 0, tombstones: 0, properties: 0, unknown: 0 };
  const indexes = new Map();
  const dirtyTables = new Set();
  const itemVersions = versions.items || (versions.items = {});
  let changed = false;

  for (const op of ops || []) {
    if (!op || !op.h) continue;
    if (op.k === 'prop') {
      const name = String(op.p || '');
      if (!name) { stats.unknown += 1; continue; }
      const key = 'prop|' + name;
      if (HLC.compare(op.h, versions.props[key] || '') <= 0) { stats.skipped += 1; continue; }
      versions.props[key] = op.h;
      if (op.v === null || op.v === undefined) store.deleteProperty(name);
      else store.setProperty(name, op.v);
      stats.properties += 1;
      stats.applied += 1;
      changed = true;
      continue;
    }

    const table = String(op.t || '');
    if (!TABLES[table]) { stats.unknown += 1; continue; }
    const key = String(op.key || '');
    if (!key) { stats.unknown += 1; continue; }
    const versionKey = table + '|' + key;
    if (HLC.compare(op.h, versions.rows[versionKey] || '') <= 0) { stats.skipped += 1; continue; }
    versions.rows[versionKey] = op.h;

    if (!indexes.has(table)) indexes.set(table, buildIndex(store, [table]));
    const index = indexes.get(table);
    const rowNumber = findRowNumber(store, table, key);

    if (op.k === 'tombstone') {
      if (rowNumber > 0) { removeRow(store, index, table, key); dirtyTables.add(table); }
      versions.rows[versionKey] = op.h;
      stats.tombstones += 1;
      stats.applied += 1;
      changed = true;
      continue;
    }

    if (!Array.isArray(op.row)) { stats.unknown += 1; continue; }
    const incoming = normalizeRow(table, op.row);
    if (!incoming || rowIsEmpty(incoming)) { stats.skipped += 1; continue; }
    const current = rowNumber > 0 ? store.row(table, rowNumber) : null;
    const merged = mergeRows(table, current, incoming, {
      hlc: op.h, versionKey, itemVersions
    });
    putRow(store, index, table, key, merged);
    dirtyTables.add(table);
    stats.applied += 1;
    changed = true;
  }

  if (changed) {
    canonicalize(store);
  }
  return { stats, dirtyTables: Array.from(dirtyTables), changed };
}

module.exports = { applyOps, mergeRows, mergeAttendance, mergeJourney, normalizeRow };
