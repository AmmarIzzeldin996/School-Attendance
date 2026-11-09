import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../data/store.js';
import { tempDir, cleanup } from './helpers.js';

const dirs = [];

function makeStore() {
  const dir = tempDir('sa-store-');
  dirs.push(dir);
  const store = new Store(dir, { deviceName: 'جهاز الاختبار' });
  store.init();
  return { dir, store };
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('Store', () => {
  it('creates a workbook with a default sheet and stable device identity', () => {
    const { dir, store } = makeStore();
    expect(store.workbook.bookId).toMatch(/^local-/);
    expect(store.listSheets()).toEqual(['Sheet1']);
    expect(store.meta.deviceId).toMatch(/^[a-f0-9]{12}$/);
    expect(store.meta.deviceName).toBe('جهاز الاختبار');

    store.save();
    const reloaded = new Store(dir, {});
    reloaded.init();
    expect(reloaded.workbook.bookId).toBe(store.workbook.bookId);
    expect(reloaded.meta.deviceId).toBe(store.meta.deviceId);
  });

  it('captures row and property mutations for the sync journal', () => {
    const { store } = makeStore();
    store.book().insertSheet('Students');
    store.appendRows('Students', [['id', 'name', 'classroom', 'phone', 'active', 'token']]);

    store.beginCapture();
    store.appendRows('Students', [['STU-1', 'طالب', 'صف', '', true, '']]);
    store.setProperty('SETTINGS', '{"lateAfter":"07:30"}');
    const changes = store.endCapture();

    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0].sheet).toBe('Students');
    expect(changes.rows[0].before).toEqual([]);
    expect(changes.rows[0].after[0]).toBe('STU-1');
    expect(changes.props).toEqual([
      { key: 'SETTINGS', before: null, after: '{"lateAfter":"07:30"}' }
    ]);
  });

  it('persists workbook, properties, and local drive files atomically', () => {
    const { dir, store } = makeStore();
    const folder = store.createFolder('نسخ');
    const file = store.createFile(folder.id, 'snapshot.json', '{"ok":true}');
    store.setProperty('DB_ID', store.workbook.bookId);
    store.save();

    const reloaded = new Store(dir, {});
    reloaded.init();
    expect(reloaded.getProperty('DB_ID')).toBe(store.workbook.bookId);
    expect(reloaded.getFolder(folder.id).name).toBe('نسخ');
    expect(reloaded.readFile(file.id)).toBe('{"ok":true}');
    expect(reloaded.listFolderFiles(folder.id)).toHaveLength(1);

    reloaded.trashFile(file.id);
    expect(reloaded.listFolderFiles(folder.id)).toHaveLength(0);
  });

  it('replaces a workbook snapshot and rejects invalid ones', () => {
    const { store } = makeStore();
    const snapshot = store.snapshotWorkbook();
    snapshot.workbook.sheets.Students = [['id'], ['STU-9']];
    store.replaceWorkbook(snapshot.workbook, { SETTINGS: '{}' });
    expect(store.workbook.sheets.Students).toEqual([['id'], ['STU-9']]);
    expect(store.getProperty('SETTINGS')).toBe('{}');
    expect(() => store.replaceWorkbook({}, {})).toThrow();
  });
});
