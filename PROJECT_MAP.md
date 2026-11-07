# PROJECT_MAP — نظام الحضور والانصراف المدرسي (v3.6)

> **الحالة:** **IMPLEMENTED & VERIFIED (محليًا)** — الكود جاهز للنشر، والتحقق الآلي كامل.
> **الإصدار:** `3.6.0` • **وقت التشغيل:** Google Apps Script V8 • **قاعدة البيانات:** Google Sheets.
> **تاريخ الأساس:** 2026-11-07 (Asia/Riyadh، UTC+03:00).
> **مصدر المتطلبات:** وثيقة نظام الحضور والانصراف 3.6 (المرجع 3.5).
> **آخر تحقق:** `npm run verify` = OK • `npm test` = 71/71 ناجح.

---

## [TECH_STACK]

| المكوّن | الاختيار | ملاحظة |
|---|---|---|
| Runtime | Apps Script V8 | لا Node APIs وقت التشغيل |
| الواجهة | `HtmlService` + `IFRAME` | RTL، بلا CDN، بلا `innerHTML` |
| البيانات | Google Sheets واحد | `SpreadsheetApp.openById` فقط |
| الأسرار | Script Properties | `AUTH_SECRET`، الجلسات، الحسابات |
| الملفات | DriveApp | نسخ `attendance-*.json` |
| الكاميرا | `@zxing/browser 0.2.1` | مُجمّعة محليًا في `ui_Vendor.html` |
| QR | `qrcode-generator 2.0.4` | `createDataURL` فقط |
| كلمات المرور | `bcryptjs 2.4.3` داخل `00_PasswordCrypto.gs` | تكلفة 12، ملح من HMAC |
| الاختبارات | `vitest 5.1.0` + محاكي GAS | 71 اختبارًا |
| البناء | `esbuild 0.28.2` | `npm run vendor` |
| النشر | `clasp 3.x` | `.clasp.json` مستبعد من Git |

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
  ├─ input = بطاقة QR → STUDENT Card نشطة
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

scanTrip(tripId, input, choice, reason)
  ├─ choice = scan | guardian
  ├─ يتحقق: السائق نشط، الطالب مرتبط به، حالة اليوم مناسبة
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
| `ui_Vendor.html` | ZXing + qrcode مُجمّعان | — |
| `ui_App.html` | نواة العميل: `api()`، جلسة، نوافذ، كاميرا، تنقل | عرض صفحات |
| `ui_Home.html` | لوحة اليوم والمسح والتصحيح والإغلاق | إعدادات |
| `ui_Students.html` | الطلاب، الاستيراد، البطاقات | رحلات |
| `ui_Trips.html` | الرحلات والسائقون وبطاقاتهم | تقارير |
| `ui_Reports.html` | التقارير والتصفية وتصدير CSV | كتابة بيانات |
| `ui_Settings.html` | عام، مستخدمون، نسخ، تدقيق، كلمة مرور | أعمال مباشرة |

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
| 11 | إصدار بطاقة طالب | `ui_Students` | `issueCard` | `cards` |
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

---

## [ACTION_POLICY] — 40 إجراءً

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
| `openTrip`, `scanTrip`, `unscanTrip`, `confirmTrip`, `cancelTrip` | ✘ | ✔ | ✔ | `journeys` |
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

---

## [TEST_MAP]

| الملف | العدد | يغطي |
|---|---:|---|
| `smoke.test.js` | 2 | التثبيت، الإقلاع، الحالة الأساسية |
| `auth.test.js` | 11 | كلمة المرور، البطاقة، SSO، القفل، الجلسات، الأدوار |
| `cards.test.js` | 10 | الإصدار، الإلغاء، البصمات، الأنواع، الصلاحيات |
| `attendance.test.js` | 9 | الحضور/الانصراف، التصحيح، الإغلاق، الثبات، الصلاحيات |
| `trips.test.js` | 12 | الفتح، المسح، التراجع، التأكيد المزدوج، الإلغاء، التعارض |
| `reports.test.js` | 5 | الأنواع الثمانية، الفترة، التصفية، النسب |
| `backup.test.js` | 5 | الإنشاء، التقليم، الاستعادة، التراجع، الاحتفاظ |
| `migration.test.js` | 6 | الأعمدة، رموز 3.5، الرحلات، التكرار، الأمان |
| `contract.test.js` | 11 | 40 إجراءً، العقد، الصلاحيات، الأسرار، عقد UI، منع الحقن |
| **الإجمالي** | **71** | **كل المسارات أعلاه** |

`npm run verify` يفحص أيضًا: صياغة كل ملفات `.gs`، اكتمال `include` في `Index.html`،
أن كل إجراء مستدعى من الواجهة معلن، وأن كل إجراء معلن (عدا `ping`) مستدعى، وغياب placeholders،
وحجم حزمة vendor، وعدم وجود موارد بعيدة.

---

## [DEPLOYMENT]

الخطوات الكاملة في `docs/OPERATIONS.md`. الملخص:

1. `npm install` ثم `npm run vendor` ثم `npm run verify` ثم `npm test`.
2. `clasp push` بعد ضبط `.clasp.json` (غير ملتزم).
3. تشغيل `installSchool` من المحرر بحساب المالك.
4. نشر Web App: `executeAs=USER_DEPLOYING`, `access=DOMAIN`.
5. تسجيل الدخول بكلمة المرور المؤقتة وتغييرها.
6. تنفيذ قائمة UAT في `docs/OPERATIONS.md §10`.

---

## [ORPHANS & PENDING]

**لا يوجد.**

كل ميزة في وثيقة 3.6 مرتبطة بمسار مستخدم، وإجراءات خادم معلنة، وواجهة، وشاهد اختبار.
لا توجد أزرار بلا معالج، ولا إجراءات خادم غير مستدعاة (عدا `ping` فحص صحة مقصود)،
ولا جداول/أعمدة بلا قارئ أو كاتب، ولا placeholders أو `TODO`.

بنود التحقق الخارجي (نشر فعلي، كاميرا، نطاق Google، UAT بشري) ليست عيوبًا في الكود؛
هي خطوات تسليم موثّقة في `docs/OPERATIONS.md §10`، وتُغلق عند توفر `scriptId` وبيئة المدرسة.

---

## [CHANGELOG]

### 3.6.0 — 2026-11-07
- إعادة بناء الخادم حول `api()` واحد و40 إجراءً معلنًا.
- جلسات Script Properties، bcrypt تكلفة 12، SSO، وإبطال أمني دقيق.
- بطاقات QR ببصمة HMAC، وترحيل بطاقات 3.5.
- رحلات `DRAFT → CONFIRMED` بمسح فردي وتأكيد idempotent و`TripDetails`.
- واجهة RTL جديدة بستة تبويبات، كاميرا ZXing، وQR محلي.
- تقارير ثمانية، تصدير CSV، نسخ/استعادة/احتفاظ، وسجل تدقيق.
- 71 اختبارًا + فحص تحقق ساكن، وتوثيق تشغيلي كامل.
