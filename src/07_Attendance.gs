// 07_Attendance.gs — سجل يومي واحد لكل (تاريخ، طالب)؛ الوصول والانصراف مستقلان.
function ensureDay_(operator) {
  var settings = readSettings_();
  var date = today_();
  if (!schoolDay_(date, settings)) return { day: null, date: date, offDay: true };
  var days = readTable_('Days');
  var day = days.filter(function (item) { return item.date === date; })[0] || null;
  if (day && day.closed) return { day: day, date: date, offDay: false };
  var roster = readTable_('Students').filter(function (student) { return student.active; });
  if (!roster.length) return { day: day, date: date, offDay: false };
  var existing = day ? readDayRows_(day) : [];
  var existingIds = {};
  existing.forEach(function (row) { existingIds[normalizeId_(row.id)] = true; });
  var missing = roster.filter(function (student) { return !existingIds[normalizeId_(student.id)]; });
  if (!missing.length) return { day: day, date: date, offDay: false };
  var sheet = sheet_('Attendance');
  if (day) {
    var lastBlockRow = day.startRow + day.rowCount - 1;
    if (lastBlockRow !== sheet.getLastRow()) {
      fail_('SCHEMA_NOT_READY', 'كتلة سجل اليوم غير متصلة بآخر الورقة. راجع المشرف قبل التسجيل.');
    }
  }
  var startRow = sheet.getLastRow() + 1;
  appendRows_('Attendance', missing.map(function (student) {
    return {
      date: date, id: student.id, name: student.name, classroom: student.classroom,
      status: 'pending', inAt: '', outAt: '', operator: '',
      inMethod: '', inJourney: '', outMethod: '', outJourney: ''
    };
  }));
  if (day) {
    day.rowCount = Number(day.rowCount) + missing.length;
    updateRow_('Days', day._row, day);
  } else {
    day = {
      date: date, closed: false, closedAt: '', operator: operator,
      startRow: startRow, rowCount: missing.length
    };
    appendRows_('Days', [day]);
    audit_({ account: { username: operator } }, 'فتح سجل اليوم', {
      targetType: 'day', targetId: date, details: 'عدد الطلاب: ' + missing.length
    });
  }
  return { day: day, date: date, offDay: false };
}

function readDayRows_(day) {
  if (!day) return [];
  if (!Number.isInteger(day.startRow) || day.startRow < 2 ||
      !Number.isInteger(day.rowCount) || day.rowCount < 1) {
    fail_('SCHEMA_NOT_READY', 'فهرس سجل اليوم غير صحيح. راجع المشرف.');
  }
  var values = sheet_('Attendance')
    .getRange(day.startRow, 1, day.rowCount, TABLES_.Attendance.length).getValues();
  var rows = values.map(function (row, index) {
    var record = objectFromRow_('Attendance', row, day.startRow + index);
    if (record.date !== day.date || !record.id) {
      fail_('SCHEMA_NOT_READY', 'صفوف اليوم لا تطابق فهرسه. لا تعدّل ورقة الحضور يدويًا.');
    }
    return record;
  });
  return rows;
}

function writeDayRecord_(record) {
  updateRow_('Attendance', record._row, record);
}

function daySummary_(records) {
  var summary = { total: records.length, present: 0, absent: 0, pending: 0, out: 0, notOut: 0 };
  records.forEach(function (record) {
    if (record.status === 'present') summary.present += 1;
    else if (record.status === 'absent') summary.absent += 1;
    else summary.pending += 1;
    if (record.outAt) summary.out += 1;
    if (record.inAt && !record.outAt) summary.notOut += 1;
  });
  summary.percentage = summary.total ? Math.round(summary.present / summary.total * 1000) / 10 : null;
  return summary;
}

function publicDay_(day) {
  if (!day) return null;
  return { date: day.date, closed: !!day.closed, closedAt: day.closedAt || '', operator: day.operator || '' };
}

function publicRecord_(record) {
  return {
    date: record.date,
    id: record.id,
    name: record.name,
    classroom: record.classroom,
    status: record.status,
    inAt: record.inAt || '',
    outAt: record.outAt || '',
    inMethod: record.inMethod || '',
    outMethod: record.outMethod || '',
    inJourney: record.inJourney || '',
    outJourney: record.outJourney || ''
  };
}

function getDay_(ctx, payload) {
  var date = payload && payload.date ? validateDate_(payload.date) : today_();
  var day = null;
  if (date === today_()) {
    var ensured = ensureDay_(ctx.account.username);
    if (ensured.offDay) {
      return { date: date, offDay: true, day: null, records: [], summary: daySummary_([]) };
    }
    day = ensured.day;
  } else {
    day = readTable_('Days').filter(function (item) { return item.date === date; })[0] || null;
  }
  var records = readDayRows_(day);
  return {
    date: date,
    offDay: false,
    day: publicDay_(day),
    records: records.map(publicRecord_),
    summary: daySummary_(records)
  };
}

function applyTransition_(record, mode, timestamp, closed) {
  if (mode !== 'in' && mode !== 'out') fail_('VALIDATION', 'نوع التسجيل غير صحيح.');
  var next = Object.assign({}, record);
  if (mode === 'in') {
    if (record.inAt) fail_('ALREADY_CHECKED_IN', ERROR_MESSAGES_.ALREADY_CHECKED_IN);
    if (closed) fail_('DAY_CLOSED', ERROR_MESSAGES_.DAY_CLOSED);
    next.inAt = timestamp;
    next.status = 'present';
  } else {
    if (!record.inAt) fail_('NOT_CHECKED_IN', ERROR_MESSAGES_.NOT_CHECKED_IN);
    if (record.outAt) fail_('ALREADY_CHECKED_OUT', ERROR_MESSAGES_.ALREADY_CHECKED_OUT);
    next.outAt = timestamp;
    if (next.status !== 'present') next.status = 'present';
  }
  return next;
}

function scanStudent_(ctx, payload) {
  var mode = payload.mode === 'out' ? 'out' : payload.mode === 'in' ? 'in' : null;
  if (!mode) fail_('VALIDATION', 'حدد نوع التسجيل: حضور أو انصراف.');
  var reason = cleanText_(payload.reason || '', 200);
  var resolved;
  try {
    resolved = resolveStudentInput_(payload.input);
  } catch (error) {
    if (error instanceof AppError && ['INVALID_QR', 'QR_REVOKED', 'WRONG_CARD_TYPE', 'OWNER_INACTIVE'].indexOf(error.code) >= 0) {
      auditSafe_(ctx, 'محاولة مسح بطاقة مرفوضة', { result: 'FAIL', reason: error.code, targetType: 'student' });
    }
    throw error;
  }
  if (resolved.method === 'manual' && !reason) {
    fail_('VALIDATION', 'سبب التسجيل اليدوي مطلوب.');
  }
  var ensured = ensureDay_(ctx.account.username);
  if (ensured.offDay) fail_('DAY_CLOSED', 'اليوم إجازة أو خارج أيام الدراسة.');
  if (!ensured.day) fail_('NOT_FOUND', 'أضف طالبًا نشطًا قبل بدء التسجيل.');
  var day = ensured.day;
  var records = readDayRows_(day);
  var index = -1;
  for (var i = 0; i < records.length; i++) {
    if (normalizeId_(records[i].id) === normalizeId_(resolved.student.id)) { index = i; break; }
  }
  if (index < 0) fail_('CONFLICT', 'الطالب غير مدرج في سجل اليوم. أعد تحميل الصفحة.');
  var before = records[index];
  var next = applyTransition_(before, mode, stamp_(), day.closed);
  next.operator = ctx.account.username;
  if (mode === 'in') {
    next.inMethod = resolved.method;
    next.inJourney = '';
  } else {
    next.outMethod = resolved.method;
    next.outJourney = '';
  }
  writeDayRecord_(next);
  if (resolved.card) touchCard_(resolved.card);
  var details = {
    targetType: 'student', targetId: resolved.student.id,
    details: (mode === 'in' ? 'حضور' : 'انصراف') + ' | ' + resolved.method,
    reason: reason,
    before: { inAt: before.inAt, outAt: before.outAt, status: before.status },
    after: { inAt: next.inAt, outAt: next.outAt, status: next.status }
  };
  audit_(ctx, mode === 'in' ? 'تسجيل حضور' : 'تسجيل انصراف', details);
  var all = readDayRows_(day);
  return {
    duplicate: false,
    mode: mode,
    method: resolved.method,
    student: { id: resolved.student.id, name: resolved.student.name, classroom: resolved.student.classroom },
    record: publicRecord_(next),
    day: publicDay_(day),
    summary: daySummary_(all)
  };
}

function closeDay_(ctx) {
  var date = today_();
  var day = readTable_('Days').filter(function (item) { return item.date === date; })[0];
  if (!day) fail_('DAY_NOT_OPEN', ERROR_MESSAGES_.DAY_NOT_OPEN);
  if (day.closed) {
    return { alreadyClosed: true, day: publicDay_(day), summary: daySummary_(readDayRows_(day)) };
  }
  var records = readDayRows_(day);
  var absent = 0;
  records.forEach(function (record) {
    if (!record.inAt) {
      record.status = 'absent';
      record.operator = ctx.account.username;
      absent += 1;
    }
  });
  writeRowsAt_('Attendance', day.startRow, records);
  day.closed = true;
  day.closedAt = stamp_();
  day.operator = ctx.account.username;
  updateRow_('Days', day._row, day);
  audit_(ctx, 'إنهاء حضور اليوم', {
    targetType: 'day', targetId: date,
    details: 'عدد الغائبين: ' + absent,
    before: { closed: false }, after: { closed: true, absent: absent }
  });
  return { alreadyClosed: false, day: publicDay_(day), summary: daySummary_(records), absent: absent };
}

function correctAttendance_(ctx, payload) {
  var date = validateDate_(payload.date);
  if (date > today_()) fail_('VALIDATION', 'لا يمكن تصحيح تاريخ مستقبلي.');
  var reason = cleanText_(payload.reason || '', 300);
  if (reason.length < 5) fail_('VALIDATION', 'سبب التصحيح مطلوب (5 أحرف على الأقل).');
  var day = readTable_('Days').filter(function (item) { return item.date === date; })[0];
  if (!day) fail_('NOT_FOUND', 'لا يوجد سجل لهذا اليوم.');
  var records = readDayRows_(day);
  var index = records.findIndex(function (record) { return normalizeId_(record.id) === normalizeId_(payload.studentId); });
  if (index < 0) fail_('NOT_FOUND', 'الطالب غير موجود في سجل اليوم.');
  var before = records[index];
  var next = Object.assign({}, before);
  var field = String(payload.field || '');
  if (field === 'in' || field === 'out') {
    validateTime_(payload.time);
    var value = date + 'T' + payload.time + ':00+03:00';
    if (field === 'in') {
      if (next.outAt && value > next.outAt) fail_('VALIDATION', 'وقت الحضور بعد وقت الانصراف.');
      next.inAt = value;
      next.status = 'present';
    } else {
      if (!next.inAt) fail_('NOT_CHECKED_IN', ERROR_MESSAGES_.NOT_CHECKED_IN);
      if (value < next.inAt) fail_('VALIDATION', 'وقت الانصراف قبل وقت الحضور.');
      next.outAt = value;
    }
  } else if (field === 'clearIn') {
    if (next.outAt) fail_('VALIDATION', 'امسح الانصراف أولًا قبل مسح الحضور.');
    next.inAt = '';
    next.inMethod = '';
    next.inJourney = '';
    next.status = day.closed ? 'absent' : 'pending';
  } else if (field === 'clearOut') {
    next.outAt = '';
    next.outMethod = '';
    next.outJourney = '';
  } else {
    fail_('VALIDATION', 'حقل التصحيح غير صحيح.');
  }
  next.operator = ctx.account.username;
  writeDayRecord_(next);
  audit_(ctx, 'تصحيح سجل حضور', {
    targetType: 'student', targetId: next.id, reason: reason,
    details: field + ' | ' + date,
    before: { inAt: before.inAt, outAt: before.outAt, status: before.status },
    after: { inAt: next.inAt, outAt: next.outAt, status: next.status }
  });
  var all = readDayRows_(day);
  return { record: publicRecord_(next), day: publicDay_(day), summary: daySummary_(all) };
}
