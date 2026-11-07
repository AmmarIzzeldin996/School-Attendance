// 09_Trips.gs — رحلة مسودة تُمسح فرديًا، تُراجع، ثم تُطبَّق مرة واحدة داخل القفل.
var TRIP_DRAFT_ = 'DRAFT', TRIP_CONFIRMED_ = 'CONFIRMED', TRIP_CANCELLED_ = 'CANCELLED';

function appendTrip_(trip) {
  var book = db_();
  var sheet = book.getSheetByName('Journeys');
  var metas = readTable_('JourneyDays');
  var meta = metas.filter(function (item) { return item.date === trip.date; })[0] || null;
  if (meta) {
    if (Number(meta.startRow) + Number(meta.rowCount) - 1 !== sheet.getLastRow()) {
      fail_('SCHEMA_NOT_READY', 'فهرس الرحلات غير متصل بآخر الورقة.');
    }
  }
  var startRow = sheet.getLastRow() + 1;
  appendRows_('Journeys', [trip]);
  if (meta) {
    meta.rowCount = Number(meta.rowCount) + 1;
    updateRow_('JourneyDays', meta._row, meta);
  } else {
    appendRows_('JourneyDays', [{ date: trip.date, startRow: startRow, rowCount: 1 }]);
  }
}

function findTrip_(tripId) {
  if (!tripId) return null;
  return readTable_('Journeys').filter(function (trip) { return trip.id === tripId; })[0] || null;
}

function tripItems_(trip) {
  var items = parseJson_(trip.items || '[]', []);
  return Array.isArray(items) ? items : [];
}

function publicTrip_(trip) {
  if (!trip) return null;
  var items = tripItems_(trip).map(function (item) {
    return {
      id: item.id, name: item.name, classroom: item.classroom,
      state: item.state, method: item.method || '', at: item.at || ''
    };
  });
  var done = items.filter(function (item) { return item.state === 'scanned' || item.state === 'guardian'; }).length;
  var absent = items.filter(function (item) { return item.state === 'absent'; }).length;
  return {
    id: trip.id, date: trip.date, driverCode: trip.driverCode, driverName: trip.driverName,
    area: trip.area, mode: trip.mode, status: trip.status, revision: Number(trip.revision || 0),
    at: trip.at, operator: trip.operator, items: items,
    counts: { total: items.length, done: done, absent: absent, pending: items.length - done - absent },
    confirmedAt: trip.confirmedAt || '', confirmedBy: trip.confirmedBy || ''
  };
}

function tripHistory_(trip, action, details, operator) {
  var history = parseJson_(trip.history || '[]', []);
  history.push({ at: stamp_(), operator: operator, action: action, details: details || '' });
  if (history.length > 40) history = history.slice(-40);
  return history;
}

function openTrip_(ctx, payload) {
  var mode = payload.mode;
  if (mode !== 'in' && mode !== 'out') fail_('VALIDATION', 'نوع الرحلة غير صحيح.');
  var resolved;
  try {
    resolved = resolveDriverInput_(payload.driver);
  } catch (error) {
    if (error instanceof AppError && ['INVALID_QR', 'QR_REVOKED', 'WRONG_CARD_TYPE'].indexOf(error.code) >= 0) {
      auditSafe_(ctx, 'محاولة مسح بطاقة سائق مرفوضة', { result: 'FAIL', reason: error.code, targetType: 'driver' });
    }
    throw error;
  }
  var driver = resolved.driver;
  var date = today_();
  var ensured = ensureDay_(ctx.account.username);
  if (ensured.offDay) fail_('DAY_CLOSED', 'اليوم إجازة أو خارج أيام الدراسة.');
  if (!ensured.day) fail_('NOT_FOUND', 'أضف طالبًا نشطًا أولًا.');
  var day = ensured.day;
  if (mode === 'in' && day.closed) fail_('DAY_CLOSED', 'تم إنهاء الحضور؛ لا يمكن فتح رحلة حضور.');
  var existing = readTable_('Journeys').filter(function (trip) {
    return trip.date === date && trip.driverCode === driver.code && trip.mode === mode && trip.status === TRIP_DRAFT_;
  })[0];
  if (existing) return { trip: publicTrip_(existing), resumed: true };
  var records = readDayRows_(day);
  var byId = {};
  records.forEach(function (record) { byId[normalizeId_(record.id)] = record; });
  var ids = driverStudentIds_(driver);
  var items = ids.map(function (id) {
    var record = byId[normalizeId_(id)];
    if (!record) return null;
    if (mode === 'out' && (!record.inAt || record.outAt)) return null;
    return { id: record.id, name: record.name, classroom: record.classroom, state: 'pending', method: '', at: '' };
  }).filter(Boolean);
  if (!items.length) {
    fail_('NOT_FOUND', mode === 'in' ? 'لا يوجد طلاب نشطون مرتبطون بهذا السائق.' : 'لا يوجد طلاب حاضرون بانتظار الانصراف لهذا السائق.');
  }
  var trip = {
    id: uuid_(), date: date, driverCode: driver.code, driverName: driver.name, area: driver.area,
    mode: mode, revision: 0, at: stamp_(), operator: ctx.account.username,
    items: JSON.stringify(items), history: JSON.stringify(tripHistory_({ history: '[]' }, 'فتح الرحلة', items.length + ' طالب', ctx.account.username)),
    requestId: ctx.requestId || '', lastRequestId: '', status: TRIP_DRAFT_,
    confirmedAt: '', confirmedBy: '', appliedAt: ''
  };
  appendTrip_(trip);
  if (resolved.card) touchCard_(resolved.card);
  audit_(ctx, 'فتح رحلة ' + (mode === 'in' ? 'حضور' : 'انصراف'), {
    targetType: 'trip', targetId: trip.id,
    details: driver.code + ' | ' + driver.name + ' | ' + items.length + ' طالب',
    after: { status: TRIP_DRAFT_, total: items.length }
  });
  return { trip: publicTrip_(trip), resumed: false };
}

function requireDraftTrip_(tripId) {
  var trip = findTrip_(tripId);
  if (!trip) fail_('NOT_FOUND', 'الرحلة غير موجودة.');
  return trip;
}

function assertDriverActive_(trip) {
  var driver = findDriverByCode_(readTable_('Drivers'), trip.driverCode);
  if (!driver || driver.deleted) fail_('DRIVER_NOT_FOUND', ERROR_MESSAGES_.DRIVER_NOT_FOUND);
  if (!driver.active) fail_('DRIVER_INACTIVE', ERROR_MESSAGES_.DRIVER_INACTIVE);
  return driver;
}

function scanTrip_(ctx, payload) {
  var trip = requireDraftTrip_(payload.tripId);
  if (trip.status !== TRIP_DRAFT_) fail_('CONFLICT', 'الرحلة ليست مسودة مفتوحة.');
  var driver = assertDriverActive_(trip);
  var choice = payload.choice === 'guardian' ? 'guardian' : 'scan';
  var reason = cleanText_(payload.reason || '', 200);
  var resolved;
  try {
    resolved = resolveStudentInput_(payload.input);
  } catch (error) {
    if (error instanceof AppError && ['INVALID_QR', 'QR_REVOKED', 'WRONG_CARD_TYPE'].indexOf(error.code) >= 0) {
      auditSafe_(ctx, 'محاولة مسح بطاقة مرفوضة', { result: 'FAIL', reason: error.code, targetType: 'trip', targetId: trip.id });
    }
    throw error;
  }
  if (resolved.method === 'manual' && !reason) fail_('VALIDATION', 'سبب الإدخال اليدوي مطلوب.');
  if (driverStudentIds_(driver).indexOf(normalizeId_(resolved.student.id)) < 0) {
    fail_('PERMISSION_DENIED', 'الطالب غير مرتبط بهذا السائق.');
  }
  var day = ensureDay_(ctx.account.username).day;
  if (!day) fail_('DAY_NOT_OPEN', ERROR_MESSAGES_.DAY_NOT_OPEN);
  if (trip.mode === 'in' && day.closed) fail_('DAY_CLOSED', ERROR_MESSAGES_.DAY_CLOSED);
  var record = readDayRows_(day).filter(function (row) {
    return normalizeId_(row.id) === normalizeId_(resolved.student.id);
  })[0];
  if (!record) fail_('CONFLICT', 'الطالب غير مدرج في سجل اليوم.');
  if (trip.mode === 'in' && record.inAt) fail_('ALREADY_CHECKED_IN', ERROR_MESSAGES_.ALREADY_CHECKED_IN);
  if (trip.mode === 'out') {
    if (!record.inAt) fail_('NOT_CHECKED_IN', ERROR_MESSAGES_.NOT_CHECKED_IN);
    if (record.outAt) fail_('ALREADY_CHECKED_OUT', ERROR_MESSAGES_.ALREADY_CHECKED_OUT);
  }
  var method = choice === 'guardian' ? 'guardian' : (resolved.method === 'manual' ? 'manual' : 'driver');
  var items = tripItems_(trip);
  var item = items.filter(function (entry) { return normalizeId_(entry.id) === normalizeId_(resolved.student.id); })[0];
  if (!item) fail_('PERMISSION_DENIED', 'الطالب ليس ضمن طلاب الرحلة.');
  if (item.state !== 'pending') return { trip: publicTrip_(trip), duplicate: true };
  item.state = method === 'guardian' ? 'guardian' : 'scanned';
  item.method = method;
  item.at = stamp_();
  trip.items = JSON.stringify(items);
  trip.revision = Number(trip.revision || 0) + 1;
  trip.lastRequestId = ctx.requestId || '';
  trip.history = JSON.stringify(tripHistory_(trip, 'تسجيل طالب', item.name + ' | ' + method, ctx.account.username));
  updateRow_('Journeys', trip._row, trip);
  if (resolved.card) touchCard_(resolved.card);
  return { trip: publicTrip_(trip) };
}

function unscanTrip_(ctx, payload) {
  var trip = requireDraftTrip_(payload.tripId);
  if (trip.status !== TRIP_DRAFT_) fail_('CONFLICT', 'الرحلة ليست مسودة مفتوحة.');
  var items = tripItems_(trip);
  var item = items.filter(function (entry) { return normalizeId_(entry.id) === normalizeId_(payload.studentId); })[0];
  if (!item) fail_('NOT_FOUND', 'الطالب ليس ضمن الرحلة.');
  item.state = 'pending';
  item.method = '';
  item.at = '';
  trip.items = JSON.stringify(items);
  trip.revision = Number(trip.revision || 0) + 1;
  trip.lastRequestId = ctx.requestId || '';
  trip.history = JSON.stringify(tripHistory_(trip, 'تراجع عن طالب', item.name, ctx.account.username));
  updateRow_('Journeys', trip._row, trip);
  return { trip: publicTrip_(trip) };
}

function confirmTrip_(ctx, payload) {
  var trip = requireDraftTrip_(payload.tripId);
  if (trip.status === TRIP_CONFIRMED_) return { alreadyConfirmed: true, trip: publicTrip_(trip) };
  if (trip.status !== TRIP_DRAFT_) fail_('CONFLICT', 'الرحلة ملغاة ولا يمكن تأكيدها.');
  var driver = assertDriverActive_(trip);
  var date = trip.date;
  if (date !== today_()) fail_('CONFLICT', 'لا يمكن تأكيد رحلة من يوم سابق.');
  var day = readTable_('Days').filter(function (item) { return item.date === date; })[0];
  if (!day) fail_('DAY_NOT_OPEN', ERROR_MESSAGES_.DAY_NOT_OPEN);
  var records = readDayRows_(day);
  var byId = {};
  records.forEach(function (record) { byId[normalizeId_(record.id)] = record; });
  var items = tripItems_(trip);
  var apply = items.filter(function (item) { return item.state === 'scanned' || item.state === 'guardian'; });
  if (!apply.length) fail_('VALIDATION', 'لم تسجل أي طالب في الرحلة.');
  var now = stamp_();
  var alreadyApplied = 0;
  var conflicts = [];
  apply.forEach(function (item) {
    var record = byId[normalizeId_(item.id)];
    if (!record) { conflicts.push(item.name + ': غير موجود في سجل اليوم'); return; }
    if (trip.mode === 'in') {
      if (record.inAt && record.inJourney !== trip.id) conflicts.push(item.name + ': سبق تسجيل حضوره');
      else if (record.inAt && record.inJourney === trip.id) alreadyApplied += 1;
      else if (day.closed) conflicts.push(item.name + ': اليوم مغلق');
    } else {
      if (!record.inAt) conflicts.push(item.name + ': لم يسجل حضوره');
      else if (record.outAt && record.outJourney !== trip.id) conflicts.push(item.name + ': سبق تسجيل انصرافه');
      else if (record.outAt && record.outJourney === trip.id) alreadyApplied += 1;
    }
  });
  if (conflicts.length) fail_('CONFLICT', 'تعارض في حالة بعض الطلاب: ' + conflicts.slice(0, 4).join('؛ '));

  var applied = 0;
  apply.forEach(function (item) {
    var record = byId[normalizeId_(item.id)];
    var isApplied = trip.mode === 'in'
      ? (record.inAt && record.inJourney === trip.id)
      : (record.outAt && record.outJourney === trip.id);
    if (isApplied) return;
    if (trip.mode === 'in') {
      record.inAt = now;
      record.inMethod = item.method;
      record.inJourney = trip.id;
      record.status = 'present';
    } else {
      record.outAt = now;
      record.outMethod = item.method;
      record.outJourney = trip.id;
    }
    record.operator = ctx.account.username;
    applied += 1;
  });
  if (applied) writeRowsAt_('Attendance', day.startRow, records);

  var existingDetails = readTable_('TripDetails').filter(function (detail) { return detail.trip_id === trip.id; });
  if (!existingDetails.length) {
    appendRows_('TripDetails', apply.map(function (item) {
      return { trip_id: trip.id, student_id: item.id, method: item.method, applied_at: now, request_id: ctx.requestId || '' };
    }));
  }
  trip.status = TRIP_CONFIRMED_;
  trip.confirmedAt = now;
  trip.confirmedBy = ctx.account.username;
  trip.appliedAt = now;
  trip.lastRequestId = ctx.requestId || '';
  trip.revision = Number(trip.revision || 0) + 1;
  trip.history = JSON.stringify(tripHistory_(trip, 'تأكيد الرحلة', applied + ' طالب', ctx.account.username));
  updateRow_('Journeys', trip._row, trip);
  if (driver && trip.mode === 'in') {
    audit_(ctx, 'تأكيد رحلة حضور', {
      targetType: 'trip', targetId: trip.id,
      details: driver.code + ' | ' + driver.name + ' | تم تطبيق ' + applied + ' من ' + apply.length,
      before: { status: TRIP_DRAFT_, applied: 0 },
      after: { status: TRIP_CONFIRMED_, applied: applied }
    });
  } else {
    audit_(ctx, 'تأكيد رحلة انصراف', {
      targetType: 'trip', targetId: trip.id,
      details: driver.code + ' | ' + driver.name + ' | تم تطبيق ' + applied + ' من ' + apply.length,
      before: { status: TRIP_DRAFT_, applied: 0 },
      after: { status: TRIP_CONFIRMED_, applied: applied }
    });
  }
  return {
    alreadyConfirmed: false, applied: applied, alreadyApplied: alreadyApplied,
    trip: publicTrip_(trip), summary: daySummary_(readDayRows_(day))
  };
}

function cancelTrip_(ctx, payload) {
  var trip = requireDraftTrip_(payload.tripId);
  if (trip.status === TRIP_CANCELLED_) return { alreadyCancelled: true };
  if (trip.status === TRIP_CONFIRMED_) fail_('CONFLICT', 'لا يمكن إلغاء رحلة مؤكدة.');
  trip.status = TRIP_CANCELLED_;
  trip.revision = Number(trip.revision || 0) + 1;
  trip.lastRequestId = ctx.requestId || '';
  trip.history = JSON.stringify(tripHistory_(trip, 'إلغاء الرحلة', cleanText_(payload.reason || '', 200), ctx.account.username));
  updateRow_('Journeys', trip._row, trip);
  audit_(ctx, 'إلغاء رحلة', {
    targetType: 'trip', targetId: trip.id, reason: cleanText_(payload.reason || '', 200),
    before: { status: TRIP_DRAFT_ }, after: { status: TRIP_CANCELLED_ }
  });
  return { cancelled: true };
}

function getTrips_(ctx, payload) {
  var date = payload && payload.date ? validateDate_(payload.date) : today_();
  var days = readTable_('JourneyDays');
  var meta = days.filter(function (item) { return item.date === date; })[0];
  if (!meta) return [];
  var start = Number(meta.startRow), count = Number(meta.rowCount);
  if (!Number.isInteger(start) || start < 2 || !Number.isInteger(count) || count < 1) {
    fail_('SCHEMA_NOT_READY', 'فهرس الرحلات غير صحيح.');
  }
  var values = sheet_('Journeys').getRange(start, 1, count, TABLES_.Journeys.length).getValues();
  return values.map(function (row) { return objectFromRow_('Journeys', row); })
    .filter(function (trip) { return trip.date === date; })
    .map(publicTrip_).reverse();
}

function getTrip_(ctx, payload) {
  var trip = findTrip_(payload.tripId);
  if (!trip) fail_('NOT_FOUND', 'الرحلة غير موجودة.');
  return { trip: publicTrip_(trip) };
}
