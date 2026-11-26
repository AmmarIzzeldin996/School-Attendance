import { describe, it, expect } from 'vitest';
import { createApp, bootstrap, enableAllDays, ok } from './harness.mjs';

describe('smoke', () => {
  it('installs, completes the forced password change, and opens a day', () => {
    const app = createApp();
    const data = bootstrap(app);
    expect(data.token).toBeTruthy();
    expect(data.user.mustChange).toBe(false);
    expect(data.user.username).toBe('admin');

    enableAllDays(app);

    const ping = app.api('', 'ping', {});
    expect(ping.success, JSON.stringify(ping)).toBe(true);
    expect(ping.data.version).toBe('3.6.3');

    const day = ok(app, 'getDay', {});
    expect(day.records).toEqual([]);
    expect(day.day === null || day.day.closed === false).toBe(true);
  });

  it('rejects unknown actions and malformed requests', () => {
    const app = createApp();
    bootstrap(app);
    const unknown = app.api(app.token, 'dropAllTables', {});
    expect(unknown.success).toBe(false);
    expect(unknown.code).toBe('UNKNOWN_ACTION');

    const bad = app.call('api', null);
    expect(bad.success).toBe(false);
    expect(bad.code).toBe('BAD_REQUEST');
  });
});
