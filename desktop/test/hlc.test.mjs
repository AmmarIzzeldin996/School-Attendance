import { describe, it, expect } from 'vitest';
import { HLC } from '../lib/hlc.js';

describe('HLC', () => {
  it('keeps ordering monotonic even when the wall clock stalls', () => {
    const clock = new HLC('deviceaa');
    clock.lastMs = 1700000000000;
    const first = clock.now();
    const second = clock.now();
    expect(first < second).toBe(true);
    expect(HLC.compare(first, second)).toBe(-1);
    expect(HLC.compare(second, first)).toBe(1);
    expect(HLC.compare(first, first)).toBe(0);
  });

  it('advances past a remote timestamp and rejects excessive drift', () => {
    const clock = new HLC('deviceaa');
    expect(clock.observe('zzzzzzzzz:0001:devicebb')).toBe(false);
    clock.lastMs = 1700000000000;
    const near = (clock.lastMs + 1000).toString(36).padStart(9, '0') + ':0002:devicebb';
    expect(clock.observe(near)).toBe(true);
    expect(clock.counter).toBe(3);
    expect(clock.observe('not-a-clock')).toBe(false);
  });
});
