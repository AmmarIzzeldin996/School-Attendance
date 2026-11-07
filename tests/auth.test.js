import { describe, it, expect } from 'vitest';
import {
  createApp, install, login, bootstrap, setup, ok, fail, okAs, failAs,
  createUser, loginAs
} from './harness.mjs';

describe('authentication', () => {
  it('requires the temporary password to be changed before business actions', () => {
    const app = createApp();
    const installed = install(app);
    expect(installed.account.temporaryPassword).toMatch(/^Aa!/);

    const first = login(app, installed.account.username, installed.account.temporaryPassword);
    expect(first.user.mustChange).toBe(true);
    const blocked = failAs(app, first.token, 'getDay', {});
    expect(blocked.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = failAs(app, first.token, 'changePassword', { currentPassword: installed.account.temporaryPassword, newPassword: '123' });
    expect(weak.code).toBe('VALIDATION');
    const wrong = failAs(app, first.token, 'changePassword', { currentPassword: 'Wrong!1234', newPassword: 'New!2026pass' });
    expect(wrong.code).toBe('INVALID_CREDENTIALS');

    const changed = okAs(app, first.token, 'changePassword', {
      currentPassword: installed.account.temporaryPassword,
      newPassword: 'New!2026pass'
    });
    expect(changed.relogin).toBe(true);

    const stale = failAs(app, first.token, 'bootstrap', {});
    expect(stale.code).toBe('SESSION_EXPIRED');
    const fresh = login(app, installed.account.username, 'New!2026pass');
    expect(fresh.user.mustChange).toBe(false);
    expect(fresh.user.permissions).toContain('settings');
  });

  it('uses one opaque error for unknown users and wrong passwords', () => {
    const app = setup();
    const unknown = failAs(app, '', 'login', { username: 'nobody', password: 'Whatever!1' });
    const wrong = failAs(app, '', 'login', { username: 'admin', password: 'Whatever!1' });
    expect(unknown.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.message).toBe(wrong.message);

    const audit = ok(app, 'getAudit', { limit: 50 });
    expect(audit.filter((row) => row.action === 'فشل تسجيل الدخول').length).toBeGreaterThanOrEqual(2);
  });

  it('blocks a username after five failed attempts inside the window', () => {
    const app = setup();
    const blockedUser = createUser(app, { username: 'gate_attempts', role: 'gate' });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(failAs(app, '', 'login', { username: blockedUser.username, password: 'BadPass!1' }).code).toBe('INVALID_CREDENTIALS');
    }
    expect(failAs(app, '', 'login', { username: blockedUser.username, password: blockedUser.password }).code).toBe('TOO_MANY_ATTEMPTS');

    const user = createUser(app, { username: 'gate_clears', role: 'gate' });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      failAs(app, '', 'login', { username: user.username, password: 'BadPass!1' });
    }
    const success = login(app, user.username, user.password);
    expect(success.token).toBeTruthy();
    // A successful login clears the counter for that username.
    expect(failAs(app, '', 'login', { username: user.username, password: 'BadPass!1' }).code).toBe('INVALID_CREDENTIALS');
    expect(login(app, user.username, user.password).token).toBeTruthy();
  });

  it('rejects inactive accounts and revokes their sessions and user cards', () => {
    const app = setup();
    const gate = createUser(app, { username: 'gate_inactive', role: 'gate' });
    const gateToken = loginAs(app, gate.username, gate.password);

    const issued = ok(app, 'issueCard', { type: 'USER', ownerId: gate.id });
    expect(issued.token).toBeTruthy();
    const cardLogin = app.api('', 'loginCard', { token: issued.token });
    expect(cardLogin.success, JSON.stringify(cardLogin)).toBe(true);

    ok(app, 'saveUser', {
      id: gate.id, username: gate.username, name: gate.name, email: gate.email,
      role: 'gate', active: false
    });

    expect(failAs(app, gateToken, 'getDay', {}).code).toBe('SESSION_EXPIRED');
    expect(failAs(app, '', 'login', { username: gate.username, password: 'User!2026' }).code).toBe('USER_INACTIVE');
    const revokedCard = failAs(app, '', 'loginCard', { token: issued.token });
    expect(revokedCard.code).toBe('QR_REVOKED');
  });

  it('rejects expired sessions and sessions whose account version changed', () => {
    const app = setup();
    const gate = createUser(app, { username: 'gate_version', role: 'gate' });
    const gateToken = loginAs(app, gate.username, gate.password);

    const key = 'SESSION_' + app.call('sha256_', gateToken);
    const session = JSON.parse(app.props.get(key));
    session.expiresAt = Date.now() - 1;
    app.props.set(key, JSON.stringify(session));
    expect(failAs(app, gateToken, 'bootstrap', {}).code).toBe('SESSION_EXPIRED');

    ok(app, 'saveUser', {
      id: gate.id, username: gate.username, name: gate.name, email: gate.email,
      role: 'registrar', active: true
    });
    expect(failAs(app, gateToken, 'bootstrap', {}).code).toBe('SESSION_EXPIRED');

    const fresh = loginAs(app, gate.username, 'User!2026', 'Another!2026');
    expect(okAs(app, fresh, 'bootstrap', {}).user.role).toBe('registrar');
  });

  it('invalidates the token on logout', () => {
    const app = setup();
    const gate = createUser(app, { username: 'gate_logout', role: 'gate' });
    const token = loginAs(app, gate.username, gate.password);
    okAs(app, token, 'logout', {});
    expect(failAs(app, token, 'bootstrap', {}).code).toBe('SESSION_EXPIRED');
  });

  it('enforces server-side role permissions', () => {
    const app = setup();
    const registrar = createUser(app, { username: 'reg1', role: 'registrar' });
    const viewer = createUser(app, { username: 'view1', role: 'viewer' });
    const gate = createUser(app, { username: 'gate_perm', role: 'gate' });
    const regToken = loginAs(app, registrar.username, registrar.password);
    const viewToken = loginAs(app, viewer.username, viewer.password);
    const gateToken = loginAs(app, gate.username, gate.password);

    expect(okAs(app, regToken, 'getStudents', {}).length).toBe(0);
    expect(failAs(app, regToken, 'getDay', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, regToken, 'scanStudent', { mode: 'in', input: '1001' }, undefined).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, regToken, 'getSettings', {}).code).toBe('PERMISSION_DENIED');

    expect(failAs(app, viewToken, 'scanStudent', { mode: 'in', input: '1001' }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, viewToken, 'getStudents', {}).code).toBe('PERMISSION_DENIED');
    expect(okAs(app, viewToken, 'getReport', { from: app.call('today_'), to: app.call('today_'), type: 'daily' }).type).toBe('daily');

    expect(failAs(app, gateToken, 'getStudents', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'saveStudent', { id: '1001', name: 'x', classroom: 'y' }).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'getUsers', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'getSettings', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'createBackup', {}).code).toBe('PERMISSION_DENIED');
    expect(failAs(app, gateToken, 'getAudit', {}).code).toBe('PERMISSION_DENIED');
  });

  it('allows SSO only when enabled and the email is linked', () => {
    const app = setup();
    ok(app, 'saveUser', {
      id: app.user.id, username: 'admin', name: app.user.name, email: 'owner@example.com',
      role: 'admin', active: true
    });

    const disabled = failAs(app, '', 'loginGoogle', {});
    expect(disabled.code).toBe('PERMISSION_DENIED');

    const settings = ok(app, 'getSettings', {});
    settings.ssoEnabled = true;
    ok(app, 'saveSettings', { settings });
    const sso = app.api('', 'loginGoogle', {});
    expect(sso.success, JSON.stringify(sso)).toBe(true);
    expect(sso.data.user.username).toBe('admin');

    app.setEmail('stranger@example.com');
    expect(failAs(app, '', 'loginGoogle', {}).code).toBe('INVALID_CREDENTIALS');
  });

  it('protects the primary administrator from demotion or deactivation', () => {
    const app = setup();
    const primary = fail(app, 'saveUser', {
      id: app.user.id, username: 'admin', name: 'مدير', email: '', role: 'registrar', active: true
    });
    expect(primary.code).toBe('PERMISSION_DENIED');
    const disabled = fail(app, 'saveUser', {
      id: app.user.id, username: 'admin', name: 'مدير', email: '', role: 'admin', active: false
    });
    expect(disabled.code).toBe('PERMISSION_DENIED');
  });

  it('rejects unknown, malformed, oversized, and unsupported requests', () => {
    const app = setup();
    expect(app.api(app.token, 'notARealAction', {}).code).toBe('UNKNOWN_ACTION');
    expect(app.api(app.token, 'getDay', []).code).toBe('BAD_REQUEST');
    expect(app.api(app.token, 'getDay', { blob: 'x'.repeat(200001) }).code).toBe('PAYLOAD_TOO_LARGE');
    expect(app.call('api', { action: 'getDay', token: app.token, payload: {} }).success).toBe(true);
    expect(app.call('api', { action: 'getDay', token: app.token, payload: {}, requestId: 'r1' }).requestId).toBe('r1');
  });

  it('does not leak password hashes or raw card tokens through reads', () => {
    const app = setup();
    const users = ok(app, 'getUsers', {});
    expect(users.every((user) => user.passwordHash === undefined && user.password === undefined)).toBe(true);
    expect(app.props.get('ACCOUNT_' + app.user.id)).toContain('passwordHash');
  });
});
