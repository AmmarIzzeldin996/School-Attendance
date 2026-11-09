'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const backup = file + '.bak';
      try { return JSON.parse(fs.readFileSync(backup, 'utf8')); } catch (ignored) { /* fall through */ }
      return typeof fallback === 'function' ? fallback() : fallback;
    }
    if (error instanceof SyntaxError) {
      const backup = file + '.bak';
      try { return JSON.parse(fs.readFileSync(backup, 'utf8')); } catch (ignored) { /* fall through */ }
    }
    throw error;
  }
}

function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const suffix = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const temp = file + '.tmp-' + suffix;
  fs.writeFileSync(temp, data);
  try {
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak'); } catch (ignored) { /* نسخة الأمان تحسين */ }
    }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (ignored) { /* تجاهل */ }
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      try { fs.unlinkSync(file); } catch (ignored) { /* تجاهل */ }
      fs.renameSync(temp, file);
      return;
    }
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

function readText(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeTextAtomic(file, value) {
  writeFileAtomic(file, value);
}

function appendLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function readLines(file) {
  const text = readText(file, '');
  if (!text) return [];
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch (error) { return null; }
  }).filter(Boolean);
}

module.exports = {
  ensureDir,
  readJson,
  writeJsonAtomic,
  readText,
  writeTextAtomic,
  appendLine,
  readLines
};
