// 10_Reports.gs — تقارير من الأيام المغلقة فقط لنسب الحضور، مع إعادة حساب من السجلات الخام.
function timePart_(stamp) {
  return stamp && stamp.length >= 16 ? stamp.slice(11, 16) : '';
}

function getReport_(ctx, payload) {
  var from = validateDate_(payload.from);
  var to = validateDate_(payload.to);
  if (from > to) fail_('VALIDATION', 'بداية الفترة بعد نهايتها.');
  if (daysBetween_(from, to) > 366) fail_('VALIDATION', 'أقصى فترة تقرير سنة واحدة.');
  var type = String(payload.type || 'daily');
  var allowed = ['daily', 'monthly', 'student', 'class', 'method', 'absence', 'driver', 'trips'];
  if (allowed.indexOf(type) < 0) fail_('VALIDATION', 'نوع التقرير غير صحيح.');
  var settings = readSettings_();
  var days = readTable_('Days').filter(function (day) { return day.date >= from && day.date <= to; });
  var closed = {};
  days.forEach(function (day) { if (day.closed) closed[day.date] = true; });
  var records = [];
  if (days.length) {
    var start = Math.min.apply(null, days.map(function (day) { return Number(day.startRow); }));
    var end = Math.max.apply(null, days.map(function (day) { return Number(day.startRow) + Number(day.rowCount) - 1; }));
    if (!Number.isInteger(start) || start < 2 || !Number.isInteger(end) || end < start) {
      fail_('SCHEMA_NOT_READY', 'فهرس فترة التقرير غير صحيح.');
    }
    var dates = {};
    days.forEach(function (day) { dates[day.date] = true; });
    records = sheet_('Attendance').getRange(start, 1, end - start + 1, TABLES_.Attendance.length).getValues()
      .map(function (row) { return objectFromRow_('Attendance', row); })
      .filter(function (record) { return dates[record.date]; });
  }
  if (payload.classroom) records = records.filter(function (record) { return record.classroom === payload.classroom; });
  if (payload.studentId) {
    var studentId = normalizeId_(payload.studentId);
    records = records.filter(function (record) { return normalizeId_(record.id) === studentId; });
  }
  if (payload.method && METHODS_.indexOf(payload.method) < 0) fail_('VALIDATION', 'طريقة التسجيل غير صحيحة.');
  if (payload.method) {
    records = records.filter(function (record) {
      return record.inMethod === payload.method || record.outMethod === payload.method;
    });
  }
  if (payload.status && ['present', 'departed', 'absent'].indexOf(payload.status) < 0) {
    fail_('VALIDATION', 'حالة التصفية غير صحيحة.');
  }
  if (payload.status === 'present') records = records.filter(function (record) { return !!record.inAt; });
  if (payload.status === 'departed') records = records.filter(function (record) { return !!record.outAt; });
  if (payload.status === 'absent') records = records.filter(function (record) { return closed[record.date] && !record.inAt; });

  var closedRecords = records.filter(function (record) { return !!closed[record.date]; });
  var present = closedRecords.filter(function (record) { return !!record.inAt; }).length;
  var absent = closedRecords.length - present;
  var lateAfter = settings.lateAfter || '07:30';
  var late = closedRecords.filter(function (record) {
    return record.inAt && timePart_(record.inAt) > lateAfter;
  }).length;
  var summary = {
    days: days.length,
    closedDays: days.filter(function (day) { return day.closed; }).length,
    records: records.length,
    closedRecords: closedRecords.length,
    present: present,
    absent: absent,
    checkedOut: closedRecords.filter(function (record) { return !!record.outAt; }).length,
    late: late,
    percentage: closedRecords.length ? Math.round(present / closedRecords.length * 1000) / 10 : null
  };

  var rows = [];
  if (type === 'daily') {
    rows = records.map(function (record) {
      return {
        date: record.date, id: record.id, name: record.name, classroom: record.classroom,
        status: record.status, inAt: record.inAt || '', outAt: record.outAt || '',
        inMethod: record.inMethod || '', outMethod: record.outMethod || '',
        late: !!(record.inAt && timePart_(record.inAt) > lateAfter)
      };
    });
  } else if (type === 'monthly') {
    var byDay = {};
    records.forEach(function (record) {
      if (!byDay[record.date]) byDay[record.date] = { date: record.date, total: 0, present: 0, absent: 0, checkedOut: 0, late: 0 };
      var bucket = byDay[record.date];
      bucket.total += 1;
      if (record.inAt) {
        bucket.present += 1;
        if (timePart_(record.inAt) > lateAfter) bucket.late += 1;
      } else if (closed[record.date]) bucket.absent += 1;
      if (record.outAt) bucket.checkedOut += 1;
    });
    rows = Object.keys(byDay).sort().map(function (date) {
      var bucket = byDay[date];
      bucket.percentage = closed[date] && bucket.total ? Math.round(bucket.present / bucket.total * 1000) / 10 : null;
      bucket.closed = !!closed[date];
      return bucket;
    });
  } else if (type === 'student' || type === 'class') {
    var groups = {};
    closedRecords.forEach(function (record) {
      var key = type === 'student' ? normalizeId_(record.id) : record.classroom;
      if (!groups[key]) {
        groups[key] = {
          id: type === 'student' ? record.id : '', name: type === 'student' ? record.name : record.classroom,
          classroom: type === 'student' ? record.classroom : '', total: 0, present: 0, absent: 0, checkedOut: 0, late: 0
        };
      }
      var group = groups[key];
      group.total += 1;
      if (record.inAt) {
        group.present += 1;
        if (timePart_(record.inAt) > lateAfter) group.late += 1;
      } else group.absent += 1;
      if (record.outAt) group.checkedOut += 1;
    });
    rows = Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.percentage = group.total ? Math.round(group.present / group.total * 1000) / 10 : null;
      return group;
    }).sort(function (a, b) { return b.percentage - a.percentage || (a.name < b.name ? -1 : 1); });
  } else if (type === 'method') {
    var methods = {};
    records.forEach(function (record) {
      if (record.inMethod) {
        var inKey = 'in|' + record.inMethod;
        methods[inKey] = methods[inKey] || { direction: 'in', method: record.inMethod, count: 0 };
        methods[inKey].count += 1;
      }
      if (record.outMethod) {
        var outKey = 'out|' + record.outMethod;
        methods[outKey] = methods[outKey] || { direction: 'out', method: record.outMethod, count: 0 };
        methods[outKey].count += 1;
      }
    });
    rows = Object.keys(methods).map(function (key) { return methods[key]; });
  } else if (type === 'absence') {
    rows = closedRecords.filter(function (record) { return !record.inAt; }).map(function (record) {
      return { date: record.date, id: record.id, name: record.name, classroom: record.classroom, status: record.status };
    });
  } else {
    var trips = readTable_('Journeys').filter(function (trip) {
      return trip.date >= from && trip.date <= to && trip.status === TRIP_CONFIRMED_;
    });
    if (payload.driverCode) {
      var driverCode = normalizeId_(payload.driverCode);
      trips = trips.filter(function (trip) { return normalizeId_(trip.driverCode) === driverCode; });
    }
    rows = trips.map(function (trip) {
      var items = tripItems_(trip);
      var applied = items.filter(function (item) { return item.state === 'scanned' || item.state === 'guardian'; });
      return {
        tripId: trip.id, date: trip.date, driverCode: trip.driverCode, driverName: trip.driverName,
        mode: trip.mode, total: items.length, applied: applied.length, confirmedAt: trip.confirmedAt
      };
    }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }
  var rowsLimit = 20000;
  if (rows.length > rowsLimit) fail_('VALIDATION', 'الناتج كبير جدًا؛ ضيّق الفترة أو استخدم تصفية.');
  return {
    type: type, from: from, to: to, rows: rows, summary: summary,
    generatedAt: stamp_(), lateAfter: lateAfter
  };
}
