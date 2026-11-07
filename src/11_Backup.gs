// 11_Backup.gs — نسخ احتياطي قابل للتحقق واستعادة آمنة مع نسخة أمان قبل الاستبدال.
var BACKUP_FORMAT_ = 'school-attendance-backup';
var BACKUP_VERSION_ = 6;

function plainRow_(name, row) {
  var object = {};
  TABLES_[name].forEach(function (key) { object[key] = row[key] === undefined || row[key] === null ? '' : row[key]; });
  return object;
}

function snapshot_() {
  var payload = {
    format: BACKUP_FORMAT_,
    version: BACKUP_VERSION_,
    appVersion: APP_VERSION_,
    createdAt: stamp_(),
    settings: readSettings_(),
    tables: {},
    accounts: accounts_().map(function (account) {
      return { id: account.id, username: account.username, name: account.name, email: account.email || '', role: account.role, active: !!account.active };
    })
  };
  Object.keys(TABLES_).forEach(function (name) {
    payload.tables[name] = readTable_(name).map(function (row) { return plainRow_(name, row); });
  });
  return payload;
}

function validateSnapshot_(payload) {
  if (!payload || payload.format !== BACKUP_FORMAT_ || payload.version !== BACKUP_VERSION_) {
    fail_('VALIDATION', 'صيغة النسخة الاحتياطية غير مدعومة.');
  }
  var settings = validateSettings_(payload.settings);
  var tables = {};
  Object.keys(TABLES_).forEach(function (name) {
    if (!Array.isArray(payload.tables[name])) fail_('VALIDATION', 'جدول ناقص في النسخة: ' + name);
    if (payload.tables[name].length > 200000) fail_('VALIDATION', 'جدول كبير بشكل غير معقول: ' + name);
    tables[name] = payload.tables[name].map(function (row) {
      if (!isPlainObject_(row)) fail_('VALIDATION', 'صف غير صحيح في ' + name);
      var clean = {};
      TABLES_[name].forEach(function (key) {
        var value = row[key];
        if (value === undefined || value === null) value = '';
        if (!['string', 'number', 'boolean'].includes(typeof value)) fail_('VALIDATION', 'قيمة غير صحيحة في ' + name);
        clean[key] = value;
      });
      return clean;
    });
  });

  var students = {};
  tables.Students.forEach(function (student) {
    var id = normalizeId_(student.id);
    if (!/^[0-9A-Za-z_-]+$/.test(id) || students[id]) fail_('VALIDATION', 'هوية طالب مكررة أو غير صحيحة.');
    var active = student.active === true || String(student.active).toLowerCase() === 'true';
    if (typeof student.active !== 'boolean' && String(student.active).toLowerCase() !== 'true' && String(student.active).toLowerCase() !== 'false') {
      fail_('VALIDATION', 'حالة طالب غير صحيحة.');
    }
    students[id] = { active: active, name: student.name };
  });
  var drivers = {};
  tables.Drivers.forEach(function (driver) {
    if (drivers[driver.code]) fail_('VALIDATION', 'رقم سائق مكرر في النسخة.');
    drivers[driver.code] = true;
  });
  var dayMap = {};
  tables.Days.forEach(function (day) {
    validateDate_(day.date);
    if (dayMap[day.date]) fail_('VALIDATION', 'يوم مكرر في النسخة.');
    dayMap[day.date] = day;
    if (!Number.isInteger(Number(day.startRow)) || Number(day.startRow) < 2 ||
        !Number.isInteger(Number(day.rowCount)) || Number(day.rowCount) < 1) {
      fail_('VALIDATION', 'فهرس يوم غير صحيح في النسخة.');
    }
  });
  var recordKeys = {};
  tables.Attendance.forEach(function (record) {
    validateDate_(record.date);
    var key = record.date + '/' + normalizeId_(record.id);
    if (recordKeys[key]) fail_('VALIDATION', 'سجل حضور مكرر في النسخة.');
    recordKeys[key] = true;
    if (!dayMap[record.date]) fail_('VALIDATION', 'سجل بلا يوم في النسخة.');
    if (ATTENDANCE_STATUS_.indexOf(record.status) < 0) fail_('VALIDATION', 'حالة حضور غير صحيحة.');
    if (record.outAt && !record.inAt) fail_('VALIDATION', 'انصراف بلا حضور في النسخة.');
    if (record.outAt && record.outAt < record.inAt) fail_('VALIDATION', 'وقت انصراف قبل الحضور.');
  });
  var positions = {};
  tables.Days.forEach(function (day) {
    var start = Number(day.startRow), count = Number(day.rowCount);
    for (var index = start - 2; index < start - 2 + count; index++) {
      if (positions[index]) fail_('VALIDATION', 'تداخل في فهرس الحضور.');
      if (!tables.Attendance[index] || tables.Attendance[index].date !== day.date) fail_('VALIDATION', 'فهرس الحضور لا يطابق الأيام.');
      positions[index] = true;
    }
  });
  if (Object.keys(positions).length !== tables.Attendance.length) {
    fail_('VALIDATION', 'سجلات حضور خارج فهرس الأيام.');
  }
  var hashes = {};
  tables.Cards.forEach(function (card) {
    if (CARD_TYPES_.indexOf(card.type) < 0) fail_('VALIDATION', 'نوع بطاقة غير صحيح في النسخة.');
    if (CARD_STATUS_.indexOf(card.status) < 0) fail_('VALIDATION', 'حالة بطاقة غير صحيحة في النسخة.');
    if (!/^[0-9a-f]{64}$/.test(String(card.token_hash))) fail_('VALIDATION', 'بصمة بطاقة غير صحيحة.');
    if (hashes[card.token_hash]) fail_('VALIDATION', 'بصمة بطاقة مكررة.');
    hashes[card.token_hash] = true;
  });
  tables.Journeys.forEach(function (trip) {
    if ([TRIP_DRAFT_, TRIP_CONFIRMED_, TRIP_CANCELLED_].indexOf(trip.status) < 0) {
      fail_('VALIDATION', 'حالة رحلة غير صحيحة.');
    }
  });
  return { version: BACKUP_VERSION_, createdAt: payload.createdAt || '', settings: settings, tables: tables };
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER');
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (error) { /* أُنشئ مجلد جديد إذا حُذف القديم */ }
  }
  var folder = DriveApp.createFolder('نسخ احتياطية — نظام الحضور');
  props.setProperty('BACKUP_FOLDER', folder.getId());
  return folder;
}

function backupFiles_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER');
  if (!id) return [];
  var iterator;
  try { iterator = DriveApp.getFolderById(id).getFiles(); }
  catch (error) { return []; }
  var files = [];
  while (iterator.hasNext()) {
    var file = iterator.next();
    if (!file.isTrashed() && /^attendance-.*\.json$/.test(file.getName())) files.push(file);
  }
  return files.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
}

function pruneBackups_(keep) {
  var files = backupFiles_();
  var limit = Math.max(2, Number(keep) || 30);
  var removed = 0;
  files.slice(limit).forEach(function (file) { file.setTrashed(true); removed += 1; });
  return removed;
}

function createBackup_(ctx) {
  var payload = snapshot_();
  var folder = backupFolder_();
  var name = 'attendance-' + Utilities.formatDate(new Date(), TIMEZONE_, 'yyyyMMdd-HHmmss') + '.json';
  var file = folder.createFile(name, JSON.stringify(payload), MimeType.PLAIN_TEXT);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('LAST_BACKUP', payload.createdAt);
  props.deleteProperty('BACKUP_ERROR');
  var removed = pruneBackups_(readSettings_().retention);
  audit_(ctx, 'نسخة احتياطية', {
    targetType: 'backup', targetId: file.getId(),
    details: 'حجم البيانات: ' + payload.tables.Attendance.length + ' سجل حضور | حُذف ' + removed + ' نسخة قديمة'
  });
  return {
    id: file.getId(), url: file.getUrl(), createdAt: payload.createdAt,
    counts: {
      students: payload.tables.Students.length, records: payload.tables.Attendance.length,
      days: payload.tables.Days.length, trips: payload.tables.Journeys.length
    },
    pruned: removed
  };
}

function readBackup_(id) {
  var file = backupFiles_().filter(function (item) { return item.getId() === id; })[0];
  if (!file) fail_('NOT_FOUND', 'النسخة غير موجودة داخل مجلد نسخ النظام.');
  if (file.getSize() > 20 * 1024 * 1024) fail_('VALIDATION', 'النسخة كبيرة؛ تحتاج استعادة بإشراف تقني.');
  var text = file.getBlob().getDataAsString('UTF-8');
  return validateSnapshot_(parseJson_(text, null));
}

function previewRestore_(ctx, payload) {
  var data = readBackup_(String(payload.id || ''));
  return {
    students: data.tables.Students.length,
    records: data.tables.Attendance.length,
    days: data.tables.Days.length,
    drivers: data.tables.Drivers.length,
    cards: data.tables.Cards.length,
    trips: data.tables.Journeys.length,
    createdAt: data.createdAt || ''
  };
}

function chunk_(items, size) {
  var chunks = [];
  for (var i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function replaceTables_(payload) {
  clearCache_();
  Object.keys(TABLES_).forEach(function (name) {
    var sheet = sheet_(name);
    var last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, TABLES_[name].length).clearContent();
    chunk_(payload.tables[name], 2000).forEach(function (batch) { appendRows_(name, batch); });
  });
  var current = readSettings_();
  var restored = Object.assign({}, payload.settings);
  // لا تُستعاد صلاحيات الوصول أو الأتمتة من نسخة قديمة.
  restored.supervisors = current.supervisors;
  restored.autoBackup = current.autoBackup;
  restored.backupTime = current.backupTime;
  restored.retention = current.retention;
  restored.autoClose = current.autoClose;
  restored.closeTime = current.closeTime;
  restored.ssoEnabled = current.ssoEnabled;
  setSettings_(restored);
  clearCache_();
}

function restoreBackup_(ctx, payload) {
  if (payload.confirmation !== 'استعادة') fail_('VALIDATION', 'اكتب كلمة «استعادة» لتأكيد العملية.');
  var target = readBackup_(String(payload.id || ''));
  var before = snapshot_();
  var safety = createBackup_(ctx);
  try {
    replaceTables_(target);
    audit_(ctx, 'استعادة نسخة احتياطية', {
      targetType: 'backup', targetId: String(payload.id || ''),
      details: 'نسخة الأمان: ' + safety.id,
      before: { records: before.tables.Attendance.length, students: before.tables.Students.length },
      after: { records: target.tables.Attendance.length, students: target.tables.Students.length }
    });
    return {
      safetyUrl: safety.url,
      counts: {
        students: target.tables.Students.length, records: target.tables.Attendance.length,
        days: target.tables.Days.length, trips: target.tables.Journeys.length
      }
    };
  } catch (error) {
    try { replaceTables_(before); }
    catch (rollbackError) {
      fail_('INTERNAL', 'تعذرت الاستعادة والتراجع. أوقف التسجيل واحتفظ بمعرّف نسخة الأمان: ' + safety.id);
    }
    fail_('INTERNAL', 'لم تكتمل الاستعادة؛ أُعيدت البيانات السابقة. ' + (error && error.message ? error.message : ''));
  }
}

function getBackupStatus_(ctx) {
  var props = PropertiesService.getScriptProperties();
  return {
    lastSuccess: props.getProperty('LAST_BACKUP') || '',
    error: props.getProperty('BACKUP_ERROR') || '',
    maintenanceError: props.getProperty('MAINTENANCE_ERROR') || '',
    triggerActive: ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getHandlerFunction() === 'maintenance_'; }),
    files: backupFiles_().map(function (file) {
      return { id: file.getId(), name: file.getName(), url: file.getUrl(), createdAt: file.getDateCreated().toISOString(), size: file.getSize() };
    })
  };
}

function expireStaleTrips_(operator) {
  var cutoff = addDays_(today_(), -2);
  var rows = readTable_('Journeys');
  var count = 0;
  rows.forEach(function (trip) {
    if (trip.status === TRIP_DRAFT_ && trip.date < cutoff) {
      trip.status = TRIP_CANCELLED_;
      trip.revision = Number(trip.revision || 0) + 1;
      trip.history = JSON.stringify(tripHistory_(trip, 'إلغاء تلقائي', 'مسودة أقدم من 48 ساعة', operator || 'النظام'));
      updateRow_('Journeys', trip._row, trip);
      count += 1;
    }
  });
  return count;
}

function runRetention_(ctx) {
  var settings = readSettings_();
  var pruned = pruneBackups_(settings.retention);
  var cancelled = expireStaleTrips_(ctx.account.username);
  cleanSessions_();
  var auditRows = readTable_('Audit');
  var cutoff = addDays_(today_(), -730);
  var oldAudit = auditRows.filter(function (row) { return row.at && row.at.slice(0, 10) < cutoff; }).length;
  audit_(ctx, 'تطبيق سياسة الاحتفاظ', {
    details: 'نسخ محذوفة: ' + pruned + ' | رحلات ملغاة: ' + cancelled + ' | سجلات تدقيق أقدم من سنتين: ' + oldAudit,
    after: { pruned: pruned, cancelledTrips: cancelled, oldAudit: oldAudit }
  });
  return {
    prunedBackups: pruned, cancelledTrips: cancelled, oldAuditRecords: oldAudit,
    note: 'سجلات الحضور التاريخية لا تُحذف تلقائيًا؛ تُصدَّر سنويًا وفق سياسة الاحتفاظ.'
  };
}
