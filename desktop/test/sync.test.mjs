import { describe, it, expect, afterEach } from 'vitest';
import { Journal } from '../sync/journal.js';
import { applyOps, mergeJourney } from '../sync/apply.js';
import { SyncEngine } from '../sync/engine.js';
import { TABLES } from '../sync/model.js';
import { tempDir, cleanup, quietLogger, installRuntime } from './helpers.js';

const dirs = [];

function makeJournal() {
  const dir = tempDir('sa-journal-');
  dirs.push(dir);
  return new Journal(dir);
}

function makeEngine(runtime) {
  const engine = new SyncEngine({
    dataDir: runtime.dataDir,
    store: runtime.store,
    runtime,
    logger: quietLogger(),
    deviceName: runtime.store.meta.deviceName
  });
  runtime.onMutation = (changes) => engine.onMutation(changes);
  return engine;
}

function pull(source, target) {
  const batch = source.journal.changesSince(0, 10000);
  const result = applyOps(target.store, batch.ops, target.versions, { logger: quietLogger() });
  if (result.changed) {
    target.store.save();
    target.runtime.clearCache();
  }
  return result;
}

function row(sheet, key, values) {
  return { id: 'op:' + sheet + ':' + key, d: 'deviceaa', h: values.h, k: 'row', t: sheet, key };
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('operation journal', () => {
  it('assigns receive cursors, de-duplicates ids, and pages changes', () => {
    const journal = makeJournal();
    const appended = journal.append([
      { id: 'a:1', h: 'a00000000:0000:deviceaa', k: 'row', t: 'Students', key: 'STU-1', row: ['STU-1'] },
      { id: 'a:2', h: 'a00000000:0001:deviceaa', k: 'row', t: 'Students', key: 'STU-2', row: ['STU-2'] }
    ]);
    expect(appended).toBe(2);
    expect(journal.append([{ id: 'a:1', t: 'Students' }])).toBe(0);
    expect(journal.size).toBe(2);

    const first = journal.changesSince(0, 1);
    expect(first.ops).toHaveLength(1);
    expect(first.ops[0].r).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.reset).toBe(false);

    const second = journal.changesSince(first.cursor, 10);
    expect(second.ops).toHaveLength(1);
    expect(second.ops[0].id).toBe('a:2');
    expect(journal.changesSince(99, 10).reset).toBe(true);

    const reloaded = new Journal(journal.dir.replace(/[\\/]sync$/, ''));
    expect(reloaded.size).toBe(2);
    expect(reloaded.cursor).toBe(2);
  });
});

describe('conflict resolution', () => {
  function prepare(options) {
    return installRuntime(options).then(({ runtime, dataDir }) => {
      dirs.push(dataDir);
      return runtime;
    });
  }

  it('applies only the newest row version per key', async () => {
    const runtime = await prepare({ students: [] });
    const store = runtime.store;
    const versions = { rows: {}, props: {}, items: {} };
    const base = { id: 'x1', k: 'row', t: 'Students', key: 'STU-1' };

    let result = applyOps(store, [Object.assign({}, base, {
      h: 'a00000000:0002:deviceaa',
      row: ['STU-1', 'الاسم الأول', 'الصف', '', true, '']
    })], versions, { logger: quietLogger() });
    expect(result.stats.applied).toBe(1);

    result = applyOps(store, [Object.assign({}, base, {
      h: 'a00000000:0001:deviceaa',
      row: ['STU-1', 'اسم أقدم', 'الصف', '', true, '']
    })], versions, { logger: quietLogger() });
    expect(result.stats.skipped).toBe(1);
    expect(store.workbook.sheets.Students[1][1]).toBe('الاسم الأول');

    result = applyOps(store, [Object.assign({}, base, {
      h: 'a00000000:0003:deviceaa',
      row: ['STU-1', 'الاسم الأحدث', 'الصف', '', true, '']
    })], versions, { logger: quietLogger() });
    expect(result.stats.applied).toBe(1);
    expect(store.workbook.sheets.Students[1][1]).toBe('الاسم الأحدث');

    result = applyOps(store, [{
      id: 'x2', k: 'tombstone', t: 'Students', key: 'STU-1', h: 'a00000000:0004:deviceaa'
    }], versions, { logger: quietLogger() });
    expect(result.stats.tombstones).toBe(1);
    expect(store.workbook.sheets.Students).toHaveLength(1);
  });

  it('merges attendance arrival/departure fields instead of flattening the row', async () => {
    const runtime = await prepare();
    const store = runtime.store;
    store.workbook.sheets.Attendance = [TABLES.Attendance.header];
    store.save();
    const versions = { rows: {}, props: {}, items: {} };
    const key = '2026-01-01/STU-1';
    const base = { id: 'att', k: 'row', t: 'Attendance', key };

    applyOps(store, [Object.assign({}, base, {
      h: 'a00000000:0001:deviceaa',
      row: ['2026-01-01', 'STU-1', 'طالب', 'صف', 'present', '07:00', '', 'op1', 'qr', '', '', '']
    })], versions, { logger: quietLogger() });

    applyOps(store, [Object.assign({}, base, {
      h: 'a00000000:0002:deviceaa',
      row: ['2026-01-01', 'STU-1', 'طالب', 'صف', 'pending', '07:10', '14:00', '', '', '', '', '']
    })], versions, { logger: quietLogger() });

    const merged = store.workbook.sheets.Attendance[1];
    expect(merged[4]).toBe('present');
    expect(merged[5]).toBe('07:00');
    expect(merged[6]).toBe('14:00');
    expect(merged[7]).toBe('op1');
  });

  it('unions journey items and never downgrades a confirmed trip', () => {
    const blank = () => new Array(TABLES.Journeys.header.length).fill('');
    const current = blank();
    current[0] = 'TRIP-1';
    current[1] = '2026-01-01';
    current[9] = JSON.stringify([{ id: 'STU-1', state: 'absent' }, { id: 'STU-2', state: 'pending' }]);
    current[10] = JSON.stringify([{ at: '2026-01-01T06:00:00Z', action: 'created' }]);
    current[13] = 'CONFIRMED';
    current[14] = '2026-01-01T07:00:00Z';

    const incoming = blank();
    incoming[0] = 'TRIP-1';
    incoming[1] = '2026-01-01';
    incoming[9] = JSON.stringify([{ id: 'STU-2', state: 'scanned' }, { id: 'STU-3', state: 'absent' }]);
    incoming[10] = JSON.stringify([{ at: '2026-01-01T06:30:00Z', action: 'updated' }]);
    incoming[13] = 'DRAFT';

    const merged = mergeJourney(current, incoming, 'a00000000:0002:deviceaa', 'TRIP-1', {});
    const items = JSON.parse(merged[9]);
    expect(items.map((item) => item.id).sort()).toEqual(['STU-1', 'STU-2', 'STU-3']);
    expect(items.find((item) => item.id === 'STU-2').state).toBe('scanned');
    expect(JSON.parse(merged[10])).toHaveLength(2);
    expect(merged[13]).toBe('CONFIRMED');
    expect(merged[14]).toBe('2026-01-01T07:00:00Z');
  });
});

describe('two-device convergence', () => {
  it('converges student edits and settings through the shared journal', async () => {
    const primary = await installRuntime();
    dirs.push(primary.dataDir);
    const engineA = makeEngine(primary.runtime);

    const replicaDir = tempDir('sa-replica-');
    dirs.push(replicaDir);
    const replica = await installRuntime({ dataDir: replicaDir, students: [] });
    // استبدل قاعدة الجهاز الثاني بنسخة الجهاز الأساسي كما يفعل /setup/join.
    await replica.runtime.join({
      workbook: primary.runtime.store.workbook,
      properties: primary.runtime.store.getProperties(),
      ownerEmail: primary.runtime.store.meta.ownerEmail
    });
    const engineB = makeEngine(replica.runtime);

    await primary.runtime.callInternal('importStudents_', [
      { account: { username: 'admin', id: '' }, requestId: '' },
      { rows: [{ id: 'STU-2001', name: 'طالب جديد', classroom: 'الصف الثالث', phone: '', active: true }] }
    ]);
    expect(engineA.journal.size).toBeGreaterThan(0);

    pull(engineA, engineB);
    const added = replica.runtime.store.workbook.sheets.Students
      .find((line, index) => index > 0 && line[0] === 'STU-2001');
    expect(added).toBeTruthy();
    expect(added[1]).toBe('طالب جديد');

    await new Promise((resolve) => setTimeout(resolve, 15));
    await replica.runtime.callInternal('saveStudent_', [
      { account: { username: 'admin', id: '' }, requestId: '' },
      {
        originalId: 'STU-2001', id: 'STU-2001', name: 'طالب جديد', classroom: 'الصف الثالث',
        phone: '0555555555', active: true
      }
    ]);
    pull(engineB, engineA);

    const updated = primary.runtime.store.workbook.sheets.Students
      .find((line, index) => index > 0 && line[0] === 'STU-2001');
    expect(updated[3]).toBe('0555555555');

    const settings = await primary.runtime.callInternal('readSettings_', []);
    settings.lateAfter = '07:45';
    await new Promise((resolve) => setTimeout(resolve, 15));
    await primary.runtime.callInternal('setSettings_', [settings]);
    const propOps = engineA.journal.changesSince(0, 10000).ops.filter((op) => op.k === 'prop' && op.p === 'SETTINGS');
    expect(propOps.length).toBe(1);
    pull(engineA, engineB);
    expect((await replica.runtime.callInternal('readSettings_', [])).lateAfter).toBe('07:45');
  });
});

describe('three-device convergence', () => {
  it('propagates independent edits across a full mesh', async () => {
    const primary = await installRuntime();
    dirs.push(primary.dataDir);
    const engineA = makeEngine(primary.runtime);

    const replicaB = await installRuntime({ dataDir: tempDir('sa-replica-b-'), students: [] });
    dirs.push(replicaB.dataDir);
    await replicaB.runtime.join({
      workbook: primary.runtime.store.workbook,
      properties: primary.runtime.store.getProperties(),
      ownerEmail: primary.runtime.store.meta.ownerEmail
    });
    const engineB = makeEngine(replicaB.runtime);

    const replicaC = await installRuntime({ dataDir: tempDir('sa-replica-c-'), students: [] });
    dirs.push(replicaC.dataDir);
    await replicaC.runtime.join({
      workbook: primary.runtime.store.workbook,
      properties: primary.runtime.store.getProperties(),
      ownerEmail: primary.runtime.store.meta.ownerEmail
    });
    const engineC = makeEngine(replicaC.runtime);

    const add = (runtime, student) => runtime.callInternal('importStudents_', [
      { account: { username: 'admin', id: '' }, requestId: '' },
      { rows: [student] }
    ]);

    await add(primary.runtime, { id: 'STU-3001', name: 'طالب الجهاز أ', classroom: 'الصف الأول', phone: '', active: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await add(replicaB.runtime, { id: 'STU-3002', name: 'طالبة الجهاز ب', classroom: 'الصف الثاني', phone: '', active: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await add(replicaC.runtime, { id: 'STU-3003', name: 'طالب الجهاز ج', classroom: 'الصف الثالث', phone: '', active: true });

    // تبادل كامل في اتجاهين: كل جهاز يخدم بقية الأجهزة (full mesh).
    for (let round = 0; round < 2; round += 1) {
      pull(engineA, engineB);
      pull(engineB, engineC);
      pull(engineC, engineA);
      pull(engineB, engineA);
      pull(engineC, engineB);
      pull(engineA, engineC);
    }

    const ids = (runtime) => runtime.store.workbook.sheets.Students
      .slice(1)
      .map((line) => line[0])
      .filter(Boolean);
    for (const runtime of [primary.runtime, replicaB.runtime, replicaC.runtime]) {
      expect(ids(runtime)).toEqual(expect.arrayContaining(['STU-3001', 'STU-3002', 'STU-3003']));
    }
  });
});
