'use strict';

const MS_WIDTH = 9;
const COUNTER_WIDTH = 4;

function pad(value, width) {
  return value.toString(36).padStart(width, '0');
}

function encode(ms, counter, deviceId) {
  return pad(ms, MS_WIDTH) + ':' + pad(counter, COUNTER_WIDTH) + ':' + deviceId;
}

function parse(value) {
  const parts = String(value || '').split(':');
  if (parts.length !== 3) return null;
  const ms = parseInt(parts[0], 36);
  const counter = parseInt(parts[1], 36);
  if (!Number.isFinite(ms) || !Number.isFinite(counter) || !/^[a-z0-9]{4,32}$/.test(parts[2])) return null;
  return { ms, counter, deviceId: parts[2] };
}

class HLC {
  constructor(deviceId, options) {
    this.deviceId = String(deviceId || '').toLowerCase();
    if (!/^[a-z0-9]{4,32}$/.test(this.deviceId)) throw new Error('invalid HLC device id');
    this.lastMs = 0;
    this.counter = 0;
    this.maxDriftMs = (options && options.maxDriftMs) || 24 * 60 * 60 * 1000;
  }

  observe(value) {
    const remote = parse(value);
    if (!remote) return false;
    if (remote.ms - this.lastMs > this.maxDriftMs) return false;
    if (remote.ms > this.lastMs) {
      this.lastMs = remote.ms;
      this.counter = remote.counter + 1;
    } else if (remote.ms === this.lastMs && remote.counter >= this.counter) {
      this.counter = remote.counter + 1;
    }
    return true;
  }

  now() {
    const wall = Date.now();
    if (wall > this.lastMs) {
      this.lastMs = wall;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return encode(this.lastMs, this.counter, this.deviceId);
  }

  static compare(left, right) {
    if (left === right) return 0;
    return String(left) > String(right) ? 1 : -1;
  }
}

module.exports = { HLC, encode, parse };
