# PROJECT_MAP — نظام الحضور والانصراف المدرسي (v3.6)

> **الحالة:** **IMPLEMENTED & VERIFIED (محليًا)** — نظام Apps Script + تطبيق Windows سطح مكتب، والتحقق الآلي كامل.
> **الإصدار:** `3.6.2` • **وقت التشغيل:** Google Apps Script V8 + Electron 45 (Windows x64) • **قاعدة البيانات:** Google Sheets + مخزن محلي.
> **تاريخ الأساس:** 2026-11-07 (Asia/Riyadh، UTC+03:00).
> **مصدر المتطلبات:** وثيقة نظام الحضور والانصراف 3.6 (المرجع 3.5) + متطلبات سطح المكتب والمزامنة.
> **آخر تحقق:** `npm run verify` = OK • `npm test` = 149/149 ناجح (81 GAS + 68 سطح مكتب).

---

## [TECH_STACK]

| المكوّن | الاختيار | ملاحظة |
|---|---|---|
| Runtime | Apps Script V8 | لا Node APIs وقت التشغيل |
| الواجهة | `HtmlService` + `IFRAME` | RTL، بلا CDN، بلا `innerHTML` |
| البيانات | Google Sheets واحد | `SpreadsheetApp.openById` فقط |
| الأسرار | Script Properties | `AUTH_SECRET`، الجلسات، الحسابات |
| الملفات | DriveApp | نسخ `attendance-*.json` |
| الكاميرا/الصور | `jsqr 1.4.0` | QR فقط؛ مُجمّع محليًا في `ui_Vendor.html` (≈‎149 ك.ب بدل 507) |
| QR | `qrcode-generator 2.0.4` | `createDataURL` فقط |
| كلمات المرور | `bcryptjs 2.4.3` داخل `00_PasswordCrypto.gs` | تكلفة 12، ملح من HMAC |
| الاختبارات | `vitest 5.1.0` + محاكي GAS | 81 اختبارًا للنظام الأساسي + 68 لسطح المكتب |
| البناء | `esbuild 0.28.2` | `npm run vendor` |
| النشر | `clasp 3.x` | `.clasp.json` مستبعد من Git |
| تطبيق سطح المكتب | Electron 45.2.3 + خادم HTTP محلي | يعيد استخدام منطق `.gs` داخل VM مع طبقة خدمات |
| التخزين المحلي | `workbook.json` + كتابة ذرية | العمل دون إنترنت إلزامي |
| المزامنة | HLC + سجل عمليات إلحاقي + HTTP بين الأقران | اكتشاف UDP على شبكة المدرسة |
| النسخ السحابي | Google Sheets API + Drive API | حساب خدمة + تبويبات مقروءة وأرشيف JSON |
| تشفير الأسرار | Electron `safeStorage` (DPAPI) + AES-GCM | مفتاح محلي عند غياب DPAPI |
| حزم Windows | electron-builder 26.18.0 | NSIS + Portable x64 |

---

## [SYSTEM_FLOW]

### 1) مسار الطلب الموحّد

```
Browser → google.script.run.api(request)
  ├─ action whitelist من ACTION_POLICY_
  ├─ payload كائن + حد 200,000 حرف
  ├─ session: SHA-256(token) → Script Properties → حساب حي + version
  ├─ permission من الدور (خادم فقط)
  ├─ idempotent؟ requestId (8–64) + CacheService 15 دقيقة
  ├─ lock للإجراءات الكاتبة (15 ثانية انتظار)
  ├─ تنفيذ + تدقيق داخل نفس القفل
  └─ { success, code, message, data, timestamp, requestId }
```

- أي استجابة فاشلة: `data = null`.
- الجلسة: خمول 30 دقيقة، حد أقصى 8 ساعات، إبطال عند تغيير كلمة المرور/الدور/التعطيل.
- الإجراءات العامة فقط: `ping`, `publicConfig`, `login`, `loginCard`, `loginGoogle`.

### 2) حضور اليوم

```
getDay(date) → كتلة اليوم من Attendance + ملخص
scanStudent(mode,input,reason)
  ├─ input = بطاقة QR 3.6 → STUDENT Card نشطة
  ├─ أو بطاقة 3.5 المطبوعة (STU-1001) → مطابقة رقم الطالب بلا سبب
  ├─ أو رقم طالب يدوي → reason مطلوب + تدقيق
  ├─ in: يمنع التسجيل المزدوج؛ out: يتطلب حضورًا مسبقًا
  └─ يحدّث صف اليوم فقط، لا يُنشئ صفًا جديدًا
closeDay() → present + absent مرة واحدة، اليوم يصبح immutable
```

### 3) دورة الرحلة

```
openTrip(driver, mode)
  ├─ driver = بطاقة سائق نشطة أو رقم 9xxx يدوي
  ├─ المناوب (gate) يفتح بالبطاقة/الرقم لأنه لا يملك drivers.manage
  └─ DRAFT → resume إن وُجدت مسودة مطابقة (نفس اليوم/السائق/النوع)

addTripStudent(tripId, input, reason)
  ├─ للطالب غير المرتبط بالسائق: سبب مطلوب ويدخل التدقيق
  └─ يُضاف pending فقط؛ تسجيله يبقى عبر scanTrip

scanTrip(tripId, input, choice, reason)
  ├─ choice = scan | guardian
  ├─ يتحقق: السائق نشط، الطالب مرتبط به أو مضاف صراحة، حالة اليوم مناسبة
  └─ pending → scanned | guardian (أو duplicate)

unscanTrip(tripId, studentId) → pending

confirmTrip(tripId)
  ├─ DRAFT → CONFIRMED داخل القفل
  ├─ يطبّق scanned/guardian فقط، ويكتب TripDetails مرة واحدة
  ├─ يتعارض بوضوح إن سبق التسجيل من رحلة أخرى
  └─ idempotent: إعادة الطلب لا تكرر التطبيق

cancelTrip(tripId) → CANCELLED (لا يمس الحضور)
مسودة أقدم من 48 ساعة → CANCELLED تلقائيًا
```

### 4) البطاقات

```
issueCard(type, ownerId) → رمز خام مرة واحدة + QR
  └─ يُخزَّن HMAC-SHA256(raw, AUTH_SECRET) فقط
revokeCard(cardId) → REVOKED فورًا
إصدار بديل / تعطيل الصاحب → إلغاء البطاقات النشطة
```

### 5) الاحتفاظ

```
runRetention()
  ├─ pruneBackups(settings.retention ≥ 2)
  ├─ expireStaleTrips(> 48h)
  ├─ cleanSessions()
  └─ تقرير Audit أقدم من 730 يومًا (لا حذف)
Attendance و Audit لا يُحذفان تلقائيًا.
```

### 6) تطبيق سطح المكتب — الإقلاع والتخزين

```
Electron main
  ├─ resolveDataDir: Portable → <exe>\SchoolAttendanceData، مثبّت → userData\data
  ├─ Runtime.init(): يحمّل ملفات .gs في VM مع خدمات تحاكي
  │   SpreadsheetApp / PropertiesService / DriveApp / LockService
  ├─ AppServer.listen: 127.0.0.1:43118 ثم 43119/43120/منفذ عشوائي
  ├─ أول تشغيل: /setup/install لجهاز أساسي أو /setup/join لاستنساخ جهاز قائم
  └─ بعد التهيئة: مزامنة + نسخ احتياطي + صيانة في الخلفية
```

- الواجهة والأعمال كلها محلية؛ لا يلزم اتصال Google للاستخدام اليومي.
- كل كتابة إلى المخزن المحلي ذرية (ملف مؤقت ثم إعادة تسمية).
- الجهاز يعمل بمعرّف `deviceId` ثابت ومفتاح مزامنة عشوائي.

### 7) المزامنة بين الأجهزة

```
UDP discovery (deviceId + منفذ + اسم الجهاز)
  → قائمة أقران على شبكة المدرسة (بدون مفاتيح)
  → مزاوجة يدوية: المشرف ينسخ مفتاح الجهاز الآخر ويدخله في «إضافة جهاز»
  → GET /sync/changes?since=<cursor> مع x-sync-key
  → applyOps: HLC آخر-كاتب-يفوز للصفوف
  → دمج حقول الحضور (inAt/outAt) وبنود الرحلات (items)
  → السجل المحلي يخدم بقية الأقران (full mesh)
```

- كل جهاز مستقل تمامًا، ويتبادل العمليات عند توفر الشبكة؛ لا يوجد خادم مركزي.
- الاكتشاف لا ينقل مفتاح المزامنة؛ الأقران بلا مفتاح يظهرون «بانتظار مفتاح المزامنة» حتى يزوّدهم المشرف.
- جهاز جديد: `/setup/join` يستدعي `/desktop/clone` (محمي بمفتاح المزامنة) ويستنسخ `workbook` و`properties`.
- المزامنة لا تعتمد على الساعة وحدها: HLC مع حد انحراف ودمج حتمي.

### 8) النسخ الاحتياطي السحابي

```
runNow
  ├─ createBackup_ → نسخة محلية JSON داخل data/drive
  ├─ تصدير attendance-<deviceId>-<stamp>.json و.xlsx في backups/exports
  ├─ Google Sheets: تبويبات عربية مقروءة (الطلاب/الحضور/الأيام/...)
  ├─ Google Drive: رفع JSON وXLSX عند توفر مساحة
  └─ عند 403 storage quota: أرشيف JSON داخل تبويب JSON في جدول Google
```

- الاستعادة: `/desktop/backup/import-latest` يقرأ ملف Drive أو تبويب JSON ثم ينزّله للنسخ المحلية.
- النسخ التلقائي يومي وفق وقت النسخ في إعدادات النظام، ومستقل عن `settings.autoBackup` في GAS.

---

## [MODULES]

| الملف | المسؤولية | لا يفعل |
|---|---|---|
| `00_PasswordCrypto.gs` | bcryptjs مُضمَّن | — |
| `01_Config.gs` | `TABLES_`, `ROLE_PERMISSIONS_`, `ACTION_POLICY_`, `ERROR_MESSAGES_` | منطق أعمال |
| `02_Core.gs` | أخطاء، تحقق، تطبيع، وقت، تشفير، سجل تقني، `publicAccount_`, `sanitizeSettings_` | Sheets |
| `03_Repo.gs` | المحول الوحيد لـ Sheets: قراءة/كتابة، قفل، مخطط، كاش صفوف | أعمال |
| `04_Audit.gs` | `audit_`, `auditSafe_`, `getAudit_` | تعديل سجلات |
| `05_Auth.gs` | جلسات، دخول، حسابات، كلمات مرور، SSO | صلاحيات خارج الأدوار |
| `06_Cards.gs` | إصدار/إلغاء/بحث البطاقات، تحويل QR إلى هوية | منطق الحضور |
| `07_Attendance.gs` | كتل الأيام، المسح، التصحيح، الإغلاق، الملخص | تعديل الأيام المغلقة |
| `08_People.gs` | الطلاب، السائقون، الإعدادات، حالة قاعدة البيانات | مصادقة |
| `09_Trips.gs` | دورة الرحلة والمسح الفردي والتأكيد | تقارير |
| `10_Reports.gs` | 8 تقارير من السجلات الخام | كتابة |
| `11_Backup.gs` | نسخ، استعادة، تقليم، احتفاظ، إلغاء مسودات | حذف حضور |
| `12_Entry.gs` | `api()`, `ACTION_HANDLERS_`, التثبيت، الترحيل، الصيانة | أعمال مباشرة |
| `Index.html` | الهيكل، الدخول، التنقل، `SA.boot()` | منطق |
| `ui_Styles.html` | نظام تصميم RTL كامل | سكربت |
| `ui_Vendor.html` | jsQR + qrcode مُجمّعان | — |
| `ui_App.html` | نواة العميل: `api()`، جلسة، نوافذ، كاميرا/صورة QR، تنقل | عرض صفحات |
| `ui_Home.html` | لوحة اليوم والمسح والتصحيح والإغلاق | إعدادات |
| `ui_Students.html` | الطلاب، الاستيراد، البطاقات | رحلات |
| `ui_Trips.html` | الرحلات والسائقون وبطاقاتهم | تقارير |
| `ui_Reports.html` | التقارير والتصفية وتصدير CSV | كتابة بيانات |
| `ui_Settings.html` | عام، مستخدمون، نسخ، تدقيق، كلمة مرور | أعمال مباشرة |

### وحدات سطح المكتب (`desktop/`)

| الملف | المسؤولية | لا يفعل |
|---|---|---|
| `main.js` | دورة حياة Electron، النافذة، المؤقتات، IPC | منطق أعمال |
| `server.js` | خادم HTTP محلي: الإعداد، API، المزامنة، النسخ؛ يفرض Host/Origin محليًا وجلسة مشرف على `/desktop/*` | تعديل القاعدة مباشرة |
| `preload.js` | جسر IPC محدود للواجهة | كشف Node للـrenderer |
| `vm/runtime.js` | تحميل `.gs` في VM، install/join، API، صيانة، `resolveSession` لمسارات الإدارة | شبكة |
| `vm/services.js` | محاكاة SpreadsheetApp/PropertiesService/DriveApp/LockService | منطق أعمال |
| `data/store.js` | مخزن محلي، كتابة ذرية، التقاط تغييرات الصفوف | مزامنة |
| `sync/model.js` | تعريف الجداول، مفاتيح الصفوف، التطبيع | نقل |
| `sync/journal.js` | سجل `ops.jsonl` ومؤشرات الاستلام والتقليم | تطبيق |
| `sync/engine.js` | توليد العمليات، مزامنة الأقران، الحالة | واجهة |
| `sync/apply.js` | تطبيق العمليات، دمج الحقول/العناصر، الحذف | قراءة الملفات |
| `sync/discovery.js` | اكتشاف UDP للأقران على LAN (بدون مفاتيح) | مزامنة سحابية أو بث أسرار |
| `backup/google.js` | OAuth حساب الخدمة، Sheets/Drive، أرشيف JSON | تشغيل النظام |
| `backup/workbook.js` | استيراد الطلاب، تبويبات مقروءة، XLSX | تعديل القاعدة |
| `backup/manager.js` | نسخ محلي/سحابي، استعادة، جدولة، تقليم | واجهة |
| `update/updater.js` | فحص `update.json` على GitHub، تنزيل المثبّت مع تحقق sha256، تشغيله فوق القديم | تعديل البيانات |
| `lib/elevation.js` | بوابة موافقة مسؤول Windows (UAC) لاستعادة كلمة المرور: nonce وملف موافقة محمي | تعديل القاعدة |
| `ui/setup.html` | تهيئة جهاز أو الانضمام إلى جهاز آخر | واجهة GAS |
| `ui/bridge.js` | جسر IPC الآمن للواجهة | منطق |
| `ui/desktop-settings.js` | لوحة المزامنة والنسخ والاستيراد ومعلومات الجهاز (للمشرف فقط) | منطق خادم |
| `tools/import-students.js` | استيراد دفعات من Excel/CSV دون سجلات حضور | حضور |
| `tools/make-icon.js` | توليد أيقونة التطبيق | — |

---

## [FEATURE_MAP]

كل ميزة مرتبطة بمسار مستخدم، إجراءات خادم، وشاهد اختبار.

| # | المسار | الواجهة | إجراءات الخادم | الشاهد |
|---|---|---|---|---|
| 1 | دخول بكلمة المرور | `Index.html` + `ui_App` | `publicConfig`, `login`, `bootstrap`, `logout` | `auth.test.js` |
| 2 | دخول ببطاقة QR | `ui_App` | `loginCard` | `auth`, `cards` |
| 3 | دخول Google (SSO) | `ui_App` | `loginGoogle` | `auth` |
| 4 | تغيير كلمة مرور مؤقتة | `ui_App`, `ui_Settings` | `changePassword` | `auth` |
| 5 | لوحة اليوم والملخص | `ui_Home` | `getDay` | `attendance` |
| 6 | مسح حضور/انصراف | `ui_Home` | `scanStudent` | `attendance`, `cards` |
| 7 | تصحيح سجل بسبب | `ui_Home` | `correctAttendance` | `attendance` |
| 8 | إنهاء حضور اليوم | `ui_Home` | `closeDay` | `attendance` |
| 9 | إدارة الطلاب | `ui_Students` | `getStudents`, `saveStudent` | `attendance` |
| 10 | استيراد طلاب | `ui_Students` | `importStudents` | `attendance` |
| 11 | إصدار بطاقة طالب (طباعة 6×6 سم) | `ui_Students` | `issueCard` | `cards` |
| 12 | عرض/إلغاء البطاقات | `ui_Students` | `getCards`, `revokeCard` | `cards` |
| 13 | إدارة السائقين وربط الطلاب | `ui_Trips` | `getDriverAdminData`, `saveDriver`, `deleteDriver` | `trips` |
| 14 | بطاقة سائق | `ui_Trips` | `issueCard('DRIVER')` | `cards`, `trips` |
| 15 | فتح رحلة حضور/انصراف | `ui_Trips` | `openTrip` | `trips` |
| 16 | مسح طالب داخل الرحلة | `ui_Trips` | `scanTrip` | `trips` |
| 17 | تراجع عن مسح | `ui_Trips` | `unscanTrip` | `trips` |
| 18 | مراجعة وتأكيد الرحلة | `ui_Trips` | `getTrip`, `confirmTrip` | `trips` |
| 19 | إلغاء رحلة | `ui_Trips` | `cancelTrip` | `trips` |
| 20 | قائمة رحلات اليوم | `ui_Trips` | `getTrips` | `trips`, `reports` |
| 21 | تقارير الحضور (8 أنواع) | `ui_Reports` | `getReport` | `reports` |
| 22 | تصدير CSV | `ui_Reports` | — (عميل) | `verify` |
| 23 | الإعدادات العامة | `ui_Settings` | `getSettings`, `saveSettings` | `migration`, `reports` |
| 24 | حالة قاعدة البيانات | `ui_Settings` | `getDatabaseStatus` | `contract` |
| 25 | إدارة المستخدمين | `ui_Settings` | `getUsers`, `saveUser` | `auth` |
| 26 | سجل التدقيق | `ui_Settings` | `getAudit` | `contract`, `attendance` |
| 27 | نسخة احتياطية يدوية | `ui_Settings` | `createBackup` | `backup` |
| 28 | حالة النسخ والاستعادة | `ui_Settings` | `getBackupStatus`, `previewRestore`, `restoreBackup` | `backup` |
| 29 | سياسة الاحتفاظ | `ui_Settings` | `runRetention` | `backup` |
| 30 | ترحيل 3.5 | محرر فقط | `migrateV36` | `migration` |
| 31 | التثبيت والصيانة | محرر فقط | `installSchool`, `maintenance_`, `recoverSupervisor` | `smoke`, `backup` |
| 32 | تهيئة جهاز سطح مكتب جديد | `desktop/ui/setup.html` | `/setup/install`, `/setup/parse-students` | `desktop/server`, `desktop/workbook` |
| 33 | انضمام جهاز إلى جهاز قائم | `desktop/ui/setup.html` | `/setup/join`, `/desktop/clone` | `desktop/server`, `desktop/sync` |
| 34 | عمل كامل دون إنترنت | كل الواجهة | `/api` محلي | `desktop/store`, `desktop/server` |
| 35 | مزامنة تلقائية/يدوية بين الأجهزة | لوحة سطح المكتب | `/desktop/sync/*`, `/sync/changes` | `desktop/sync` |
| 36 | استيراد الطلاب من Excel/CSV | لوحة سطح المكتب + CLI | `importStudents`, `/desktop/parse-students` | `desktop/workbook`, `desktop/sync` |
| 37 | نسخة محلية JSON + XLSX | لوحة سطح المكتب | `/desktop/backup/run` | `desktop/backup` |
| 38 | نسخة سحابية مقروءة | لوحة سطح المكتب | `/desktop/backup/test`, `/desktop/backup/run` | `desktop/backup` |
| 39 | استعادة أحدث نسخة سحابية | لوحة سطح المكتب | `/desktop/backup/import-latest` | `desktop/backup` |
| 40 | معلومات الجهاز وتنزيل القاعدة | لوحة سطح المكتب | `/desktop/status`, `/desktop/database` | `desktop/server` |
| 41 | بطاقة مستخدم النظام وطباعتها 6×6 سم | `ui_Settings` | `issueCard('USER')` | `cards` |
| 41 | استعادة كلمة مرور المشرف (بتأكيد UAC) | شاشة الدخول | IPC `desktop:recover-admin` | `desktop/main`, `desktop/lib/elevation`, `desktop/ui` |

---

## [ACTION_POLICY] — 41 إجراءً

| الإجراء | عام | قفل | idempotent | صلاحية |
|---|---:|---:|---:|---|
| `ping`, `publicConfig` | ✔ | ✘ | ✘ | — |
| `login`, `loginCard`, `loginGoogle` | ✔ | ✔ | ✘ | — |
| `bootstrap`, `logout`, `changePassword` | ✘ | حسب | ✘ | جلسة فقط |
| `getDay` | ✘ | ✔ | ✘ | `dashboard` |
| `scanStudent`, `closeDay` | ✘ | ✔ | ✔ | `scan` / `closeDay` |
| `correctAttendance` | ✘ | ✔ | ✔ | `journeys.correct` |
| `getStudents` | ✘ | ✘ | ✘ | `students.read` |
| `saveStudent`, `importStudents` | ✘ | ✔ | ✘ | `students.write` |
| `getDriverAdminData` | ✘ | ✘ | ✘ | `drivers.manage` |
| `saveDriver`, `deleteDriver` | ✘ | ✔ | ✘ | `drivers.manage` |
| `issueCard`, `revokeCard` | ✘ | ✔ | ✘ | `cards` |
| `getCards` | ✘ | ✘ | ✘ | `cards` |
| `openTrip`, `addTripStudent`, `scanTrip`, `unscanTrip`, `confirmTrip`, `cancelTrip` | ✘ | ✔ | ✔ | `journeys` |
| `getTrips`, `getTrip` | ✘ | ✘ | ✘ | `journeys.read` |
| `getReport` | ✘ | ✘ | ✘ | `reports` |
| `getSettings`, `getDatabaseStatus` | ✘ | ✘ | ✘ | `settings` |
| `saveSettings` | ✘ | ✔ | ✘ | `settings` |
| `getUsers` | ✘ | ✘ | ✘ | `users` |
| `saveUser` | ✘ | ✔ | ✘ | `users` |
| `getAudit` | ✘ | ✘ | ✘ | `audit` |
| `createBackup`, `getBackupStatus`, `runRetention` | ✘ | حسب | ✘ | `backups` |
| `previewRestore`, `restoreBackup` | ✘ | حسب | ✘ | `restore` |

`users` ممنوحة للمشرف الأصلي فقط، وليست لكل مدير نظام.

---

## [SECURITY_INVARIANTS]

1. كل التحقق من الهوية والصلاحية على الخادم؛ العميل لا يقرر صلاحية.
2. QR يحمل رمزًا غامضًا فقط؛ لا يحمل رقم الطالب ولا اسمه.
3. `Cards` تخزّن بصمة HMAC فقط؛ الرمز الخام يظهر مرة واحدة.
4. الجلسات مخزّنة كـ`SESSION_<sha256(token)>`؛ الرمز الخام لا يُكتب في Properties.
5. إبطال الجلسات عند: تغيير كلمة المرور، تغيير الدور، التعطيل، أو الاستعادة.
6. لا تُستعاد صلاحيات الوصول أو الأتمتة من نسخة احتياطية قديمة.
7. لا حذف لسجل حضور أو تدقيق؛ التصحيح أثر جديد.
8. كل عمليات القفل تُنفَّذ داخل `withLock_`، والتدقيق داخل نفس القفل.
9. الواجهة لا تستخدم `innerHTML`/`eval`/`new Function`؛ لا موارد بعيدة.
10. الاستجابات العامة لا تحتوي `passwordHash` ولا `AUTH_SECRET` ولا `token_hash`.
11. بريد مشرفي SSO يُقرأ ويُكتب من المشرف الأصلي فقط؛ أي مدير آخر لا يمكنه محوه أو تغييره.

### سطح المكتب

12. لوحة الإدارة و`/api` مقصورتان على `loopback`؛ مسارات المزامنة على LAN تتطلب `x-sync-key`.
13. مفتاح المزامنة لا يُسجَّل في السجلات ولا يُرسل إلا لأقران الشبكة المحلية.
14. بيانات حساب خدمة Google تُخزَّن مشفرة بـ`safeStorage` (DPAPI) أو AES-GCM، ولا تدخل النسخ الاحتياطية.
15. كل كتابة إلى المخزن المحلي ذرية (ملف مؤقت ثم إعادة تسمية) لمنع التلف عند الانقطاع.
16. النافذة تعمل بـ`contextIsolation` و`sandbox` و`nodeIntegration=false`، والروابط الخارجية عبر `shell.openExternal` فقط.
17. لقطة النسخ الاحتياطي تحتوي جداول البيانات والإعدادات المنقّاة فقط؛ لا تحتوي `AUTH_SECRET` أو `passwordHash` أو جلسات.
18. دمج المزامنة حتمي: HLC مع حد انحراف، وآخر-كاتب-يفوز للصفوف، ودمج حقول الحضور وبنود الرحلات.
19. استعادة كلمة مرور المشرف تتطلب تأكيدًا في نافذة Electron أصلية **وموافقة مسؤول Windows (UAC)**؛ المساعد المرتفع يكتب ملف موافقة مرتبطًا بـnonce في مجلد محمي، وتُصدر كلمة مؤقتة مرة واحدة وتُلغي الجلسات.

---

## [TEST_MAP]

| الملف | العدد | يغطي |
|---|---:|---|
| `smoke.test.js` | 2 | التثبيت، الإقلاع، الحالة الأساسية |
| `auth.test.js` | 13 | كلمة المرور، البطاقة، SSO، القفل، الجلسات، الأدوار، تغيير الكلمة مرة واحدة |
| `cards.test.js` | 11 | الإصدار، الإلغاء، البصمات، الأنواع، الصلاحيات، بطاقات 3.5 |
| `attendance.test.js` | 9 | الحضور/الانصراف، التصحيح، الإغلاق، الثبات، الصلاحيات |
| `trips.test.js` | 13 | الفتح، المسح، التراجع، التأكيد المزدوج، الإلغاء، التعارض، إضافة طالب غير مرتبط |
| `reports.test.js` | 5 | الأنواع الثمانية، الفترة، التصفية، النسب |
| `backup.test.js` | 5 | الإنشاء، التقليم، الاستعادة، التراجع، الاحتفاظ |
| `migration.test.js` | 6 | الأعمدة، رموز 3.5، الرحلات، التكرار، الأمان |
| `scoping.test.js` | 3 | نطاق الفصول: تصفية الطلاب واليوم والتقارير، رفض القراءة/النقل/الاستيراد خارج النطاق، تحقق فصول الحساب |
| `contract.test.js` | 14 | 41 إجراءً، العقد، الصلاحيات، الأسرار، عقد UI، منع الحقن، التقويم، باركود جماعي |
| `desktop/test/hlc.test.mjs` | 2 | ترتيب HLC والانحراف الزمني |
| `desktop/test/secrets.test.mjs` | 4 | DPAPI/AES-GCM، العبث، الحذف، التحقق |
| `desktop/test/store.test.mjs` | 4 | هوية الجهاز، التقاط التغييرات، الحفظ الذري، الاستبدال |
| `desktop/test/workbook.test.mjs` | 6 | استيراد الطلاب، التطبيع العربي، التكرار، الأخطاء |
| `desktop/test/sync.test.mjs` | 6 | السجل، LWW، دمج الحضور، الرحلات، تقارب جهازين وثلاثة أجهزة |
| `desktop/test/server.test.mjs` | 17 | المسارات، حماية loopback، API، الاستيراد، SETUP_REQUIRED، استعادة المشرف |
| `desktop/test/backup.test.mjs` | 8 | نسخ محلي/تصدير، عدم التهيئة، الأسرار، الاحتفاظ |
| `desktop/test/packaging.test.mjs` | 6 | اكتمال حزمة asar، `app-src`، تحقق آلي أن كل `require` في main.js محزوم، أهداف x64 |
| `desktop/test/elevation.test.mjs` | 8 | بوابة موافقة UAC: nonce، الصلاحية الزمنية، حماية مجلد الموافقة |
| `desktop/test/update.test.mjs` | 7 | مقارنة الإصدارات، فحص البيان (https/exe/sha256)، التنزيل والتحقق ورفض الملف المخالف |
| **الإجمالي** | **149** | **كل المسارات أعلاه** |

`npm run verify` يفحص أيضًا: صياغة كل ملفات `.gs`، اكتمال `include` في `Index.html`،
أن كل إجراء مستدعى من الواجهة معلن، وأن كل إجراء معلن (عدا `ping`) مستدعى، وغياب placeholders،
وحجم حزمة vendor، وعدم وجود موارد بعيدة.

---

## [DEPLOYMENT]

الخطوات الكاملة في `docs/OPERATIONS.md`، وملخص التسليم والمخرجات في `docs/DELIVERY.md`، وتدقيق الأمان قبل الإطلاق في `docs/SECURITY_AUDIT.md`. دليل المستخدم النهائي في `docs/guide/دليل-الاستخدام-3.6.0.pdf` (مصدره `docs/guide/guide.html` وصوره في `docs/guide/img/`). صفحات نشر OAuth (تعريف التطبيق وسياسة الخصوصية) في `docs/oauth-site/` مع خطوات الاستضافة في `docs/oauth-site/README.md`. الملخص:

### Apps Script

1. `npm install` ثم `npm run vendor` ثم `npm run verify` ثم `npm test`.
2. `clasp push` بعد ضبط `.clasp.json` (غير ملتزم).
3. تشغيل `installSchool` من المحرر بحساب المالك.
4. نشر Web App: `executeAs=USER_DEPLOYING`, `access=DOMAIN`.
5. تسجيل الدخول بكلمة المرور المؤقتة وتغييرها.
6. تنفيذ قائمة UAT في `docs/OPERATIONS.md §10`.

### تطبيق Windows

1. `npm --prefix desktop install` ثم `npm run desktop:dist`.
2. المخرجات في `dist-desktop`:
   - `School-Attendance-Setup-3.6.2-x64.exe` (مثبّت NSIS).
   - `School-Attendance-Portable-3.6.2-x64.exe` (محمول، بلا تثبيت).
3. التثبيت أو تشغيل المحمول. بيانات المحمول في `SchoolAttendanceData` بجوار الملف،
   وبيانات المثبّت في `%APPDATA%\<app>\data`.
4. أول تشغيل: «تهيئة مدرسة جديدة» أو «الانضمام إلى جهاز» بمفتاح المزامنة.
5. استيراد الطلاب (اختياري): من لوحة «سطح المكتب ← استيراد الطلاب»، أو:
   ```powershell
   npm --prefix desktop run import-students -- --file "E:\projects\بيانات الطلاب.xlsx" --data-dir "<مجلد البيانات>" --dry-run
   ```
6. إعداد حساب خدمة Google من «سطح المكتب ← النسخ السحابي» (اختياري لكنه موصى به).
7. التوقيع الرقمي: استخدم الشهادة الداخلية عبر
   `powershell -File tools\build-desktop-signed.ps1`، وثبّت الشهادة العامة على
   أجهزة المدرسة بـ`tools\trust-internal-signing.ps1 -Scope LocalMachine`.

---

## [ORPHANS & PENDING]

**لا يوجد كود يتيم.** كل ميزة مرتبطة بمسار مستخدم، وإجراء/مسار خادم، وواجهة، وشاهد اختبار.
لا توجد أزرار بلا معالج، ولا placeholders أو `TODO`.

البنود المتبقية خارجية أو تشغيلية وليست عيوبًا في الكود:

| البند | الحالة | ما يلزم |
|---|---|---|
| رفع JSON/XLSX كملفات في Drive الشخصي | محجوب من Google لحسابات الخدمة (`Service Accounts do not have storage quota`) | OAuth بموافقة المستخدم أو Google Workspace Shared Drive. البديل الحالي: تبويب `JSON` في جدول Google + نسختان محليتان |
| روزنامة 100 طالب | الملف المتاح يحتوي 44 طالبًا (`STU-1001`…`STU-1044`) | توفير ملف الـ100 طالب ثم تشغيل `import-students` |
| كاميرا الهاتف، قارئ USB، SSO بنطاق Google | لم تُختبر على أجهزة المدرسة | UAT خارجي في `docs/OPERATIONS.md §18` |
| توقيع EXE رقميًا | موقّع بشهادة داخلية (بصمة `CB0B4256…6769`) عبر `tools\build-desktop-signed.ps1`، والثقة تُنشر بـ`tools\trust-internal-signing.ps1` | استبدالها بشهادة CA عامة عند الحاجة إلى سمعة SmartScreen تلقائية |
| تشغيل 3–5 أجهزة على LAN فعلي | اختبار التقارب آلي فقط | UAT على شبكة المدرسة |

مخرجات البناء الحالية موجودة في `dist-desktop/` ولم تُلتزم في Git.

---

## [CHANGELOG]

### 3.6.2 — 2026-11-18
- عزل صفوف بحسب فصول الحساب في قائمة الطلاب وسجل اليوم والتقارير؛ فارغ = كل الفصول، والمشرف يرى الكل، ويُرفض إنشاء/نقل/استيراد طالب خارج النطاق.
- إصلاح حزم وحدات التحديث داخل `app.asar` (كان `update/**/*` غير محزوم فتفشل المزامنة/التحديث في النسخة المثبّتة).
- `overrides` لـ`minimatch@11.0.1` يزيل 6 تحذيرات ReDoS في أدوات البناء؛ `npm audit` = 0.
- 149 اختبارًا (بينها `scoping.test.js`).

### 3.6.1 — 2026-11-18
- التقويم الهجري (أم القرى) بزر واحد في الشريط العلوي، دون تغيير التخزين الميلادي.
- طباعة باركود جماعية لكل الطلاب النشطين: الأرقام فقط على الملصق والرمز يشفّر `STU-####`.
- إضافة طالب غير مرتبط بالسائق إلى رحلة مفتوحة بسبب مسجّل في التدقيق.
- تحديث التطبيق عن بُعد: فحص `update.json` عند الإقلاع، تنزيل المثبّت بالتحقق `sha256`، وتشغيله فوق الإصدار القديم دون فقدان البيانات.
- ربط حساب Google الشخصي (OAuth/PKCE) لرفع النسخ إلى Drive بصلاحية `drive.file`.
- نطاق فصول لكل حساب مستخدم: قائمة طلاب ويوم وتقارير مفلترة، والمشرف يرى الكل، والحساب بلا نطاق يرى كل الفصول.
- 149 اختبارًا + فحص تحقق ساكن، ومنها تحقق آلي أن كل وحدة يستدعيها `main.js` محزومة داخل asar.

### 3.6.0 — 2026-11-07
- إعادة بناء الخادم حول `api()` واحد و40 إجراءً معلنًا.
- جلسات Script Properties، bcrypt تكلفة 12، SSO، وإبطال أمني دقيق.
- بطاقات QR ببصمة HMAC، وترحيل بطاقات 3.5.
- رحلات `DRAFT → CONFIRMED` بمسح فردي وتأكيد idempotent و`TripDetails`.
- واجهة RTL جديدة بستة تبويبات، قارئ QR محلي (jsQR) بكاميرا أو صورة، وQR محلي.
- دعم بطاقات 3.5 المطبوعة (STU-####) في المسح والاستيراد دون كسر البطاقات القديمة.
- تقارير ثمانية، تصدير CSV، نسخ/استعادة/احتفاظ، وسجل تدقيق.
- 74 اختبارًا + فحص تحقق ساكن، وتوثيق تشغيلي كامل.

### 3.6.0 — سطح المكتب
- تطبيق Electron مستقل يعيد استخدام منطق `.gs` عبر VM وطبقة خدمات، ويعمل دون إنترنت.
- مخزن محلي ذري، جهاز بهوية ثابتة، وجلسات/أسرار مشفرة.
- مزامنة full-mesh على LAN: اكتشاف UDP، سجل عمليات إلحاقي، HLC، ودمج حقول الحضور وبنود الرحلات.
- استيراد روزنامة الطلاب من Excel/CSV عبر الواجهة أو سطر الأوامر، دون سجلات حضور تاريخية.
- نسخ احتياطي محلي JSON/XLSX، ونسخ سحابي بجدول Google مقروء، مع أرشيف `JSON` عند منع Google رفع الملفات الثنائية.
- مثبّت NSIS ومحمول x64 مع أيقونة، وتوقيع رقمي داخلي موثوق عبر شهادة Self-Signed موزّعة، وتوثيق SmartScreen.
- استعادة كلمة مرور المشرف من شاشة الدخول بعد تأكيد أصلي وموافقة مسؤول Windows (UAC)، بكلمة مؤقتة تُعرض مرة واحدة.
- تغيير كلمة المرور إلزامي عند أول دخول فقط؛ بعد التغيير لا تتكرر المطالبة، وإعادة تعيين المشرف وحدها تجعلها مؤقتة مجددًا.
- خط الواجهة Times New Roman، ورسائل التنبيه/التحذير/التعبئة تُغلق تلقائيًا أو بزر ×.
- 57 اختبار سطح مكتب إضافي (إجمالي 131)، بما فيها بوابة UAC وتقارب ثلاثة أجهزة وفحص حزمة يمنع نقص وحدات وقت التشغيل وأخطاء تحليل السكربتات، واختبارات أمان المسارات والرؤوس وSSRF والرفع، واختبار عدم قفز التمرير عند تركيز قارئ الباركود.
