'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, shell, ipcMain, safeStorage, session, dialog } = require('electron');

const { Runtime } = require('./vm/runtime');
const { Logger } = require('./lib/logger');
const { Secrets } = require('./lib/secrets');
const { SyncEngine } = require('./sync/engine');
const { Discovery } = require('./sync/discovery');
const { BackupManager } = require('./backup/manager');
const { requestApproval } = require('./lib/elevation');
const { AppServer } = require('./server');
const { Updater } = require('./update/updater');

const APP_ID = 'sa.school.attendance.desktop';
const PREFERRED_PORT = 43118;
const packageInfo = require('./package.json');

let logger = null;
let runtime = null;
let engine = null;
let discovery = null;
let backup = null;
let server = null;
let window = null;
let dataDir = '';
let baseUrl = '';
let heartbeat = null;
let maintenanceTimer = null;

function resolveDataDir() {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return path.join(portable, 'SchoolAttendanceData');
  return path.join(app.getPath('userData'), 'data');
}

function notify(channel, payload) {
  if (window && !window.isDestroyed() && window.webContents) {
    window.webContents.send(channel, payload);
  }
}

function runMaintenance() {
  if (!runtime || !runtime.installed) return;
  Promise.resolve(runtime.maintenance()).catch((error) => {
    logger.warn('maintenance_failed', { message: error && error.message });
  });
}

function startBackgroundWork() {
  if (!runtime.installed) return;
  engine.start();
  if (discovery) discovery.start();
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      if (!runtime.installed) return;
      backup.tick().then((result) => {
        if (result && result.ok) notify('desktop:backup-finished', { ok: true, at: new Date().toISOString() });
      }).catch((error) => {
        logger.warn('backup_tick_failed', { message: error && error.message });
        notify('desktop:backup-finished', { ok: false, message: error && error.message });
      });
    }, 60 * 1000);
    if (heartbeat.unref) heartbeat.unref();
  }
  if (!maintenanceTimer) {
    maintenanceTimer = setInterval(runMaintenance, 10 * 60 * 1000);
    if (maintenanceTimer.unref) maintenanceTimer.unref();
    runMaintenance();
  }
}

async function listenServer() {
  const ports = [PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2, 0];
  let lastError = null;
  for (const port of ports) {
    try {
      await server.listen(port);
      return server.port;
    } catch (error) {
      lastError = error;
      logger.warn('http_port_busy', { port, message: error.message });
    }
  }
  throw lastError || new Error('تعذر تشغيل خادم التطبيق.');
}

function createMenu() {
  const template = [
    {
      label: 'النظام',
      submenu: [
        { label: 'إعادة تحميل', role: 'reload' },
        { label: 'تكبير', role: 'zoomin' },
        { label: 'تصغير', role: 'zoomout' },
        { label: 'الحجم الطبيعي', role: 'resetzoom' },
        { type: 'separator' },
        {
          label: 'فتح مجلد البيانات',
          click: () => { shell.openPath(dataDir).catch(() => {}); }
        },
        { type: 'separator' },
        { label: 'خروج', role: 'quit' }
      ]
    },
    {
      label: 'مساعدة',
      submenu: [
        { label: 'عن النظام', click: () => {
          if (window) window.webContents.send('desktop:status-changed', { version: packageInfo.version });
        } },
        { label: 'أدوات المطور', role: 'toggleDevTools', visible: process.argv.includes('--dev') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const icon = path.join(__dirname, 'build', 'icon.ico');
  window = new BrowserWindow({
    width: 1280,
    height: 830,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#f4f7f8',
    title: 'نظام الحضور والانصراف',
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (baseUrl && url.indexOf(baseUrl) === 0) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
  window.on('closed', () => { window = null; });
  return window.loadURL(baseUrl);
}

function configureSession() {
  try {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media');
  } catch (error) {
    logger.warn('session_permissions_failed', { message: error.message });
  }
}

async function boot() {
  app.setAppUserModelId(APP_ID);
  dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  logger = new Logger(dataDir, { verbose: process.argv.includes('--dev') });
  logger.info('app_starting', { version: packageInfo.version, dataDir });

  runtime = new Runtime({
    dataDir,
    logger,
    deviceName: 'جهاز الحضور',
    onMutation: (changes) => { if (engine) engine.onMutation(changes); }
  });
  runtime.init();

  engine = new SyncEngine({
    dataDir,
    store: runtime.store,
    runtime,
    logger,
    deviceName: runtime.store.meta.deviceName,
    onApplied: (result) => {
      notify('desktop:sync-applied', { stats: result.stats, at: new Date().toISOString() });
    }
  });

  const secrets = new Secrets(dataDir, { safeStorage });
  backup = new BackupManager({
    dataDir,
    store: runtime.store,
    runtime,
    logger,
    secrets,
    deviceName: runtime.store.meta.deviceName,
    deviceId: engine.deviceId
  });

  discovery = new Discovery({
    deviceId: engine.deviceId,
    name: engine.deviceName,
    port: PREFERRED_PORT,
    logger,
    onPeer: (peer) => {
      engine.observePeer(peer);
      engine.syncNow('discovery').catch(() => {});
    }
  });

  server = new AppServer({
    runtime,
    engine,
    backup,
    discovery,
    update: new Updater({
      currentVersion: packageInfo.version,
      downloadDir: path.join(dataDir, 'updates'),
      logger
    }),
    logger,
    dataDir,
    uiDir: path.join(__dirname, 'ui'),
    appVersion: packageInfo.version,
    onInstalled: () => {
      startBackgroundWork();
      notify('desktop:status-changed', { installed: true });
    }
  });

  const port = await listenServer();
  server.port = port;
  baseUrl = 'http://127.0.0.1:' + port + '/';
  discovery.port = port;
  logger.info('app_ready', { url: baseUrl, installed: runtime.installed });
  // فحص تحديث صامت عند الإقلاع؛ النتيجة تظهر في لوحة سطح المكتب.
  server.update.check().catch(() => {});

  configureSession();
  createMenu();
  await createWindow();
  startBackgroundWork();
}

function shutdown() {
  try { if (engine) engine.stop(); } catch (ignored) { /* تجاهل */ }
  try { if (discovery) discovery.stop(); } catch (ignored) { /* تجاهل */ }
  if (heartbeat) clearInterval(heartbeat);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  try { if (runtime && runtime.store) runtime.store.save(); } catch (ignored) { /* تجاهل */ }
  try { if (server) server.close(); } catch (ignored) { /* تجاهل */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(boot).catch((error) => {
    const message = error && error.stack ? error.stack : String(error);
    try { if (logger) logger.error('boot_failed', { message }); } catch (ignored) { /* تجاهل */ }
    const { dialog } = require('electron');
    dialog.showErrorBox('تعذر تشغيل النظام', message);
    app.quit();
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', shutdown);

  process.on('uncaughtException', (error) => {
    if (logger) logger.error('uncaught_exception', { message: error && error.message, stack: String(error && error.stack).slice(0, 2000) });
  });
  process.on('unhandledRejection', (reason) => {
    if (logger) logger.error('unhandled_rejection', { message: String(reason && reason.message ? reason.message : reason).slice(0, 1000) });
  });
}

ipcMain.handle('desktop:open-external', (_event, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  return shell.openExternal(String(url)).then(() => true).catch(() => false);
});
ipcMain.handle('desktop:open-data-folder', () => shell.openPath(dataDir).then(() => true).catch(() => false));

ipcMain.handle('desktop:open-file', (_event, filePath) => {
  // افتح مثبّت التحديث المنزّل فقط: .exe داخل مجلد updates الخاص بالبيانات.
  const target = String(filePath || '');
  const resolved = path.resolve(target);
  const allowed = path.resolve(path.join(dataDir, 'updates'));
  if (!resolved.startsWith(allowed + path.sep) || !/\.exe$/i.test(resolved) || !fs.existsSync(resolved)) return false;
  return shell.openPath(resolved).then((error) => !error).catch(() => false);
});
ipcMain.handle('desktop:open-backups', () => {
  const dir = path.join(dataDir, 'backups', 'exports');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (ignored) { /* يعرض المجلد الأب */ }
  return shell.openPath(dir).then(() => true).catch(() => false);
});
ipcMain.handle('desktop:quit', () => { app.quit(); return true; });

// استعادة كلمة مرور المشرف من شاشة الدخول:
// 1) تأكيد في نافذة Electron أصلية.
// 2) موافقة مسؤول Windows عبر UAC — لا يستطيع مستخدم عادي إتمامها.
// 3) كلمة مرور مؤقتة تُعرض مرة واحدة وتُلزم بتغييرها عند الدخول.
ipcMain.handle('desktop:recover-admin', async () => {
  if (!runtime || !runtime.installed) {
    return { error: 'لم يُجهَّز النظام بعد. أكمل الإعداد الأول.' };
  }
  const options = {
    type: 'warning',
    title: 'إعادة تعيين كلمة مرور المشرف',
    message: 'إعادة تعيين كلمة مرور المشرف',
    detail: 'سيُطلب منك تأكيد صلاحيات مسؤول Windows (UAC). ' +
      'إن لم تكن مسؤولًا على هذا الجهاز فلن تكتمل العملية. ' +
      'بعد الموافقة ستُلغى الجلسات النشطة وتظهر كلمة مرور مؤقتة مرة واحدة فقط، ' +
      'ويُطلب تغييرها عند أول دخول.',
    buttons: ['إلغاء', 'متابعة'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const answer = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (answer.response !== 1) return { cancelled: true };

  const approval = await requestApproval({ logger });
  if (!approval.ok) {
    if (approval.reason === 'cancelled') {
      logger.warn('admin_password_recovery_uac_cancelled', {});
      return { error: 'أُلغيت موافقة مسؤول Windows. لم تُغيَّر كلمة المرور.' };
    }
    const message = approval.reason === 'timeout'
      ? 'انتهت مهلة انتظار موافقة مسؤول Windows. لم تُغيَّر كلمة المرور.'
      : 'تعذر التحقق من صلاحية مسؤول Windows. يجب تشغيل الجهاز بحساب مسؤول وإتمام نافذة UAC.';
    logger.warn('admin_password_recovery_blocked', { reason: approval.reason });
    return { error: message };
  }

  try {
    const result = await runtime.recoverAdmin();
    if (!result || result.error) return { error: (result && result.error) || 'تعذر إعادة التعيين.' };
    logger.warn('admin_password_recovered', { username: result.username });
    return { username: result.username, temporaryPassword: result.temporaryPassword };
  } catch (error) {
    logger.error('admin_password_recovery_failed', { message: error && error.message });
    return { error: error && error.message ? error.message : 'تعذر إعادة التعيين.' };
  }
});
