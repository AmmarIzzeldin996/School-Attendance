'use strict';

const dgram = require('node:dgram');

const DISCOVERY_PORT = 41337;
const BROADCAST_MS = 12000;

function interfaceBroadcasts() {
  const addresses = ['255.255.255.255'];
  const os = require('node:os');
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((entry) => {
      if (entry.family !== 'IPv4' || entry.internal) return;
      const parts = entry.address.split('.').map(Number);
      if (parts.length !== 4) return;
      const mask = String(entry.netmask || '255.255.255.0').split('.').map(Number);
      const broadcast = parts.map((part, index) => (part & mask[index]) | (~mask[index] & 255)).join('.');
      if (!addresses.includes(broadcast)) addresses.push(broadcast);
    });
  });
  return addresses;
}

class Discovery {
  constructor(options) {
    this.deviceId = options.deviceId;
    this.name = options.name || 'جهاز الحضور';
    this.port = options.port;
    this.key = options.key;
    this.logger = options.logger;
    this.onPeer = options.onPeer || function () {};
    this.socket = null;
    this.timer = null;
    this.enabled = true;
  }

  message() {
    // لا يُبثّ مفتاح المزامنة إطلاقًا؛ الاكتشاف يعرض العنوان والاسم فقط
    // وتتم المزاوجة بمفتاح يُدخله المشرف يدويًا.
    return JSON.stringify({
      app: 'sa36',
      v: 1,
      deviceId: this.deviceId,
      name: this.name,
      port: this.port
    });
  }

  start() {
    if (this.socket) return this;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (error) => {
      this.logger.warn('discovery_socket_error', { message: error.message });
      try { this.socket.close(); } catch (ignored) { /* تجاهل */ }
      this.socket = null;
    });
    this.socket.on('message', (buffer, remote) => {
      if (!buffer || buffer.length > 4096) return;
      let payload = null;
      try { payload = JSON.parse(buffer.toString('utf8')); } catch (error) { return; }
      if (!payload || payload.app !== 'sa36' || payload.v !== 1) return;
      if (!payload.deviceId || payload.deviceId === this.deviceId) return;
      const port = Number(payload.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      this.onPeer({
        deviceId: String(payload.deviceId).slice(0, 64),
        name: String(payload.name || '').slice(0, 80),
        url: 'http://' + remote.address + ':' + port
      });
    });
    this.socket.bind(DISCOVERY_PORT, () => {
      try { this.socket.setBroadcast(true); } catch (error) {
        this.logger.warn('discovery_broadcast_failed', { message: error.message });
      }
      this.broadcast();
      this.timer = setInterval(() => this.broadcast(), BROADCAST_MS);
      if (this.timer.unref) this.timer.unref();
    });
    return this;
  }

  broadcast() {
    if (!this.socket || !this.enabled) return;
    const data = Buffer.from(this.message(), 'utf8');
    interfaceBroadcasts().forEach((address) => {
      try {
        this.socket.send(data, 0, data.length, DISCOVERY_PORT, address, () => {});
      } catch (error) {
        this.logger.debug('discovery_send_failed', { address, message: error.message });
      }
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch (ignored) { /* تجاهل */ }
      this.socket = null;
    }
  }
}

module.exports = { Discovery, DISCOVERY_PORT };
