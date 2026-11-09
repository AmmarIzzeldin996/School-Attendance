'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir } = require('./atomic');

const SECRET_KEYS = /(password|secret|token|private|credential|authorization)/i;

function cleanFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach((key) => {
    if (SECRET_KEYS.test(key)) { out[key] = '[redacted]'; return; }
    const value = fields[key];
    if (value === undefined || value === null) return;
    out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  });
  return out;
}

class Logger {
  constructor(dataDir, options) {
    this.dir = path.join(dataDir, 'logs');
    this.verbose = !!(options && options.verbose);
    ensureDir(this.dir);
  }

  file() {
    const stamp = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, 'app-' + stamp + '.log');
  }

  write(level, event, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event: String(event || '').slice(0, 120)
    };
    const clean = cleanFields(fields);
    Object.keys(clean).forEach((key) => { entry[key] = clean[key]; });
    const line = JSON.stringify(entry);
    if (level !== 'DEBUG' || this.verbose) {
      try { process.stdout.write(line + '\n'); } catch (ignored) { /* لا يوجد طرفية */ }
    }
    try {
      fs.appendFileSync(this.file(), line + '\n', 'utf8');
    } catch (ignored) { /* التسجيل لا يُفشل التطبيق */ }
  }

  debug(event, fields) { this.write('DEBUG', event, fields); }
  info(event, fields) { this.write('INFO', event, fields); }
  warn(event, fields) { this.write('WARN', event, fields); }
  error(event, fields) { this.write('ERROR', event, fields); }
}

module.exports = { Logger };
