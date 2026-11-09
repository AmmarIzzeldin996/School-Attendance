'use strict';

const crypto = require('node:crypto');

function deviceId() {
  return crypto.randomBytes(6).toString('hex');
}

function token(bytes) {
  return crypto.randomBytes(bytes || 32).toString('base64url');
}

function requestId() {
  return 'rq_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

function uuid() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

module.exports = { deviceId, token, requestId, uuid, sha256 };
