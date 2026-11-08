// 08_People.gs — الطلاب والسائقون والإعدادات. التحقق من الهوية يتم دائمًا في الخادم.
function validateStudent_(input, others, legacy) {
  var student = {
    id: normalizeId_(cleanText_(input && input.id, 30)),
    name: cleanText_(input && input.name, 120),
    classroom: cleanText_(input && input.classroom, 80),
    phone: cleanText_(input && input.phone, 30),
    active: !input || input.active !== false
  };
  var validId = /^[0-9]{4}$/.test(student.id) ||
    /^STU[-_]?[0-9]{3,}$/.test(student.id) ||
    (legacy && /^[0-9A-Za-z_-]+$/.test(student.id));
  if (!validId) {
    fail_('VALIDATION', 'رقم الطالب يجب أن يكون 4 أرقام (مثال 1001) أو رمز بطاقة 3.5 (مثال STU-1001).');
  }
  if (!normalizeName_(student.name) || !student.classroom) {
    fail_('VALIDATION', 'اسم الطالب والصف مطلوبان.');
  }
  (others || []).forEach(function (other) {
    if (normalizeId_(other.id) === student.id) fail_('CONFLICT', 'رقم الطالب مسجل مسبقًا.');
    if (normalizeName_(other.name) === normalizeName_(student.name)) fail_('CONFLICT', 'اسم الطالب مسجل مسبقًا.');
  });
  return student;
}

function publicStudent_(student) {
  return {
    id: student.id, name: student.name, classroom: student.classroom,
    phone: student.phone || '', active: !!student.active
  };
}

function getStudents_(ctx) {
  return readTable_('Students').map(publicStudent_);
}

function saveStudent_(ctx, payload) {
  var students = readTable_('Students');
  var originalId = payload.originalId ? normalizeId_(payload.originalId) : '';
  var index = originalId ? students.findIndex(function (student) { return normalizeId_(student.id) === originalId; }) : -1;
  if (originalId && index < 0) fail_('NOT_FOUND', 'الطالب غير موجود.');
  if (originalId && normalizeId_(payload.id) !== originalId) fail_('VALIDATION', 'رقم الطالب ثابت؛ يمكن تعديل بقية البيانات.');
  var others = students.filter(function (student, position) { return position !== index; });
  var student = validateStudent_(payload, others, !!originalId);
  var before = index >= 0 ? publicStudent_(students[index]) : null;
  var record = index >= 0 ? students[index] : { token: '' };
  record.id = student.id;
  record.name = student.name;
  record.classroom = student.classroom;
  record.phone = student.phone;
  record.active = student.active;
  if (index >= 0) updateRow_('Students', students[index]._row, record);
  else appendRows_('Students', [record]);
  audit_(ctx, index >= 0 ? 'تعديل طالب' : 'إضافة طالب', {
    targetType: 'student', targetId: student.id,
    details: student.name + ' | ' + student.classroom,
    before: before, after: publicStudent_(student)
  });
  return { student: publicStudent_(student), students: getStudents_(ctx) };
}

function importStudents_(ctx, payload) {
  var batch = payload.rows;
  if (!Array.isArray(batch) || !batch.length || batch.length > 500) {
    fail_('VALIDATION', 'أرسل من طالب واحد إلى 500 طالب في الدفعة.');
  }
  var all = readTable_('Students');
  var additions = [];
  batch.forEach(function (input, index) {
    try {
      var student = validateStudent_(input, all.concat(additions), false);
      additions.push({ id: student.id, name: student.name, classroom: student.classroom, phone: student.phone, active: student.active, token: '' });
    } catch (error) {
      var message = error && error.message ? error.message : 'بيانات غير صحيحة.';
      fail_('VALIDATION', 'السطر ' + (index + 1) + ': ' + message);
    }
  });
  appendRows_('Students', additions);
  audit_(ctx, 'استيراد طلاب', { targetType: 'student', details: 'العدد: ' + additions.length, after: { count: additions.length } });
  return { count: additions.length, students: getStudents_(ctx) };
}

function driverStudentIds_(driver) {
  return parseJson_(driver.studentIds || '[]', []).map(normalizeId_);
}

function publicDriver_(driver, includePrivate) {
  var result = {
    code: driver.code, name: driver.name, area: driver.area,
    students: driverStudentIds_(driver), active: !!driver.active
  };
  if (includePrivate) {
    result.phone = driver.phone || '';
    result.identity = driver.identity || '';
    result.updatedAt = driver.updatedAt || '';
    result.deletedReason = driver.deletedReason || '';
  }
  return result;
}

function getDriverAdminData_(ctx) {
  var students = readTable_('Students');
  return {
    drivers: readTable_('Drivers').filter(function (driver) { return !driver.deleted; })
      .map(function (driver) { return publicDriver_(driver, true); }),
    students: students.filter(function (student) { return student.active; }).map(function (student) {
      return { id: student.id, name: student.name, classroom: student.classroom };
    })
  };
}

function saveDriver_(ctx, payload) {
  var drivers = readTable_('Drivers');
  var students = readTable_('Students');
  if (!payload || typeof payload.active !== 'boolean' || !Array.isArray(payload.students)) {
    fail_('VALIDATION', 'بيانات السائق غير صحيحة.');
  }
  var originalCode = payload.originalCode ? normalizeId_(payload.originalCode) : '';
  var index = originalCode ? drivers.findIndex(function (driver) { return normalizeId_(driver.code) === originalCode; }) : -1;
  if (originalCode && (index < 0 || drivers[index].deleted)) fail_('NOT_FOUND', 'السائق غير موجود.');
  var code = normalizeId_(String(payload.code || '').replace(/^DRV\s*[:\-]\s*/i, ''));
  if (!/^9[0-9]{3}$/.test(code)) fail_('VALIDATION', 'رقم السائق 4 أرقام يبدأ بالرقم 9، مثل 9001.');
  if (originalCode && code !== originalCode) fail_('VALIDATION', 'رقم السائق ثابت بعد الإنشاء.');
  var name = cleanText_(payload.name, 120);
  var area = cleanText_(payload.area, 100);
  var phone = cleanText_(payload.phone, 30);
  var identity = cleanText_(payload.identity, 30);
  if (!name || !area || !phone || !identity) fail_('VALIDATION', 'الاسم والمنطقة والجوال والهوية أو الإقامة مطلوبة.');
  if (drivers.some(function (driver, position) { return position !== index && normalizeId_(driver.code) === code; })) {
    fail_('CONFLICT', 'رقم السائق مستخدم.');
  }
  var ids = payload.students.map(normalizeId_);
  if (new Set(ids).size !== ids.length) fail_('VALIDATION', 'قائمة الطلاب مكررة.');
  ids.forEach(function (id) {
    if (!students.some(function (student) { return normalizeId_(student.id) === id; })) {
      fail_('VALIDATION', 'الطالب ' + id + ' غير موجود.');
    }
  });
  if (payload.active) {
    var conflict = drivers.filter(function (driver) {
      return driver.active && !driver.deleted && (!originalCode || normalizeId_(driver.code) !== originalCode) &&
        driverStudentIds_(driver).some(function (id) { return ids.indexOf(id) >= 0; });
    })[0];
    if (conflict) fail_('CONFLICT', 'أحد الطلاب مرتبط بسائق نشط آخر (' + conflict.code + ').');
  }
  var before = index >= 0 ? publicDriver_(drivers[index], true) : null;
  var record = index >= 0 ? drivers[index] : { deleted: false, deletedReason: '' };
  record.code = code;
  record.name = name;
  record.area = area;
  record.phone = phone;
  record.identity = identity;
  record.studentIds = JSON.stringify(ids);
  record.active = payload.active;
  record.updatedAt = stamp_();
  if (index >= 0) updateRow_('Drivers', drivers[index]._row, record);
  else appendRows_('Drivers', [record]);
  var revokedCards = record.active ? 0 : revokeOwnerCards_('DRIVER', code, ctx.account.username, 'إيقاف السائق');
  audit_(ctx, index >= 0 ? 'تعديل سائق' : 'إضافة سائق', {
    targetType: 'driver', targetId: code,
    details: name + ' | ' + ids.length + ' طالب' + (revokedCards ? ' | بطاقات ملغاة: ' + revokedCards : ''),
    before: before, after: publicDriver_(record, true)
  });
  return { driver: publicDriver_(record, true), data: getDriverAdminData_(ctx) };
}

function deleteDriver_(ctx, payload) {
  var drivers = readTable_('Drivers');
  var code = normalizeId_(payload.code);
  var index = drivers.findIndex(function (driver) { return normalizeId_(driver.code) === code && !driver.deleted; });
  if (index < 0) fail_('NOT_FOUND', 'السائق غير موجود.');
  var reason = cleanText_(payload.reason || '', 300);
  if (reason.length < 5) fail_('VALIDATION', 'سبب الحذف مطلوب (5 أحرف على الأقل).');
  var before = publicDriver_(drivers[index], true);
  var record = drivers[index];
  record.deleted = true;
  record.active = false;
  record.deletedReason = reason;
  record.updatedAt = stamp_();
  updateRow_('Drivers', record._row, record);
  var revokedCards = revokeOwnerCards_('DRIVER', code, ctx.account.username, 'حذف السائق');
  audit_(ctx, 'حذف سائق', {
    targetType: 'driver', targetId: code, reason: reason, before: before,
    after: { deleted: true, revokedCards: revokedCards }
  });
  return { data: getDriverAdminData_(ctx) };
}

function validateSettings_(input) {
  if (!isPlainObject_(input)) fail_('VALIDATION', 'بيانات الإعدادات غير صحيحة.');
  var workdays = input.workdays;
  if (!Array.isArray(workdays) || !workdays.length || workdays.some(function (day) {
    return !Number.isInteger(day) || day < 0 || day > 6;
  })) fail_('VALIDATION', 'حدد أيام الدراسة.');
  ['holidays', 'supervisors', 'classrooms'].forEach(function (key) {
    if (input[key] !== undefined && !Array.isArray(input[key])) fail_('VALIDATION', 'قيمة إعداد غير صحيحة: ' + key);
  });
  var result = {
    systemName: cleanText_(input.systemName, 100),
    schoolName: cleanText_(input.schoolName, 100),
    classrooms: Array.from(new Set((input.classrooms || []).map(function (item) { return cleanText_(item, 80); }).filter(Boolean))),
    workdays: Array.from(new Set(workdays)).sort(),
    holidays: Array.from(new Set((input.holidays || []).map(validateDate_))).sort(),
    supervisors: Array.from(new Set((input.supervisors || []).map(function (email) {
      email = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('VALIDATION', 'بريد المشرف غير صحيح.');
      return email;
    }))),
    autoClose: input.autoClose === true,
    closeTime: validateTime_(input.closeTime, '08:00'),
    autoBackup: input.autoBackup === true,
    backupTime: validateTime_(input.backupTime, '15:00'),
    retention: Number(input.retention || 30),
    lateAfter: validateTime_(input.lateAfter, '07:30'),
    ssoEnabled: input.ssoEnabled === true
  };
  if (!result.systemName || !result.schoolName) fail_('VALIDATION', 'اسم النظام والمدرسة مطلوبان.');
  if (!Number.isInteger(result.retention) || result.retention < 2 || result.retention > 365) {
    fail_('VALIDATION', 'عدد النسخ المحتفظ بها بين 2 و365.');
  }
  return result;
}

function getSettings_(ctx) {
  return sanitizeSettings_(readSettings_(), ctx.account);
}

function saveSettings_(ctx, payload) {
  var before = readSettings_();
  var input = payload && payload.settings ? payload.settings : payload;
  // المشرفون يُدارون من المشرف الأصلي فقط؛ أي قيمة مرسلة من مدير آخر تُتجاهل حفاظًا على SSO.
  if (isPlainObject_(input) && permissionsFor_(ctx.account).indexOf('users') < 0) {
    input = Object.assign({}, input, { supervisors: before.supervisors || [] });
  }
  var settings = validateSettings_(input);
  setSettings_(settings);
  audit_(ctx, 'حفظ الإعدادات', {
    targetType: 'settings',
    before: sanitizeSettings_(before, ctx.account),
    after: sanitizeSettings_(settings, ctx.account)
  });
  return sanitizeSettings_(settings, ctx.account);
}

function getDatabaseStatus_(ctx) {
  var book = db_();
  var tables = Object.keys(TABLES_).map(function (name) {
    var sheet = book.getSheetByName(name);
    return {
      name: name,
      exists: !!sheet,
      valid: !!sheet && headerMatches_(sheet, name),
      rows: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0
    };
  });
  return {
    version: APP_VERSION_,
    database: databaseInfo_(),
    tables: tables,
    valid: tables.every(function (table) { return table.valid; }),
    schemaVersion: PropertiesService.getScriptProperties().getProperty('SCHEMA_VERSION') || ''
  };
}
