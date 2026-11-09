'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir } = require('../lib/atomic');

// سجل عمليات موحّد: كل جهاز يحتفظ بكل ما رآه، ويخدمه لأقرانه.
// لكل عملية رقم استلام محلي متزايد (r) يُستخدم كمؤشر مزامنة لكل قرين.
class Journal {
  constructor(dataDir, options) {
    this.dir = path.join(dataDir, 'sync');
    this.file = path.join(this.dir, 'ops.jsonl');
    ensureDir(this.dir);
    this.maxLines = (options && options.maxLines) || 400000;
    this.reset();
  }

  reset() {
    this.lines = [];
    this.ids = new Set();
    this.originSeq = 0;
    this.cursor = 0;
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (error) { continue; }
      if (!entry || !entry.id) continue;
      this.lines.push({ r: Number(entry.r) || this.lines.length + 1, line });
      this.ids.add(String(entry.id));
      this.cursor = Math.max(this.cursor, Number(entry.r) || 0);
      this.originSeq = Math.max(this.originSeq, Number(entry.s) || 0);
    }
  }

  get size() { return this.lines.length; }

  has(id) { return this.ids.has(String(id)); }

  append(ops) {
    if (!Array.isArray(ops) || !ops.length) return 0;
    const parts = [];
    let added = 0;
    for (const op of ops) {
      if (!op || !op.id || this.ids.has(String(op.id))) continue;
      this.cursor += 1;
      this.originSeq += 1;
      const entry = Object.assign({}, op, {
        r: this.cursor,
        s: op.s == null ? this.originSeq : op.s
      });
      const line = JSON.stringify(entry);
      this.lines.push({ r: this.cursor, line });
      this.ids.add(String(op.id));
      parts.push(line);
      added += 1;
    }
    if (parts.length) fs.appendFileSync(this.file, parts.join('\n') + '\n', 'utf8');
    if (this.lines.length > this.maxLines) this.compact();
    return added;
  }

  // يُبقي آخر maxLines سطرًا فقط مع الحفاظ على الترقيم.
  compact() {
    const keep = this.lines.slice(-this.maxLines);
    const text = keep.map((entry) => entry.line).join('\n') + '\n';
    const temp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, this.file);
    this.lines = keep;
  }

  changesSince(since, limit) {
    const from = Math.max(0, Number(since) || 0);
    const size = Math.max(1, Math.min(Number(limit) || 300, 2000));
    if (from > this.cursor) {
      return { ops: [], cursor: this.cursor, hasMore: false, reset: true };
    }
    let start = 0;
    let low = 0;
    let high = this.lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.lines[mid].r <= from) { start = mid + 1; low = mid + 1; }
      else high = mid - 1;
    }
    const slice = this.lines.slice(start, start + size);
    const ops = [];
    for (const entry of slice) {
      try { ops.push(JSON.parse(entry.line)); } catch (error) { /* سطر تالف يُتجاهل */ }
    }
    return {
      ops,
      cursor: ops.length ? ops[ops.length - 1].r : from,
      hasMore: start + size < this.lines.length,
      reset: false
    };
  }

  nextCursor(since) {
    const from = Math.max(0, Number(since) || 0);
    const entry = this.lines.find((item) => item.r > from);
    return entry ? entry.r - 1 : this.cursor;
  }
}

module.exports = { Journal };
