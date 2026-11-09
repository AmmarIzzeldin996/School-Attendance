'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir, readJson, writeJsonAtomic } = require('../lib/atomic');
const { HLC } = require('../lib/hlc');
const { Mutex } = require('../lib/mutex');
const { Journal } = require('./journal');
const { applyOps } = require('./apply');
const {
  TABLES, rowKey, rowIsEmpty, syncableProperty, canonicalize
} = require('./model');

const SYNC_INTERVAL_MS = 45000;
const MAX_BATCH = 400;

function defaultPeerState(deviceId) {
  return {
    deviceId,
    key: crypto.randomBytes(24).toString('base64url'),
    peers: {},
    auto: true,
    lastSyncAt: '',
    lastError: ''
  };
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

class SyncEngine {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.store = options.store;
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.deviceName = options.deviceName || 'جهاز الحضور';
    this.onApplied = options.onApplied || function () {};
    this.dir = path.join(this.dataDir, 'sync');
    this.stateFile = path.join(this.dir, 'peers.json');
    this.versionsFile = path.join(this.dir, 'versions.json');
    this.hlcFile = path.join(this.dir, 'hlc.json');
    this.mutex = new Mutex();
    this.syncMutex = new Mutex();
    this.applying = false;
    this.timer = null;
    this.syncing = null;
    this.localSeq = 0;
    this.lastResult = null;
    ensureDir(this.dir);
    this.journal = new Journal(this.dataDir);
    this.state = Object.assign(defaultPeerState(this.store.meta.deviceId), readJson(this.stateFile, {}));
    if (!Array.isArray(this.state.pending)) this.state.pending = [];
    this.versions = readJson(this.versionsFile, { rows: {}, props: {}, items: {} });
    if (!this.versions.rows) this.versions.rows = {};
    if (!this.versions.props) this.versions.props = {};
    if (!this.versions.items) this.versions.items = {};
    const clock = readJson(this.hlcFile, null);
    this.hlc = new HLC(this.store.meta.deviceId);
    if (clock && Number.isFinite(clock.lastMs)) {
      this.hlc.lastMs = clock.lastMs;
      this.hlc.counter = clock.counter || 0;
    }
    this.localSeq = this.journal.originSeq;
  }

  get key() { return this.state.key; }

  get deviceId() { return this.state.deviceId; }

  listPeers() {
    return Object.keys(this.state.peers).map((id) => {
      const peer = this.state.peers[id];
      return {
        id,
        name: peer.name || peer.url,
        url: peer.url,
        manual: !!peer.manual,
        cursor: Number(peer.cursor) || 0,
        lastAt: peer.lastAt || '',
        lastError: peer.lastError || '',
        durationMs: Number(peer.durationMs) || 0
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
  }

  status() {
    const peers = this.listPeers();
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      key: this.key,
      cursor: this.journal.cursor,
      ops: this.journal.size,
      peers,
      peerCount: peers.length,
      lastSyncAt: this.state.lastSyncAt || '',
      lastError: this.state.lastError || '',
      syncing: !!this.syncing,
      auto: this.state.auto !== false,
      lastResult: this.lastResult
    };
  }

  saveState() {
    writeJsonAtomic(this.stateFile, this.state);
  }

  saveVersions() {
    writeJsonAtomic(this.versionsFile, this.versions);
  }

  saveClock() {
    writeJsonAtomic(this.hlcFile, { lastMs: this.hlc.lastMs, counter: this.hlc.counter });
  }

  addPeer(url, key, name, manual) {
    const clean = cleanUrl(url);
    if (!/^https?:\/\/[^\s]+$/i.test(clean)) throw new Error('عنوان الجهاز غير صحيح. استخدم http://IP:PORT');
    const existing = Object.keys(this.state.peers)
      .map((id) => this.state.peers[id])
      .find((peer) => cleanUrl(peer.url) === clean);
    if (existing) {
      if (key) existing.key = String(key);
      if (name) existing.name = String(name);
      if (manual) existing.manual = true;
      this.saveState();
      return existing;
    }
    const id = 'manual-' + crypto.createHash('sha256').update(clean).digest('hex').slice(0, 12);
    this.state.peers[id] = {
      id, url: clean, key: String(key || ''), name: name || clean,
      manual: !!manual, cursor: 0, lastAt: '', lastError: ''
    };
    this.saveState();
    return this.state.peers[id];
  }

  removePeer(id) {
    const peer = this.state.peers[id];
    if (!peer) return false;
    if (peer.manual) { delete this.state.peers[id]; this.saveState(); return true; }
    peer.disabled = true;
    this.saveState();
    return true;
  }

  observePeer(info) {
    if (!info || !info.deviceId || info.deviceId === this.deviceId) return;
    if (this.state.auto === false) return;
    const existing = this.state.peers[info.deviceId];
    if (existing && existing.disabled) return;
    const url = cleanUrl(info.url);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return;
    const key = String(info.key || '');
    if (existing) {
      if (existing.url !== url) existing.url = url;
      if (key) existing.key = key;
      if (info.name) existing.name = info.name;
      return;
    }
    this.state.peers[info.deviceId] = {
      id: info.deviceId,
      url,
      key,
      name: info.name || info.deviceId,
      manual: false,
      cursor: 0,
      lastAt: '',
      lastError: ''
    };
    this.saveState();
    this.logger.info('sync_peer_discovered', { peer: info.deviceId, url });
  }

  opId(hlc, table, key) {
    this.localSeq += 1;
    return [this.deviceId, this.localSeq.toString(36), hlc, table || 'p', String(key || '').slice(0, 60)]
      .join(':');
  }

  // يستقبل التغييرات من المتجر ويحوّلها إلى عمليات قابلة للنقل.
  onMutation(changes) {
    if (this.applying || !changes) return;
    const ops = [];
    const hlc = this.hlc.now();
    const tableNames = new Set(Object.keys(TABLES));
    (changes.rows || []).forEach((change) => {
      if (!tableNames.has(change.sheet)) return;
      const before = change.before || [];
      const after = change.after || [];
      const afterEmpty = rowIsEmpty(after);
      const beforeEmpty = rowIsEmpty(before);
      if (afterEmpty && beforeEmpty) return;
      const key = afterEmpty ? rowKey(change.sheet, before) : rowKey(change.sheet, after);
      if (!key) return;
      if (afterEmpty) {
        ops.push({
          id: this.opId(hlc, change.sheet, key),
          d: this.deviceId,
          h: hlc,
          k: 'tombstone',
          t: change.sheet,
          key
        });
        return;
      }
      ops.push({
        id: this.opId(hlc, change.sheet, key),
        d: this.deviceId,
        h: hlc,
        k: 'row',
        t: change.sheet,
        key,
        row: after
      });
    });
    (changes.props || []).forEach((change) => {
      if (!syncableProperty(change.key)) return;
      ops.push({
        id: this.opId(hlc, '', 'prop:' + change.key),
        d: this.deviceId,
        h: hlc,
        k: 'prop',
        p: change.key,
        v: change.after
      });
    });
    if (!ops.length) return;
    this.journal.append(ops);
    this.saveClock();
  }

  request(url, key, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (options && options.timeoutMs) || 15000);
    const headers = { accept: 'application/json' };
    if (key) headers['x-sync-key'] = key;
    headers['x-sync-device'] = this.deviceId;
    return fetch(url, { headers, signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        return { ok: response.ok, status: response.status, data, text };
      })
      .finally(() => clearTimeout(timer));
  }

  async syncPeer(peer) {
    const started = Date.now();
    let cursor = Number(peer.cursor) || 0;
    let applied = 0;
    let batches = 0;
    let reset = false;
    try {
      for (let round = 0; round < 60; round += 1) {
        const url = cleanUrl(peer.url) + '/sync/changes?since=' + cursor + '&limit=' + MAX_BATCH;
        const response = await this.request(url, peer.key);
        if (!response.ok || !response.data) {
          if (response.status === 403) {
            peer.lastError = 'مفتاح المزامنة غير مطابق';
            peer.lastAt = new Date().toISOString();
            this.saveState();
            return { ok: false, error: peer.lastError };
          }
          throw new Error('استجابة غير صحيحة من الجهاز (' + response.status + ')');
        }
        if (response.data.reset) {
          cursor = 0;
          reset = true;
          if (!response.data.ops || !response.data.ops.length) {
            const next = await this.request(cleanUrl(peer.url) + '/sync/changes?since=0&limit=' + MAX_BATCH, peer.key);
            if (next.ok && next.data) {
              response.data = next.data;
            } else {
              break;
            }
          }
        }
        const ops = response.data.ops || [];
        if (!ops.length && !response.data.hasMore) break;
        const result = await this.mutex.run(() => {
          this.applying = true;
          try {
            const outcome = applyOps(this.store, ops, this.versions, { logger: this.logger });
            if (outcome.changed) {
              this.store.save();
              this.saveVersions();
              if (this.runtime && typeof this.runtime.clearCache === 'function') this.runtime.clearCache();
            }
            return outcome;
          } finally {
            this.applying = false;
          }
        });
        applied += result.stats.applied;
        batches += 1;
        const previousCursor = cursor;
        cursor = Number(response.data.cursor) || cursor;
        peer.cursor = cursor;
        if (result.changed) {
          try { this.onApplied(result); } catch (error) { this.logger.warn('sync_applied_hook_failed', { message: error.message }); }
        }
        if (!response.data.hasMore || cursor <= previousCursor) break;
      }
      peer.lastAt = new Date().toISOString();
      peer.lastError = '';
      peer.durationMs = Date.now() - started;
      this.state.lastSyncAt = peer.lastAt;
      this.state.lastError = '';
      this.saveState();
      return { ok: true, applied, batches, reset };
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? 'انتهت مهلة الاتصال بالجهاز'
        : (error && error.message) || 'تعذر الاتصال بالجهاز';
      peer.lastError = message;
      peer.lastAt = new Date().toISOString();
      peer.durationMs = Date.now() - started;
      this.state.lastError = message;
      this.saveState();
      this.logger.warn('sync_peer_failed', { peer: peer.id, message });
      return { ok: false, error: message, applied, batches };
    }
  }

  async syncNow(reason) {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncMutex.run(async () => {
      const peers = Object.keys(this.state.peers)
        .map((id) => this.state.peers[id])
        .filter((peer) => peer && peer.url && !peer.disabled);
      if (!peers.length) {
        this.lastResult = { at: new Date().toISOString(), reason, peers: 0, applied: 0, errors: [] };
        return this.lastResult;
      }
      const results = [];
      for (const peer of peers) results.push(await this.syncPeer(peer));
      const applied = results.reduce((sum, item) => sum + (item.applied || 0), 0);
      const errors = results.filter((item) => !item.ok).map((item) => item.error);
      this.lastResult = {
        at: new Date().toISOString(), reason, peers: peers.length, applied,
        errors: errors.slice(0, 5)
      };
      if (applied) this.logger.info('sync_applied', { applied, peers: peers.length });
      return this.lastResult;
    });
    try { return await this.syncing; } finally { this.syncing = null; }
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.syncNow('interval').catch(() => {});
    }, SYNC_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    this.syncNow('startup').catch(() => {});
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // يستخدمه الاختبار وواجهة الإعداد للتحقق من سلامة الفهارس بعد استيراد خارجي.
  canonicalize() {
    return this.mutex.run(() => {
      const result = canonicalize(this.store);
      this.store.save();
      return result;
    });
  }
}

module.exports = { SyncEngine, defaultPeerState, SYNC_INTERVAL_MS };
