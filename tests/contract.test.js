// Contract tests: the public surface of src/12_Entry.gs must stay exactly as declared
// in ACTION_POLICY_, every response must use one envelope, and internal helpers must
// never become remotely callable. Feature behaviour lives in the other suites.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, ok, fail, createUser, loginAs, cloneData, today } from './harness.mjs';

const PRIVATE_WITHOUT_PERMISSION = ['bootstrap', 'logout', 'changePassword'];
const READ_ONLY_ACTIONS = [
  'ping', 'publicConfig', 'getStudents', 'getDriverAdminData', 'getCards',
  'getTrips', 'getTrip', 'getReport', 'getSettings', 'getDatabaseStatus',
  'getUsers', 'getAudit', 'getBackupStatus', 'previewRestore'
];
const EDITOR_ONLY_ENTRY_POINTS = [
  'installSchool', 'migrateV36', 'recoverSupervisor', 'runMaintenanceNow', 'doGet', 'include'
];
const LEGACY_COLUMNS = {
  Students: ['id', 'name', 'classroom', 'phone', 'active', 'token'],
  Attendance: ['date', 'id', 'name', 'classroom', 'status', 'inAt', 'outAt', 'operator', 'inMethod', 'inJourney', 'outMethod', 'outJourney'],
  Days: ['date', 'closed', 'closedAt', 'operator', 'startRow', 'rowCount'],
  Audit: ['at', 'operator', 'action', 'details'],
  Drivers: ['code', 'name', 'area', 'phone', 'identity', 'studentIds', 'active', 'updatedAt', 'deleted', 'deletedReason'],
  Journeys: ['id', 'date', 'driverCode', 'driverName', 'area', 'mode', 'revision', 'at', 'operator', 'items', 'history', 'requestId', 'lastRequestId'],
  JourneyDays: ['date', 'startRow', 'rowCount']
};

function tables(app) {
  return cloneData(app.sandbox.TABLES_);
}

function policy(app) {
  return cloneData(app.sandbox.ACTION_POLICY_);
}

function roles(app) {
  return cloneData(app.sandbox.ROLE_PERMISSIONS_);
}

describe('api contract', () => {
  it('maps every declared action to exactly one handler and one policy', () => {
    const app = setup();
    const handlers = app.sandbox.ACTION_HANDLERS_;
    const policies = policy(app);
    const handlerNames = Object.keys(handlers).sort();
    const policyNames = Object.keys(policies).sort();

    expect(handlerNames).toEqual(policyNames);
    expect(handlerNames.length).toBeGreaterThan(20);

    handlerNames.forEach((name) => {
      // Camel-case identifiers only: internal `snake_case_` helpers can never reach api().
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9]{1,39}$/);
      expect(name.endsWith('_')).toBe(false);
      expect(typeof handlers[name]).toBe('function');
      const declared = policies[name];
      expect(typeof declared.public).toBe('boolean');
      expect(typeof declared.lock).toBe('boolean');
      if (declared.idempotent) expect(declared.lock).toBe(true);
      if (declared.permission) expect(typeof declared.permission).toBe('string');
    });

    // Only the three session-lifecycle actions may be private without a permission.
    const permissionless = policyNames.filter((name) => !policies[name].public && !policies[name].permission);
    expect(permissionless.sort()).toEqual([...PRIVATE_WITHOUT_PERMISSION].sort());

    // Every permission used by an action must be granted to at least one role.
    const granted = new Set(Object.keys(roles(app)).flatMap((role) => roles(app)[role]));
    policyNames.forEach((name) => {
      const permission = policies[name].permission;
      if (permission) expect(granted.has(permission)).toBe(true);
    });

    // Editor-only entry points are real globals, but they are not declared actions.
    EDITOR_ONLY_ENTRY_POINTS.forEach((name) => {
      expect(typeof app.sandbox[name]).toBe('function');
      expect(policies[name]).toBeUndefined();
      expect(handlers[name]).toBeUndefined();
    });
  });

  it('keeps the read-only actions lock-free and the mutating flows locked', () => {
    const app = setup();
    const policies = policy(app);
    READ_ONLY_ACTIONS.forEach((name) => {
      expect(policies[name]).toBeTruthy();
      expect(policies[name].lock, name).toBe(false);
      expect(policies[name].idempotent, name).toBeUndefined();
    });
    ['scanStudent', 'closeDay', 'correctAttendance', 'openTrip', 'scanTrip', 'unscanTrip',
      'confirmTrip', 'cancelTrip', 'saveStudent', 'importStudents', 'saveDriver', 'deleteDriver',
      'issueCard', 'revokeCard', 'saveSettings', 'saveUser', 'createBackup', 'restoreBackup',
      'runRetention'].forEach((name) => {
      expect(policies[name].lock, name).toBe(true);
    });
  });

  it('returns one stable envelope for success and failure', () => {
    const app = setup();
    const keys = ['success', 'code', 'message', 'data', 'timestamp', 'requestId'];

    const ping = app.api('', 'ping', {}, 'req-contract-ping-1');
    expect(Object.keys(ping).sort()).toEqual(keys.slice().sort());
    expect(ping).toMatchObject({ success: true, code: 'SUCCESS', requestId: 'req-contract-ping-1' });
    expect(ping.data.status).toBe('ok');
    expect(ping.data.version).toBe(app.sandbox.APP_VERSION_);
    expect(ping.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/);

    const publicConfig = app.api('', 'publicConfig');
    expect(publicConfig.success).toBe(true);
    expect(publicConfig.data.version).toBe(app.sandbox.APP_VERSION_);
    expect(publicConfig.data.systemName).toBeTruthy();
    expect(publicConfig.data.ssoAvailable).toBe(false);
    expect(JSON.stringify(publicConfig)).not.toContain('SETTINGS');

    const unknown = app.api('', 'doesNotExist', {}, 'req-contract-bad-1');
    expect(Object.keys(unknown).sort()).toEqual(keys.slice().sort());
    expect(unknown).toMatchObject({
      success: false,
      code: 'UNKNOWN_ACTION',
      data: null,
      requestId: 'req-contract-bad-1'
    });
    expect(unknown.message).toBe(app.sandbox.ERROR_MESSAGES_.UNKNOWN_ACTION);
  });

  it('rejects malformed requests before dispatch', () => {
    const app = setup();
    const checks = [
      [null, 'BAD_REQUEST'],
      ['ping', 'BAD_REQUEST'],
      [{ action: 'readTable_' }, 'BAD_REQUEST'],
      [{ action: '_hidden' }, 'BAD_REQUEST'],
      [{ action: 'installSchool' }, 'UNKNOWN_ACTION'],
      [{ action: 'migrateV36' }, 'UNKNOWN_ACTION'],
      [{ action: 'ping', payload: [] }, 'BAD_REQUEST'],
      [{ action: 'ping', payload: 'text' }, 'BAD_REQUEST'],
      [{ action: 'ping', payload: { blob: 'x'.repeat(200001) } }, 'PAYLOAD_TOO_LARGE']
    ];
    checks.forEach(([request, code]) => {
      const response = app.call('api', request);
      expect(response.success, JSON.stringify(request).slice(0, 40)).toBe(false);
      expect(response.code).toBe(code);
      expect(response.data).toBeNull();
    });

    // The request id is echoed, bounded to 64 characters, and never invented.
    const longId = 'r'.repeat(100);
    expect(app.api('', 'ping', {}, longId).requestId).toHaveLength(64);
    expect(app.api('', 'ping', {}, 'req-contract-echo-1').requestId).toBe('req-contract-echo-1');
    expect(app.api('', 'ping').requestId).toHaveLength(32);
    expect(app.call('api', { action: 'ping' }).requestId).toBe('');
    expect(app.call('api', { action: 'ping', requestId: 42 }).requestId).toBe('');
  });

  it('requires a session for every non-public action and leaks nothing without one', () => {
    const app = setup();
    const policies = policy(app);
    Object.keys(policies).filter((name) => !policies[name].public).forEach((name) => {
      const response = app.api('', name, {}, 'req-contract-session-' + name);
      expect(response.success, name).toBe(false);
      expect(response.code, name).toBe('SESSION_EXPIRED');
      expect(response.data, name).toBeNull();
    });

    // Public actions must never fail with SESSION_EXPIRED, even with an empty token.
    Object.keys(policies).filter((name) => policies[name].public).forEach((name) => {
      const response = app.api('', name, {}, 'req-contract-public-' + name);
      expect(response.code, name).not.toBe('SESSION_EXPIRED');
      expect(response.code, name).not.toBe('UNKNOWN_ACTION');
    });

    // A forged or expired token is rejected identically.
    expect(app.api('not-a-real-token', 'getDay', {}).code).toBe('SESSION_EXPIRED');
    expect(app.api('x'.repeat(40), 'getDay', {}).code).toBe('SESSION_EXPIRED');
  });

  it('reaches every handler with a valid session and enforces the request-id rule', () => {
    const app = setup();
    const policies = policy(app);

    // Representative unlocked handlers return data, not UNKNOWN_ACTION/SESSION_EXPIRED.
    ['getDay', 'getStudents', 'getSettings', 'getAudit', 'getDatabaseStatus',
      'getCards', 'getTrips', 'getBackupStatus'].forEach((name) => {
      const response = app.api(app.token, name, {}, 'req-contract-reach-' + name);
      expect(response.success, name + ': ' + response.code).toBe(true);
      expect(response.data, name).not.toBeNull();
    });

    // Every idempotent action refuses a malformed request id before touching data.
    Object.keys(policies).filter((name) => policies[name].idempotent).forEach((name) => {
      const response = app.api(app.token, name, {}, 'short');
      expect(response.success, name).toBe(false);
      expect(response.code, name).toBe('BAD_REQUEST');
    });
  });

  it('enforces the documented permission split between roles', () => {
    const app = setup();
    const policies = policy(app);
    const gate = createUser(app, { username: 'gate_contract', role: 'gate' });
    const registrar = createUser(app, { username: 'reg_contract', role: 'registrar' });
    const viewer = createUser(app, { username: 'view_contract', role: 'viewer' });
    const tokens = {
      gate: loginAs(app, gate.username, gate.password),
      registrar: loginAs(app, registrar.username, registrar.password),
      viewer: loginAs(app, viewer.username, viewer.password)
    };

    const gateAllowed = ['getDay', 'scanStudent', 'openTrip', 'scanTrip', 'unscanTrip', 'confirmTrip', 'cancelTrip', 'getTrips', 'getTrip'];
    const gateDenied = ['closeDay', 'correctAttendance', 'getStudents', 'saveStudent', 'getSettings', 'getUsers',
      'createBackup', 'getReport', 'getCards', 'issueCard'];

    gateAllowed.forEach((name) => {
      expect(policies[name].permission, name).toBeTruthy();
      expect(roles(app).gate, name).toContain(policies[name].permission);
    });
    gateDenied.forEach((name) => {
      const response = app.api(tokens.gate, name, {}, 'req-contract-gate-' + name);
      expect(response.success, name).toBe(false);
      expect(response.code, name).toBe('PERMISSION_DENIED');
    });

    expect(app.api(tokens.registrar, 'getStudents', {}).success).toBe(true);
    expect(app.api(tokens.registrar, 'getReport', { from: today(app), to: today(app), type: 'daily' }).code).toBe('PERMISSION_DENIED');
    expect(app.api(tokens.registrar, 'getDay', {}).code).toBe('PERMISSION_DENIED');
    expect(app.api(tokens.viewer, 'getReport', { from: today(app), to: today(app), type: 'daily' }).success).toBe(true);
    expect(app.api(tokens.viewer, 'scanStudent', { mode: 'in', input: '1', reason: 'contract' }, 'req-contract-view-1').code).toBe('PERMISSION_DENIED');

    // `users` exists only for the primary administrator, even for another admin.
    const secondary = createUser(app, { username: 'admin_contract', role: 'admin' });
    const secondaryToken = loginAs(app, secondary.username, secondary.password);
    expect(app.call('permissionsFor_', app.user)).toContain('users');
    expect(ok(app, 'getUsers', {}).length).toBeGreaterThanOrEqual(4);
    expect(fail(app, 'saveUser', { username: 'x' }).code).toBe('VALIDATION');
    expect(app.api(secondaryToken, 'getUsers', {}).code).toBe('PERMISSION_DENIED');
    expect(app.sandbox.permissionsFor_({ id: secondary.id, role: 'admin' })).not.toContain('users');
  });

  it('keeps the legacy table prefixes intact and appends only new columns', () => {
    const app = setup();
    const current = tables(app);
    Object.keys(LEGACY_COLUMNS).forEach((name) => {
      expect(current[name].slice(0, LEGACY_COLUMNS[name].length), name).toEqual(LEGACY_COLUMNS[name]);
    });
    expect(current.Audit.slice(4)).toEqual([
      'event_id', 'request_id', 'target_type', 'target_id', 'result', 'reason', 'before_json', 'after_json'
    ]);
    expect(current.Journeys.slice(13)).toEqual(['status', 'confirmedAt', 'confirmedBy', 'appliedAt']);
    expect(current.Cards).toEqual([
      'card_id', 'type', 'owner_id', 'token_hash', 'status', 'issued_at', 'issued_by',
      'revoked_at', 'revoked_by', 'last_used_at', 'note'
    ]);
    expect(current.TripDetails).toEqual(['trip_id', 'student_id', 'method', 'applied_at', 'request_id']);

    // Real sheet headers must match TABLES_ exactly.
    Object.keys(current).forEach((name) => {
      const sheet = app.activeBook.getSheetByName(name);
      expect(sheet, name).toBeTruthy();
      expect(sheet.getRange(1, 1, 1, current[name].length).getValues()[0], name).toEqual(current[name]);
    });
  });

  it('keeps settings and account secrets out of every public response', () => {
    const app = setup();
    const before = ok(app, 'bootstrap', {});
    const serialized = JSON.stringify(before);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('AUTH_SECRET');
    expect(serialized).not.toContain('token_hash');
    expect(before.settings).toBeTruthy();

    const users = ok(app, 'getUsers', {});
    expect(JSON.stringify(users)).not.toContain('passwordHash');
    users.forEach((user) => {
      expect(Object.keys(user).sort()).toEqual([
        'active', 'email', 'id', 'isOwner', 'mustChange', 'name', 'permissions', 'role', 'roleLabel', 'username'
      ]);
    });

    const cards = ok(app, 'getCards', {});
    expect(JSON.stringify(cards)).not.toContain('token_hash');
  });

  it('only calls declared actions from the client UI', () => {
    const app = setup();
    const policies = policy(app);
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const uiFiles = readdirSync(srcDir).filter((name) => /^ui_.*\.html$/.test(name) && name !== 'ui_Vendor.html');
    expect(uiFiles.length).toBeGreaterThan(4);

    const called = new Map();
    uiFiles.forEach((name) => {
      const text = readFileSync(srcDir + name, 'utf8');
      const matches = text.matchAll(/\bapi\(\s*'([^']+)'/g);
      for (const match of matches) {
        if (!called.has(match[1])) called.set(match[1], []);
        called.get(match[1]).push(name);
      }
    });

    expect(called.size).toBeGreaterThan(20);
    called.forEach((files, action) => {
      expect(policies[action], action + ' used by ' + files.join(', ')).toBeTruthy();
    });

    // Only ping is a pure health probe and does not need a UI button.
    const unused = Object.keys(policies).filter((name) => name !== 'ping' && !called.has(name));
    expect(unused).toEqual([]);
  });

  it('builds DOM without HTML injection sinks and without remote assets', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const uiFiles = readdirSync(srcDir).filter((name) => /^ui_.*\.html$/.test(name) && name !== 'ui_Vendor.html');
    const forbidden = [/\.innerHTML\b/, /\bouterHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew Function\b/, /\binsertAdjacentHTML\b/];
    uiFiles.forEach((name) => {
      const text = readFileSync(srcDir + name, 'utf8');
      forbidden.forEach((pattern) => {
        expect(pattern.test(text), name + ' contains ' + pattern).toBe(false);
      });
      expect(text, name + ' loads a remote script').not.toMatch(/<script[^>]+src=/i);
    });
    const index = readFileSync(srcDir + 'Index.html', 'utf8');
    expect(index).not.toMatch(/https?:\/\//i);
    expect(index).toContain("include('ui_Vendor')");
    expect(index).toContain('SA.boot()');
  });

  it('wires the calendar toggle and formats dates through one helper', () => {    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const app = readFileSync(srcDir + 'ui_App.html', 'utf8');
    expect(readFileSync(srcDir + 'Index.html', 'utf8')).toContain('calendarToggle');
    expect(app).toContain('islamic-umalqura');
    expect(app).toContain('ui.fmtDate = fmtDate');
    expect(app).toContain('ui.toggleCalendar = toggleCalendar');
    ['ui_Home.html', 'ui_Trips.html', 'ui_Reports.html'].forEach((name) => {
      expect(readFileSync(srcDir + name, 'utf8'), name).toContain('ui.fmtDate(');
    });
  });

  it('prints all student barcodes with digits-only labels and a STU- code', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const students = readFileSync(srcDir + 'ui_Students.html', 'utf8');
    expect(students).toContain("text: 'طباعة كل الباركودات'");
    expect(students).toContain('printing-barcodes');
    expect(students).toContain("qr.addData('STU-' + digits)");
    expect(students).toContain("text: digits");
    expect(readFileSync(srcDir + 'ui_Styles.html', 'utf8')).toContain('.barcode-label');
  });

  it('wires adding an unrelated student to an open trip', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const trips = readFileSync(srcDir + 'ui_Trips.html', 'utf8');
    expect(trips).toContain("api('addTripStudent'");
    expect(trips).toContain('إضافة طالب غير مرتبط');
    const config = readFileSync(srcDir + '01_Config.gs', 'utf8');
    expect(config).toContain("addTripStudent: { public: false, lock: true, permission: 'journeys'");
    expect(readFileSync(srcDir + '12_Entry.gs', 'utf8')).toContain('addTripStudent: addTripStudent_');
  });
});
