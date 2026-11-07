// 06_Cards.gs — دورة حياة البطاقات ومحرك تحويل المدخلات إلى هوية موثوقة من الخادم.
function findCardByToken_(cards, raw) {
  var hash = tokenHash_(raw);
  for (var i = 0; i < cards.length; i++) {
    if (String(cards[i].token_hash) === hash) return cards[i];
  }
  return null;
}

function assertCardUsable_(card, expectedType) {
  if (!card) fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
  if (card.status !== 'ACTIVE') fail_('QR_REVOKED', ERROR_MESSAGES_.QR_REVOKED);
  if (expectedType && card.type !== expectedType) fail_('WRONG_CARD_TYPE', ERROR_MESSAGES_.WRONG_CARD_TYPE);
}

function touchCard_(card) {
  if (!card || !card._row) return;
  var updated = Object.assign({}, card, { last_used_at: stamp_() });
  updateRow_('Cards', card._row, updated);
  card.last_used_at = updated.last_used_at;
}

// يُلغي كل بطاقات صاحب نشطة من نوع محدد، ويستخدم عند الإصدار البديل أو إيقاف الحساب/السائق.
function revokeOwnerCards_(type, ownerId, operator, note) {
  var count = 0;
  readTable_('Cards').forEach(function (card) {
    if (card.type !== type || String(card.owner_id) !== String(ownerId) || card.status !== 'ACTIVE') return;
    updateRow_('Cards', card._row, Object.assign({}, card, {
      status: 'REVOKED', revoked_at: stamp_(), revoked_by: operator,
      note: cleanText_(note || card.note || '', 120)
    }));
    count += 1;
  });
  return count;
}

function findStudentById_(students, id) {
  var target = normalizeId_(id);
  return students.filter(function (student) { return normalizeId_(student.id) === target; })[0] || null;
}

function findDriverByCode_(drivers, code) {
  var target = normalizeId_(code);
  return drivers.filter(function (driver) { return normalizeId_(driver.code) === target; })[0] || null;
}

// الإدخال: رمز بطاقة غامض، أو رقم طالب يدوي (يتطلب سببًا وسجل تدقيق).
function resolveStudentInput_(rawInput) {
  var raw = normalizeBarcode_(rawInput);
  if (!raw) fail_('VALIDATION', 'أدخل رقم الطالب أو امسح بطاقة QR.');
  var card = isCardToken_(raw) ? findCardByToken_(readTable_('Cards'), raw) : null;
  if (card) {
    assertCardUsable_(card, 'STUDENT');
    var students = readTable_('Students');
    var student = findStudentById_(students, card.owner_id);
    if (!student) fail_('STUDENT_NOT_FOUND', ERROR_MESSAGES_.STUDENT_NOT_FOUND);
    if (!student.active) fail_('OWNER_INACTIVE', ERROR_MESSAGES_.OWNER_INACTIVE);
    return { student: student, method: 'qr', card: card };
  }
  var manualId = normalizeId_(raw);
  if (!/^[0-9A-Za-z_-]{1,30}$/.test(manualId)) fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
  var manualStudent = findStudentById_(readTable_('Students'), manualId);
  if (!manualStudent) {
    if (isCardToken_(raw)) fail_('INVALID_QR', ERROR_MESSAGES_.INVALID_QR);
    fail_('STUDENT_NOT_FOUND', ERROR_MESSAGES_.STUDENT_NOT_FOUND);
  }
  if (!manualStudent.active) fail_('OWNER_INACTIVE', ERROR_MESSAGES_.OWNER_INACTIVE);
  return { student: manualStudent, method: 'manual', card: null };
}

function resolveDriverInput_(rawInput) {
  var raw = normalizeBarcode_(rawInput);
  if (!raw) fail_('VALIDATION', 'امسح بطاقة السائق أو أدخل رقمه.');
  var drivers = readTable_('Drivers');
  var card = isCardToken_(raw) ? findCardByToken_(readTable_('Cards'), raw) : null;
  if (card) {
    assertCardUsable_(card, 'DRIVER');
    var driver = findDriverByCode_(drivers, card.owner_id);
    if (!driver || driver.deleted) fail_('DRIVER_NOT_FOUND', ERROR_MESSAGES_.DRIVER_NOT_FOUND);
    if (!driver.active) fail_('DRIVER_INACTIVE', ERROR_MESSAGES_.DRIVER_INACTIVE);
    return { driver: driver, method: 'card', card: card };
  }
  var code = normalizeId_(raw.replace(/^DRV\s*[:\-]\s*/i, ''));
  if (!/^9[0-9]{3}$/.test(code)) fail_('VALIDATION', 'رقم السائق 4 أرقام يبدأ بالرقم 9.');
  var manualDriver = findDriverByCode_(drivers, code);
  if (!manualDriver || manualDriver.deleted) fail_('DRIVER_NOT_FOUND', ERROR_MESSAGES_.DRIVER_NOT_FOUND);
  if (!manualDriver.active) fail_('DRIVER_INACTIVE', ERROR_MESSAGES_.DRIVER_INACTIVE);
  return { driver: manualDriver, method: 'manual', card: null };
}

function ownerName_(type, ownerId, students, drivers) {
  if (type === 'STUDENT') {
    var student = findStudentById_(students || readTable_('Students'), ownerId);
    return student ? student.name + ' — ' + student.classroom : '';
  }
  if (type === 'DRIVER') {
    var driver = findDriverByCode_(drivers || readTable_('Drivers'), ownerId);
    return driver ? driver.name : '';
  }
  if (type === 'USER') {
    var account = accountById_(ownerId);
    return account ? account.name : '';
  }
  return '';
}

function issueCard_(ctx, payload) {
  var type = String(payload.type || '').toUpperCase();
  var ownerId = cleanText_(payload.ownerId, 80);
  if (CARD_TYPES_.indexOf(type) < 0 || !ownerId) fail_('VALIDATION', 'نوع البطاقة أو صاحبها غير صحيح.');
  var permissions = permissionsFor_(ctx.account);
  if (type === 'DRIVER' && permissions.indexOf('drivers.manage') < 0) {
    fail_('PERMISSION_DENIED', 'إصدار بطاقة سائق يتطلب صلاحية إدارة السائقين.');
  }
  if (type === 'USER' && permissions.indexOf('users') < 0) {
    fail_('PERMISSION_DENIED', 'إصدار بطاقة مستخدم متاح للمشرف الأصلي فقط.');
  }
  var students = type === 'STUDENT' ? readTable_('Students') : [];
  var drivers = type === 'DRIVER' ? readTable_('Drivers') : [];
  if (type === 'STUDENT' && !findStudentById_(students, ownerId)) fail_('STUDENT_NOT_FOUND', ERROR_MESSAGES_.STUDENT_NOT_FOUND);
  if (type === 'DRIVER' && (!findDriverByCode_(drivers, ownerId) || findDriverByCode_(drivers, ownerId).deleted)) fail_('DRIVER_NOT_FOUND', ERROR_MESSAGES_.DRIVER_NOT_FOUND);
  if (type === 'USER' && !accountById_(ownerId)) fail_('NOT_FOUND', 'الحساب غير موجود.');

  var cards = readTable_('Cards');
  var revoked = revokeOwnerCards_(type, ownerId, ctx.account.username, 'أُلغيت عند إصدار بديل');

  var raw = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    var candidate = randomToken_();
    if (!findCardByToken_(cards, candidate)) { raw = candidate; break; }
  }
  if (!raw) fail_('INTERNAL', 'تعذر توليد رمز بطاقة فريد.');
  var record = {
    card_id: uuid_(),
    type: type,
    owner_id: ownerId,
    token_hash: tokenHash_(raw),
    status: 'ACTIVE',
    issued_at: stamp_(),
    issued_by: ctx.account.username,
    revoked_at: '',
    revoked_by: '',
    last_used_at: '',
    note: cleanText_(payload.note || '', 120)
  };
  appendRows_('Cards', [record]);
  audit_(ctx, 'إصدار بطاقة', {
    targetType: 'card', targetId: record.card_id,
    details: type + ' | ' + ownerId,
    before: revoked ? { revoked: revoked } : null,
    after: { card: record.card_id, type: type, owner: ownerId }
  });
  return {
    card: {
      cardId: record.card_id, type: type, ownerId: ownerId, issuedAt: record.issued_at,
      ownerName: ownerName_(type, ownerId, students, drivers)
    },
    token: raw,
    revoked: revoked
  };
}

function revokeCard_(ctx, payload) {
  var cardId = cleanText_(payload.cardId, 80);
  var card = readTable_('Cards').filter(function (item) { return item.card_id === cardId; })[0];
  if (!card) fail_('NOT_FOUND', 'البطاقة غير موجودة.');
  if (card.type === 'USER' && permissionsFor_(ctx.account).indexOf('users') < 0) {
    fail_('PERMISSION_DENIED', 'إلغاء بطاقة مستخدم متاح للمشرف الأصلي فقط.');
  }
  if (card.status !== 'ACTIVE') return { cardId: cardId, alreadyRevoked: true };
  updateRow_('Cards', card._row, Object.assign({}, card, {
    status: 'REVOKED', revoked_at: stamp_(), revoked_by: ctx.account.username,
    note: cleanText_(payload.reason || card.note, 120)
  }));
  audit_(ctx, 'إلغاء بطاقة', {
    targetType: 'card', targetId: cardId, reason: cleanText_(payload.reason || '', 200),
    before: { status: 'ACTIVE' }, after: { status: 'REVOKED' }
  });
  return { cardId: cardId, revoked: true };
}

function getCards_(ctx) {
  var permissions = permissionsFor_(ctx.account);
  var students = readTable_('Students');
  var drivers = readTable_('Drivers');
  return readTable_('Cards').filter(function (card) {
    return card.type !== 'USER' || permissions.indexOf('users') >= 0;
  }).map(function (card) {
    return {
      cardId: card.card_id,
      type: card.type,
      ownerId: card.owner_id,
      ownerName: ownerName_(card.type, card.owner_id, students, drivers) || '—',
      status: card.status,
      issuedAt: card.issued_at,
      issuedBy: card.issued_by,
      revokedAt: card.revoked_at,
      lastUsedAt: card.last_used_at
    };
  }).sort(function (a, b) { return a.issuedAt < b.issuedAt ? 1 : -1; });
}
