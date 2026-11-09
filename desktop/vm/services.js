'use strict';

const crypto = require('node:crypto');
const { clone } = require('../data/store');

function tzParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Riyadh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const map = {};
  parts.forEach((part) => { map[part.type] = part.value; });
  if (map.hour === '24') map.hour = '00';
  return map;
}

function formatDate(date, timeZone, pattern) {
  const parts = tzParts(date, timeZone);
  const values = {
    yyyy: parts.year,
    MM: parts.month,
    dd: parts.day,
    HH: parts.hour,
    mm: parts.minute,
    ss: parts.second,
    XXX: '+03:00'
  };
  return String(pattern).replace(/'/g, '').replace(/yyyy|MM|dd|HH|mm|ss|XXX/g, (token) => values[token]);
}

function createServices(store, options) {
  const logger = options.logger;
  const session = { email: String((options && options.email) || 'owner@school.local').toLowerCase() };

  const SpreadsheetApp = {
    openById(id) {
      const book = store.book();
      if (String(id) !== String(book.getId())) throw new Error('spreadsheet not found: ' + id);
      return book;
    },
    getActiveSpreadsheet() { return store.book(); },
    flush() {}
  };

  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) { return store.getProperty(key); },
        setProperty(key, value) { store.setProperty(key, value); },
        setProperties(object) {
          Object.keys(object || {}).forEach((key) => store.setProperty(key, object[key]));
        },
        getProperties() { return store.getProperties(); },
        deleteProperty(key) { store.deleteProperty(key); }
      };
    },
    getUserProperties() { return this.getScriptProperties(); },
    getDocumentProperties() { return this.getScriptProperties(); }
  };

  const CacheService = {
    getScriptCache() {
      return {
        get(key) { return store.cacheGet(key); },
        put(key, value, seconds) { store.cachePut(key, value, seconds); },
        remove(key) { store.cacheRemove(key); }
      };
    }
  };

  const LockService = {
    getScriptLock() {
      return {
        waitLock() {},
        releaseLock() {},
        tryLock() { return true; },
        hasLock() { return true; }
      };
    }
  };

  const Utilities = {
    getUuid() { return crypto.randomUUID(); },
    computeDigest(_algorithm, value) {
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest());
    },
    computeHmacSha256Signature(value, key) {
      return Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(Array.from(bytes || [])).toString('base64url');
    },
    formatDate(date, timeZone, pattern) { return formatDate(date, timeZone, pattern); },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  };

  const Session = {
    getActiveUser() { return { getEmail() { return session.email; } }; },
    getEffectiveUser() { return { getEmail() { return session.email; } }; }
  };

  function readTriggers() {
    try { return JSON.parse(store.getProperty('DESKTOP_TRIGGERS') || '[]'); } catch (error) { return []; }
  }

  function writeTriggers(list) {
    store.setProperty('DESKTOP_TRIGGERS', JSON.stringify(list));
  }

  const ScriptApp = {
    getProjectTriggers() {
      return readTriggers().map((trigger) => ({
        getHandlerFunction() { return trigger.handler; },
        getHandlerFunction_() { return trigger.handler; }
      }));
    },
    newTrigger(handler) {
      const builder = {
        timeBased() { return builder; },
        everyMinutes(minutes) { builder.minutes = Number(minutes) || 10; return builder; },
        create() {
          const list = readTriggers();
          if (!list.some((item) => item.handler === handler)) {
            list.push({ handler, minutes: builder.minutes || 10 });
            writeTriggers(list);
          }
          return builder;
        }
      };
      return builder;
    }
  };

  function folderApi(folder) {
    return {
      getId() { return folder.id; },
      getName() { return folder.name; },
      createFile(name, content) {
        const file = store.createFile(folder.id, name, content);
        return fileApi(file);
      },
      getFiles() {
        const files = store.listFolderFiles(folder.id)
          .slice()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        let index = 0;
        return {
          hasNext() { return index < files.length; },
          next() { return fileApi(files[index++]); }
        };
      }
    };
  }

  function fileApi(file) {
    return {
      getId() { return file.id; },
      getName() { return file.name; },
      getUrl() { return '/desktop/backup-file/' + encodeURIComponent(file.id); },
      getSize() { return file.size; },
      getDateCreated() { return new Date(file.createdAt); },
      isTrashed() { return !!file.trashed; },
      setTrashed(value) {
        if (value) store.trashFile(file.id);
        file.trashed = !!value;
      },
      getBlob() {
        return {
          getDataAsString() {
            const text = store.readFile(file.id);
            return text === null ? '' : text;
          }
        };
      }
    };
  }

  const DriveApp = {
    createFolder(name) {
      return folderApi(store.createFolder(name));
    },
    getFolderById(id) {
      const folder = store.getFolder(id);
      if (!folder) throw new Error('folder not found: ' + id);
      return folderApi(folder);
    }
  };

  const HtmlService = {
    createTemplateFromFile() {
      return {
        configJson: '',
        evaluate() {
          return {
            setTitle() { return this; },
            addMetaTag() { return this; },
            setXFrameOptionsMode() { return this; },
            getContent() { return '<html></html>'; }
          };
        }
      };
    },
    createHtmlOutputFromFile() { return { getContent() { return ''; } }; },
    XFrameOptionsMode: { DEFAULT: 'DEFAULT' }
  };

  const sandboxConsole = {
    log(...args) { logger.info('vm_console', { message: args.map(String).join(' ').slice(0, 1000) }); },
    warn(...args) { logger.warn('vm_console', { message: args.map(String).join(' ').slice(0, 1000) }); },
    error(...args) { logger.error('vm_console', { message: args.map(String).join(' ').slice(0, 1000) }); }
  };

  return {
    session,
    sandbox: {
      console: sandboxConsole,
      SpreadsheetApp,
      PropertiesService,
      CacheService,
      LockService,
      Utilities,
      Session,
      ScriptApp,
      DriveApp,
      HtmlService,
      MimeType: { PLAIN_TEXT: 'text/plain' },
      URL: { fetch() { throw new Error('URL.fetch is unavailable in the desktop runtime'); } },
      Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Error, RegExp,
      isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
    }
  };
}

module.exports = { createServices, formatDate };
