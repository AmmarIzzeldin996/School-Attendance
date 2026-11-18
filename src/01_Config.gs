// 01_Config.gs — ثوابت النظام وخريطة الصلاحيات. لا منطق أعمال هنا.
var APP_VERSION_ = '3.6.2';
var TIMEZONE_ = 'Asia/Riyadh';
var SESSION_IDLE_MS_ = 30 * 60 * 1000;
var SESSION_ABSOLUTE_MS_ = 8 * 60 * 60 * 1000;
var IDEMPOTENCY_TTL_ = 900;
var LOCK_WAIT_MS_ = 15000;
var MAX_LOGIN_FAILURES_ = 5;
var LOGIN_WINDOW_SECONDS_ = 900;
var MAX_PAYLOAD_CHARS_ = 200000;

// ترتيب الأعمدة القديم محفوظ حرفيًا، والأعمدة الجديدة تُضاف في النهاية فقط.
var TABLES_ = {
  Students: ['id', 'name', 'classroom', 'phone', 'active', 'token'],
  Attendance: ['date', 'id', 'name', 'classroom', 'status', 'inAt', 'outAt', 'operator', 'inMethod', 'inJourney', 'outMethod', 'outJourney'],
  Days: ['date', 'closed', 'closedAt', 'operator', 'startRow', 'rowCount'],
  Audit: ['at', 'operator', 'action', 'details', 'event_id', 'request_id', 'target_type', 'target_id', 'result', 'reason', 'before_json', 'after_json'],
  Drivers: ['code', 'name', 'area', 'phone', 'identity', 'studentIds', 'active', 'updatedAt', 'deleted', 'deletedReason'],
  Journeys: ['id', 'date', 'driverCode', 'driverName', 'area', 'mode', 'revision', 'at', 'operator', 'items', 'history', 'requestId', 'lastRequestId', 'status', 'confirmedAt', 'confirmedBy', 'appliedAt'],
  JourneyDays: ['date', 'startRow', 'rowCount'],
  Cards: ['card_id', 'type', 'owner_id', 'token_hash', 'status', 'issued_at', 'issued_by', 'revoked_at', 'revoked_by', 'last_used_at', 'note'],
  TripDetails: ['trip_id', 'student_id', 'method', 'applied_at', 'request_id']
};

var CARD_TYPES_ = ['STUDENT', 'DRIVER', 'USER'];
var CARD_STATUS_ = ['ACTIVE', 'REVOKED'];
var ATTENDANCE_STATUS_ = ['pending', 'present', 'absent'];
var METHODS_ = ['qr', 'manual', 'driver', 'guardian'];

var ROLE_PERMISSIONS_ = {
  admin: ['drivers.manage', 'journeys', 'journeys.read', 'journeys.correct', 'dashboard', 'scan', 'closeDay',
    'students.read', 'students.write', 'cards', 'reports', 'settings', 'users', 'backups', 'restore', 'audit'],
  gate: ['journeys', 'journeys.read', 'dashboard', 'scan'],
  registrar: ['students.read', 'students.write', 'cards'],
  viewer: ['dashboard', 'reports', 'journeys.read']
};
var ROLE_LABELS_ = { admin: 'مدير النظام', gate: 'المعلم المناوب', registrar: 'مسؤول الطلاب', viewer: 'مدير المدرسة' };

// كل إجراء يُعلن هنا فقط. لا تُصدَّر أي دالة أعمال أخرى إلى google.script.run.
var ACTION_POLICY_ = {
  ping: { public: true, lock: false },
  publicConfig: { public: true, lock: false },
  login: { public: true, lock: true },
  loginCard: { public: true, lock: true },
  loginGoogle: { public: true, lock: true },
  bootstrap: { public: false, lock: false, allowForcedPasswordChange: true },
  logout: { public: false, lock: true, allowForcedPasswordChange: true },
  changePassword: { public: false, lock: true, allowForcedPasswordChange: true },
  getDay: { public: false, lock: true, permission: 'dashboard' },
  scanStudent: { public: false, lock: true, permission: 'scan', idempotent: true },
  closeDay: { public: false, lock: true, permission: 'closeDay', idempotent: true },
  correctAttendance: { public: false, lock: true, permission: 'journeys.correct', idempotent: true },
  getStudents: { public: false, lock: false, permission: 'students.read' },
  saveStudent: { public: false, lock: true, permission: 'students.write' },
  importStudents: { public: false, lock: true, permission: 'students.write' },
  getDriverAdminData: { public: false, lock: false, permission: 'drivers.manage' },
  saveDriver: { public: false, lock: true, permission: 'drivers.manage' },
  deleteDriver: { public: false, lock: true, permission: 'drivers.manage' },
  issueCard: { public: false, lock: true, permission: 'cards' },
  revokeCard: { public: false, lock: true, permission: 'cards' },
  getCards: { public: false, lock: false, permission: 'cards' },
  openTrip: { public: false, lock: true, permission: 'journeys', idempotent: true },
  addTripStudent: { public: false, lock: true, permission: 'journeys', idempotent: true },
  scanTrip: { public: false, lock: true, permission: 'journeys', idempotent: true },
  unscanTrip: { public: false, lock: true, permission: 'journeys', idempotent: true },
  confirmTrip: { public: false, lock: true, permission: 'journeys', idempotent: true },
  cancelTrip: { public: false, lock: true, permission: 'journeys', idempotent: true },
  getTrips: { public: false, lock: false, permission: 'journeys.read' },
  getTrip: { public: false, lock: false, permission: 'journeys.read' },
  getReport: { public: false, lock: false, permission: 'reports' },
  getSettings: { public: false, lock: false, permission: 'settings' },
  saveSettings: { public: false, lock: true, permission: 'settings' },
  getDatabaseStatus: { public: false, lock: false, permission: 'settings' },
  getUsers: { public: false, lock: false, permission: 'users' },
  saveUser: { public: false, lock: true, permission: 'users' },
  getAudit: { public: false, lock: false, permission: 'audit' },
  createBackup: { public: false, lock: true, permission: 'backups' },
  getBackupStatus: { public: false, lock: false, permission: 'backups' },
  previewRestore: { public: false, lock: false, permission: 'restore' },
  restoreBackup: { public: false, lock: true, permission: 'restore' },
  runRetention: { public: false, lock: true, permission: 'backups' }
};

var ERROR_MESSAGES_ = {
  BAD_REQUEST: 'الطلب غير صحيح.',
  UNKNOWN_ACTION: 'العملية غير متاحة.',
  PAYLOAD_TOO_LARGE: 'حجم البيانات المرسلة كبير.',
  SESSION_EXPIRED: 'انتهت الجلسة. سجّل الدخول من جديد.',
  PERMISSION_DENIED: 'ليس لديك صلاحية لتنفيذ هذه العملية.',
  PASSWORD_CHANGE_REQUIRED: 'غيّر كلمة المرور المؤقتة قبل استخدام النظام.',
  INVALID_CREDENTIALS: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  USER_INACTIVE: 'الحساب موقوف. راجع مدير النظام.',
  TOO_MANY_ATTEMPTS: 'محاولات كثيرة. انتظر 15 دقيقة ثم أعد المحاولة.',
  INVALID_QR: 'البطاقة غير معروفة أو غير صالحة.',
  QR_REVOKED: 'البطاقة ملغاة. أصدر بطاقة بديلة.',
  WRONG_CARD_TYPE: 'نوع البطاقة لا يطابق العملية.',
  OWNER_INACTIVE: 'صاحب البطاقة غير نشط.',
  STUDENT_NOT_FOUND: 'الطالب غير موجود.',
  DRIVER_NOT_FOUND: 'السائق غير موجود.',
  DRIVER_INACTIVE: 'السائق غير نشط.',
  NOT_CHECKED_IN: 'لا يمكن تسجيل الانصراف قبل الحضور.',
  ALREADY_CHECKED_IN: 'سبق تسجيل وصول الطالب اليوم.',
  ALREADY_CHECKED_OUT: 'سبق تسجيل انصراف الطالب اليوم.',
  DAY_CLOSED: 'تم إنهاء حضور اليوم.',
  DAY_NOT_OPEN: 'لا يوجد سجل لهذا اليوم.',
  BUSY: 'النظام مشغول بعملية أخرى. أعد المحاولة.',
  SCHEMA_NOT_READY: 'بنية قاعدة البيانات تحتاج ترحيلًا. شغّل migrateV36 من المحرر.',
  NOT_FOUND: 'العنصر المطلوب غير موجود.',
  CONFLICT: 'تعارض في حالة السجل. أعد تحميل الصفحة.',
  VALIDATION: 'بيانات غير صحيحة.',
  INTERNAL: 'تعذر تنفيذ العملية. راجع سجل النظام.',
  NETWORK: 'تعذر الاتصال بالخادم.'
};
