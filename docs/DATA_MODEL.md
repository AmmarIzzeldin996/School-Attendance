# DATA MODEL — نظام الحضور والانصراف 3.6

كل البيانات التشغيلية في Google Sheets واحد، والوصول إليه عبر `SpreadsheetApp.openById` فقط.
الأسرار والجلسات في Script Properties، وليست في الشيت. ترتيب الأعمدة القديم محفوظ حرفيًا،
وأي توسعة مستقبلية تُضاف في نهاية الجدول فقط.

## 1) الأوراق (TABLES_)

### Students
| العمود | النوع | قيود |
|---|---|---|
| `id` | نص | 4 أرقام للطلاب الجدد؛ السجلات القديمة تقبل صيغة 3.5 |
| `name` | نص | فريد بعد التطبيع العربي |
| `classroom` | نص | مطلوب |
| `phone` | نص | اختياري |
| `active` | منطقي | الطالب الموقوف لا يدخل روزنامة اليوم |
| `token` | نص | يبقى فارغًا بعد الترحيل؛ الرمز القديم ينتقل إلى `Cards` كبصمة |

### Attendance — سجل واحد لكل (تاريخ، طالب)
| العمود | المعنى |
|---|---|
| `date` | تاريخ اليوم `YYYY-MM-DD` بتوقيت الرياض |
| `id`,`name`,`classroom` | لقطة من بيانات الطالب وقت إنشاء سجل اليوم |
| `status` | `pending` أو `present` أو `absent` |
| `inAt`,`outAt` | طوابع زمنية ISO للوصول والانصراف، مستقلان |
| `operator` | آخر من عدّل السجل |
| `inMethod`,`outMethod` | `qr` أو `manual` أو `driver` أو `guardian` |
| `inJourney`,`outJourney` | معرّف الرحلة التي طبّقت التسجيل (للمنع المزدوج) |

**الثبات:** لا يُعاد إنشاء صف لطالب موجود في يوم مغلق. إضافة الطلاب إلى يوم مفتوح تُلحق في نهاية
كتلة اليوم فقط، وإلا يفشل الطلب بـ `SCHEMA_NOT_READY`.

### Days — فهرس كتل الأيام
`date`, `closed`, `closedAt`, `operator`, `startRow`, `rowCount`.
`startRow` و`rowCount` يحددان كتلة اليوم داخل `Attendance`. يجب أن تبقى الكتلة متصلة بآخر الورقة
قبل أي إلحاق. إغلاق اليوم يثبّت الغياب ويمنع الوصول.

### Audit — سجل تدقيق إلحاقي
`at`, `operator`, `action`, `details`, `event_id`, `request_id`, `target_type`, `target_id`,
`result`, `reason`, `before_json`, `after_json`.
لا يُعدَّل ولا يُحذف آليًا. عمليات الدخول الفاشلة تُكتب بـ `result=FAIL` دون كشف كلمة المرور.

### Drivers
`code` (4 أرقام تبدأ بـ 9)، `name`, `area`, `phone`, `identity`, `studentIds` (JSON)،
`active`, `updatedAt`, `deleted`, `deletedReason`.
الحذف منطقي: `deleted=true` و`active=false`، مع الاحتفاظ بتاريخ الرحلات.
يُمنع ربط الطالب بأكثر من سائق نشط واحد.

### Journeys — الرحلات
`id`, `date`, `driverCode`, `driverName`, `area`, `mode` (`in`/`out`)، `revision`, `at`, `operator`,
`items`, `history`, `requestId`, `lastRequestId`, `status`, `confirmedAt`, `confirmedBy`, `appliedAt`.

- `items` مصفوفة JSON بالشكل `{id,name,classroom,state,method,at}`.
- `state` واحدة من: `pending`، `scanned`، `guardian`، `absent`. لا تُطبَّق عند التأكيد إلا `scanned` و`guardian`.
- `history` مصفوفة JSON لأحداث الرحلة، بسقف 40 حدثًا.
- `status` واحدة من: `DRAFT`، `CONFIRMED`، `CANCELLED`.
- `revision` يزيد مع كل تعديل؛ و`lastRequestId` يدعم idempotency.

### JourneyDays — فهرس كتل الرحلات
`date`, `startRow`, `rowCount`؛ نفس قواعد `Days` لكن على ورقة `Journeys`.

### Cards — بطاقات QR
`card_id`, `type` (`STUDENT`/`DRIVER`/`USER`)، `owner_id`, `token_hash`, `status`,
`issued_at`, `issued_by`, `revoked_at`, `revoked_by`, `last_used_at`, `note`.

- `token_hash = HMAC-SHA256(rawToken, AUTH_SECRET)` بصيغة hex.
- الرمز الخام يُعاد مرة واحدة عند الإصدار فقط، ولا يُخزَّن.
- إصدار بطاقة جديدة لنفس الصاحب يُلغي البطاقات النشطة من نفس النوع.
- إيقاف/حذف الصاحب يُلغي بطاقاته.
- البطاقة الملغاة تُرفض فورًا بـ `QR_REVOKED`.

### TripDetails
`trip_id`, `student_id`, `method`, `applied_at`, `request_id`.
تُكتب مرة واحدة عند تأكيد الرحلة، وتدعم منع التطبيق المزدوج حتى لو تكرر الطلب.

## 2) Script Properties

| المفتاح | الغرض |
|---|---|
| `DB_ID` | معرّف جدول Google Sheets |
| `ADMIN_EMAIL` | مالك النظام المسموح له بدوال المحرر |
| `INSTALL_VERSION` / `SCHEMA_VERSION` | إصدار التثبيت والمخطط (`6`) |
| `SETTINGS` | إعدادات النظام JSON |
| `AUTH_SECRET` | Pepper لتجزئة البطاقات ورموز الجلسات |
| `AUTH_PRIMARY_ADMIN` | معرّف المشرف الأصلي الوحيد |
| `AUTH_DUMMY` | تجزئة وهمية لموازنة زمن فشل الدخول |
| `AUTH_SCHEMA` | إصدار مخطط الحسابات (`4`) |
| `ACCOUNT_<uuid>` | حساب مستخدم JSON (يتضمن `passwordHash`) |
| `SESSION_<sha256>` | جلسة JSON (لا يُخزَّن الرمز الخام) |
| `BACKUP_FOLDER` | مجلد Drive للنسخ |
| `LAST_BACKUP` / `BACKUP_ERROR` | حالة النسخ التلقائي |
| `MAINTENANCE_ERROR` | آخر خطأ في الصيانة |

## 3) العلاقات والثوابت

1. `Attendance` مرتبط بـ`Days` بالفهرس، وبـ`Students` بالمعرّف، وبـ`Journeys` عبر `inJourney/outJourney`.
2. `Journeys` مرتبط بـ`JourneysDays` بالفهرس، وبـ`Drivers` بـ`driverCode`، وبـ`TripDetails` بـ`trip_id`.
3. `Cards.owner_id` يشير إلى `Students.id` أو `Drivers.code` أو `Users.id` حسب `type`.
4. كل كتابة تمر بـ`withLock_`؛ القراءات لا تأخذ القفل.
5. كل تعديل إداري يُنتج صف تدقيق داخل نفس القفل.
6. لا حذف لسجل حضور أو تدقيق؛ التصحيح أثر جديد لا استبدال صامت.

## 4) الترحيل من 3.5

`migrateV36()`:

- يمدد الأعمدة الجديدة في نهاية الجداول القديمة.
- ينشئ `Cards` و`TripDetails` وفهارس `JourneyDays`.
- يحوّل `Students.token` القديم (`STU-<uuid>`) إلى صف `Cards` ببصمة، ثم يفرّغ العمود.
- يرحّل رحلات 3.5 القديمة إلى `CONFIRMED` ويوحّد حالات عناصرها.
- لا يحذف أي بيانات قديمة، ويُبقي البطاقات المطبوعة تعمل.
- يعيد تقريرًا بعدد البطاقات المنشأة والمكررة والرحلات المؤرشفة.

---

## 5) مخزن سطح المكتب المحلي

تطبيق Windows لا يستخدم Google Sheets وقت التشغيل. يحاكي `SpreadsheetApp` فوق مخزن
محلي في مجلد البيانات، ثم يبني عليه نفس منطق `.gs` داخل VM.

```
<dataDir>/
  data/
    workbook.json        الكتاب المحلي: sheets + sheetMeta
    properties.json      Script Properties (حسابات، جلسات، إعدادات، أسرار)
    meta.json            هوية الجهاز وحالة التثبيت
    drive/
      index.json         فهرس المجلدات والملفات
      files/<id>         ملفات Drive المحلية (نسخ، مرفقات)
  sync/
    ops.jsonl            سجل العمليات الموحّد
    peers.json           مفتاح المزامنة والأقران والمؤشرات
    versions.json        نسخ HLC لكل صف/خاصية/بند
    hlc.json             آخر طابع HLC محلي
  backup/
    config.json          إعدادات النسخ السحابي (بلا أسرار)
    state.json           آخر نسخة، آخر خطأ، وضع الأرشيف
  backups/exports/       attendance-<deviceId>-<stamp>.json و.xlsx
  secrets/               مفتاح حساب الخدمة المشفّر + مفتاح AES المحلي
  logs/                  app-YYYY-MM-DD.log
```

### `workbook.json`

```json
{
  "version": 1,
  "bookId": "local-<uuid>",
  "name": "School Attendance (Local)",
  "createdAt": "ISO",
  "timeZone": "Asia/Riyadh",
  "sheets": { "Students": [["id", "name", "..."], ["STU-1001", "..."]], "…": [] },
  "sheetMeta": { "Students": { "frozenRows": 1, "rightToLeft": true } }
}
```

- الصف الأول هو الترويسة، والصفوف التالية هي البيانات. ترتيب الأعمدة مطابق لـ`TABLES_` في GAS.
- كل الكتابة تمر عبر `writeJsonAtomic` (ملف مؤقت ثم `rename`) لمنع التلف.
- `sheetMeta` يحفظ اتجاه RTL وتجميد الترويسة، ولا يدخل في المزامنة.

### `properties.json`

نفس مفاتيح Script Properties في القسم 2. تُستثنى الجلسات (`SESSION_*`) من النسخ
السحابي والاستنساخ، وتُصفَّر عند الانضمام إلى جهاز آخر. كلمات المرور لا تُخزَّن نصًا:

```json
"ACCOUNT_<uuid>": "{\"id\":\"…\",\"username\":\"admin\",\"role\":\"admin\",\"passwordHash\":\"$2a$12$…\",\"mustChange\":true}"
```

### `meta.json`

`deviceId` (12 حرفًا hex)، `deviceName`، `createdAt`، `installed`، `installedAt`،
`ownerEmail`، `role` (`primary` أو `joined`). `deviceId` ثابت طوال عمر الجهاز.

---

## 6) سجل المزامنة (`sync/`)

### `ops.jsonl`

سجل إلحاقي، سطر JSON واحد لكل عملية. لا يُعدَّل سطر بعد كتابته، ويُقرأ من البداية
عند الإقلاع، مع تقليم إلى آخر 400,000 سطر.

| الحقل | المعنى |
|---|---|
| `id` | معرّف العملية: `<deviceId>:<seq36>:<hlc>:<table>:<key>` |
| `d` | معرّف الجهاز الذي أنشأ العملية |
| `h` | طابع HLC `millis:counter:deviceId` |
| `k` | `row` أو `tombstone` أو `prop` |
| `t`,`key` | الجدول ومفتاح الصف (للصفوف والحذف) |
| `row` | مصفوفة الصف الكاملة بعد التغيير |
| `p`,`v` | اسم الخاصية وقيمتها (للخصائص) |
| `r` | رقم استلام محلي متزايد، يُستخدم كمؤشر مزامنة لكل قرين |
| `s` | رقم تسلسل المصدر المحلي |

### `peers.json`

```json
{
  "deviceId": "…",
  "key": "<24 بايت base64url>",
  "auto": true,
  "lastSyncAt": "",
  "lastError": "",
  "peers": {
    "<peerDeviceId>": {
      "name": "…", "url": "http://192.168.1.10:43118", "manual": false,
      "cursor": 120, "lastAt": "ISO", "lastError": "", "durationMs": 45
    }
  }
}
```

- `cursor` هو آخر `r` استُلم من القرين. يُطلب `GET /sync/changes?since=<cursor>&limit=400`.
- إذا كان المؤشر أكبر من آخر `r` لدى القرين، يعيد `reset=true` ويُصفَّر المؤشر.
- الجهاز يخدم العمليات التي أنشأها والتي استلمها؛ لا خادم مركزي.

### `versions.json` و`hlc.json`

- `versions.rows["<table>|<key>"] = hlc` لآخر كتابة صف.
- `versions.props["prop|<name>"] = hlc` لآخر كتابة خاصية.
- `versions.items["<tripId>|<studentId>"] = hlc` لآخر تعديل بند رحلة.
- `hlc.json = { "lastMs": 0, "counter": 0 }` لضمان رتابة الطوابع عند تعديل الساعة.

---

## 7) دمج المزامنة

### مفاتيح الصفوف

| الجدول | المفتاح |
|---|---|
| `Students` | `id` |
| `Attendance` | `date/id` |
| `Days` | `date` |
| `Audit` | `event_id` وإلا تجزئة SHA-256 مختصرة |
| `Drivers` | `code` |
| `Journeys` | `id` |
| `JourneyDays` | `date` |
| `Cards` | `card_id` |
| `TripDetails` | `trip_id/student_id` |

### القواعد

1. **آخر-كاتب-يفوز للصف** وفق HLC؛ العملية الأقدم أو المساوية تُتجاهل.
2. **الحضور يُدمج حقليًا**:
   - `inAt` الأقدم يفوز، و`outAt` الأحدث يفوز (حدثان مستقلان).
   - رتبة الحالة: `present` > `absent` > `pending`. لا يعود `present` إلى `pending`.
   - إذا وُجد `outAt` بلا `inAt`، يُستكمل `inAt` من النسخة الأخرى.
   - عند تثبيت `inAt` الأقدم تُحدَّث حقول طريقة/رحلة الوصول من العملية المقابلة.
3. **الرحلات تُدمج بندًا ببند** بمفتاح `tripId|studentId`:
   - حالة البند الأعلى رتبة تفوز (`scanned`/`guardian`/`absent` > `pending`).
   - `history` تُدمج أحداثها بلا تكرار، بسقف 40 حدثًا.
   - الرحلة `CONFIRMED` لا تعود `DRAFT` بسبب وصول متأخر.
4. **الحذف أثر (tombstone)** لا محو صامت؛ يمنع عودة الصف من نسخة قديمة.
5. **الخصائص** تُزامن من قائمة بيضاء فقط: `SETTINGS`، `AUTH_SECRET`،
   `AUTH_PRIMARY_ADMIN`، `AUTH_SCHEMA`، `AUTH_DUMMY`، `DB_ID`،
   `INSTALL_VERSION`، `SCHEMA_VERSION`، و`ACCOUNT_*`. الجلسات وبيانات Google لا تُزامن.
6. بعد كل دفعة تُعاد `canonicalize` لترتيب الطلاب/السائقين وكتل `Attendance`/`Journeys`
   وإعادة بناء فهارس `Days` و`JourneyDays`.

### حدود

- دفعة الشبكة 400 عملية، ومهلة الطلب 15 ثانية.
- سقف السجل 400,000 سطر مع تقليم تلقائي.
- انحراف الساعة يُعالج بـHLC؛ لا يُعتمد على وقت الجهاز وحده.

---

## 8) النسخة الاحتياطية (سطح المكتب)

### صيغة اللقطة

نفس `snapshot_()` في GAS:

```json
{
  "format": "school-attendance-backup",
  "version": 6,
  "appVersion": "3.6.0",
  "createdAt": "…",
  "settings": { "…": "…" },
  "tables": { "Students": [{ "id": "STU-1001", "…": "" }], "…": [] },
  "accounts": [{ "id": "…", "username": "admin", "role": "admin", "active": true }]
}
```

لا تحتوي اللقطة `passwordHash` ولا `SESSION_*` ولا `AUTH_SECRET` ولا مفتاح حساب الخدمة.

### الملفات المحلية

- `backups/exports/attendance-<deviceId>-<YYYYMMDD-HHmmss>.json`
- `backups/exports/attendance-<deviceId>-<YYYYMMDD-HHmmss>.xlsx`
- نسخة داخلية عبر `createBackup_` في `data/drive/files`.
- التقليم يحتفظ بضعف `settings.retention` محليًا، وبعدد `retention` في Drive.

### Google Sheets المقروء

تبويبات: `الطلاب`، `الحضور`، `الأيام`، `التدقيق`، `السائقون`، `الرحلات`،
`أيام الرحلات`، `البطاقات`، `تفاصيل الرحلات`، `الإعدادات`، `الحسابات`.
كل تبويب يُمسح ثم يُكتب على دفعات 1500 صف.

### أرشيف `JSON` داخل Google Sheet

عند رفض Drive لحساب الخدمة (`storage quota`):

- الصف الأول: `["archive", "<اسم الملف>", "<createdAt>", "<طول النص>"]`.
- الصفوف التالية: نص JSON مقسّم إلى شرائح 45,000 محرف، كل شريحة في العمود الأول.
- الاستعادة تجمع الشرائح ثم `JSON.parse` وتتحقق من `tables` قبل التنزيل المحلي.
- النسختان JSON وXLSX تظلان محفوظتين محليًا في كل الأحوال.

---

## 9) أسرار سطح المكتب

| الملف | المحتوى |
|---|---|
| `secrets/service-account.enc` | بيانات حساب خدمة Google مشفرة |
| `secrets/service-account.meta.json` | البريد، المشروع، طريقة الحماية، التاريخ |
| `secrets/local.key` | مفتاح AES-256-GCM عند غياب `safeStorage` (DPAPI) |

- التشفير المفضل: `safeStorage` (DPAPI على Windows).
- البديل: AES-256-GCM بمفتاح محلي بصلاحيات مقيدة.
- كلمة مرور المشرف: تجزئة bcrypt تكلفة 12 فقط؛ لا يمكن استرجاعها نصًا.
- الاستعادة: `recoverSupervisorPassword_` (GAS) أو زر «نسيت كلمة مرور المشرف؟»
  في شاشة دخول سطح المكتب. يُنشئ كلمة مرور مؤقتة تُعرض مرة واحدة وتُلزم بتغييرها.
- مفتاح المزامنة عشوائي 24 بايت، ويُرسل فقط لأقران الشبكة المحلية عبر UDP.
