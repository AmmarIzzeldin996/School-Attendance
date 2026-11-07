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
