# صفحات OAuth (وصف التطبيق + سياسة الخصوصية)

ملفان ثابتان بلا سكربتات ولا موارد خارجية، جاهزان للرفع على أي استضافة:

- `index.html` — صفحة التعريف بالتطبيق (تُستخدم كـ Homepage URL).
- `privacy.html` — سياسة الخصوصية (تُستخدم كـ Privacy policy URL).

قبل النشر: بدّل بريد التواصل `klodi.mk9000@gmail.com` في الملفين إن لزم.

## النشر على GitHub Pages (مجانًا)

1. أنشئ مستودعًا **عامًا** جديدًا باسم `school-attendance-site`.
2. ارفع الملفين في جذر المستودع (`index.html` و`privacy.html`).
3. Settings ← Pages ← Source: **Deploy from a branch** ← Branch: `main` / `/ (root)` ← Save.
4. سيصبح الموقع على `https://<username>.github.io/school-attendance-site/`.

## لماذا تحتاج نطاقًا خاصًا؟

Google يرفض إضافة `github.io` إلى **Authorized domains** لأنه نطاق عام مشترك (public suffix)،
ولا يقبل توثيقه. لذلك لن يفعّل زر «Publish app» مع رابط GitHub المجاني وحده.

الحل الموثوق: نطاق خاص (‏`.com` مثلًا، نحو 40–60 ريالًا سنويًا) مربوط بـ GitHub Pages.

## ربط النطاق (مثال `school-attendance.com`)

1. في GitHub Pages ← Custom domain اكتب `www.school-attendance.com` ثم Save.
2. عند مسجّل النطاق أضف:
   - `CNAME` للاسم `www` إلى `<username>.github.io`.
   - سجلات `A` للجذر `@` إلى: `185.199.108.153`، `185.199.109.153`، `185.199.110.153`، `185.199.111.153`.
3. انتظر انتشار DNS ثم فعّل **Enforce HTTPS** في GitHub Pages.
4. في [Google Search Console](https://search.google.com/search-console) أضف خاصية
   **Domain** للنطاق، ووثّقها بسجل `TXT` يعطيك إياه Google.

## إعداد Branding في Google Cloud

1. Homepage URL: `https://www.school-attendance.com/`
2. Privacy policy URL: `https://www.school-attendance.com/privacy.html`
3. Authorized domains: `school-attendance.com`
4. Save، ثم Audience ← **Publish app**.

## بديل مؤقت بلا نطاق

يمكن تجاهل النشر: الربط يعمل في وضع Testing، لكن Google تُبطل رمز التحديث بعد ~7 أيام،
فتُعيد «ربط حساب Google» من لوحة سطح المكتب. النسخ المحلي والجدول المقروء لا يتأثران.
