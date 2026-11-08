# ف۱۲ ب۲: شماره گم‌شده بیمار، دونفره؛ و صفحه وب تغییر شماره (تصمیم مالک ۱۴۰۵/۰۷/۲۶)

**دستور مالک:** «مسیر دونفره «شماره گمشده» (2ب) و صفحه وب تغییر موبایل بیمار را بساز. مسیر دونفره با جریان 0085 (نفر اول پیشنهاد، نفر دوم تأیید، نفر اول ≠ نفر دوم در سرور)، با audit و فقط ۴ رقم آخر شماره؛ پرچم identity.patient_mobile_change خاموش بماند. آزمون، آزمون جهش و e2e بنویس؛ اگر مهاجرت لازم شد فقط فایل را بساز و خلاصه SQL را گزارش بده (اجرا نکن).»

**وضعیت:**
- ساخته و آزموده شد.
- مهاجرت **`0091_patient_mobile_change_requests`** **با تأیید مالک (۱۴۰۵/۰۷/۲۶) روی پایگاه اصلی محلی اجرا شد**، پس از تمرین روی کپی (§۶). پایگاه اصلی ۹۲ مهاجرت دارد.
- پرچم `identity.patient_mobile_change` دست نخورد: در پایگاه اصلی خاموش است. فقط در پایگاه دورریختنی e2e روشن می‌شود (seed).
- ب۱ در `task-f12-patient-mobile-change-decisions.md` است.

## ۱. جریان ب۲

| گام | مسیر | بررسی |
|---|---|---|
| کد به شماره تازه | `POST /identity/patient-mobile-changes/code` `{ currentMobile, newMobile }` | مجوز `identity.change_patient_mobile`؛ پرچم روشن (`feature_disabled`)؛ حساب بیمار فعال با آن شماره (`patient_not_found`)؛ شماره دیگر (`same_mobile`)؛ شماره تازه مال بیمار دیگری نباشد (`mobile_taken`)؛ سقف هر کارمند در ساعت (۴۲۹)؛ سپس کد با همه محدودیت‌های کد ورود |
| پیشنهاد (نفر اول) | `POST /identity/patient-mobile-changes` `{ currentMobile, newMobile, code, reason, evidence }` | همان بررسی‌ها؛ بازاحراز R1؛ **کدی که بیمار از روی شماره تازه می‌خواند** (کد نادرست ۴۰۱ و در قفل حساب می‌شود)؛ هر حساب و هر شماره تازه فقط یک درخواست باز (`request_open`) |
| صف | `GET /identity/patient-mobile-changes` | درخواست‌های باز، فقط چهار رقم آخر هر دو شماره |
| تأیید (نفر دوم) | `POST …/{id}/approve` `{ reason }` | R1؛ پیشنهاددهنده ۴۰۳ `proposed_by_same_account`، و پایگاه داده هم رد می‌کند؛ سپس در **یک تراکنش**، گام‌های زیر |
| رد | `POST …/{id}/reject` `{ reason }` | یک‌نفره، پیشنهاددهنده هم (پس گرفتن)، مثل 0085 |

**گام‌های تراکنش تأیید:**
1. ردیف درخواست و ردیف حساب با `FOR UPDATE` خوانده می‌شوند.
2. اگر شماره ورود حساب از زمان پیشنهاد عوض شده: `patient_mobile_change_stale`. اگر شماره تازه مال بیمار دیگری شده: `mobile_taken`.
3. پورت سرنخ `PERSON_MOBILE_CHANGE.replaceLoginMobile`، همان ب۱:
   - ردیف قبلی `deleted_at` می‌گیرد؛
   - ردیف تازه `active` و `proved` با `added_via = 'mobile_change'`؛
   - audit `lead.person_mobile_replaced`.
4. `user_accounts.mobile` به شماره تازه می‌رود.
5. **همه** نشست‌های بیمار بسته می‌شوند، از جمله نشست گوشی گم‌شده.
6. اعلان `patient_mobile_changed` به شماره قبلی (R2): اگر سیم‌کارت دزدیده شده، بی‌صدا نیست.
7. درخواست `approved` می‌شود، با تأییدکننده، زمان، دلیل و شمار نشست‌های بسته.
8. audit `identity.patient_mobile_changed`:
   - قبل و بعد فقط چهار رقم آخر؛
   - `method: 'staff'`، `requestId`، `requestedBy`، `approvedBy` و `sessionsEnded`.

**دیگر audit‌ها:**
- `identity.patient_mobile_change_proposed` و `identity.patient_mobile_change_rejected`، با چهار رقم آخر.
- مدرک فقط در ردیف درخواست می‌ماند، نه در audit (قاعده ۳۰).

## ۲. تصمیم‌های ساخت (برگشت‌پذیر، ثبت‌شده)

- **جدول تازه در identity به‌جای جدول‌های 0085.**
  - پیشنهاد 0085 روی یک ردیف `pending` در `person_mobiles` است.
  - ردیف `pending` به صف عمومی «موبایل‌های در انتظار»، به پنل صاحب موبایل (راه الف) و به رد خودکار با مهلت می‌رود. یعنی کسی که گوشی گم‌شده را دارد می‌توانست آن را در پنل خودش رد یا تأیید کند.
  - ردیف `pending` حساب و شماره قبلی را هم نمی‌شناسد.
  - پس **جریان** 0085 (نفر اول با مدرک، نفر دوم غیر از او، رد یک‌نفره، قاعده در سرور و پایگاه داده) روی جدول `patient_mobile_change_requests` ساخته شد، به الگوی 0087. ماژول lead و خوانش‌های `person_mobiles` دست نخوردند.
- **کد به شماره تازه در پیشنهاد.** بی آن، یک اشتباه تایپی حساب را به غریبه می‌داد. کد فقط ثابت می‌کند تماس‌گیرنده شماره تازه را دارد. اینکه او صاحب حساب است را مدرک و نفر دوم ثابت می‌کنند.
- **یک مجوز برای هر دو گام**، مثل `lead.approve_person_mobile`. به هیچ نقشی داده نمی‌شود: مدیر سیستم نقش را می‌سازد، با ۲ دارنده (`staff-accounts-template.md`).
- **پرچم:** همان `identity.patient_mobile_change` ب۱ هر دو راه را می‌بندد. کلید تازه‌ای نیست.
- **فاصله دو تغییر** (`cooldownDays`) فقط برای ب۱ است. بازیابی شماره گم‌شده را نگه نمی‌دارد.
- **مهلت درخواست:** `TODO(decision)`. پیش‌فرض: بی مهلت. درخواست با رد بسته می‌شود. تأیید دوباره بررسی می‌کند که شماره حساب همان شماره زمان پیشنهاد است. اگر مهلت خواسته شود، کلید پیکربندی تازه با مقدار اولیه ۰ است.
- **شماره کامل** فقط در ردیف درخواست می‌ماند، مثل `user_accounts.mobile`. هیچ پاسخ، صف، صفحه یا audit شماره کامل ندارد.

## ۳. مهاجرت 0091، خلاصه کامل SQL (اعمال‌شده ۱۴۰۵/۰۷/۲۶، §۶)

فقط افزودنی: یک جدول تازه، قیدها، ایندکس‌ها، دو trigger، و یک کد مجوز که به هیچ نقشی داده نمی‌شود.

```sql
CREATE TABLE patient_mobile_change_requests (
  id uuid PK DEFAULT uuidv7(),
  target_account_id uuid NOT NULL FK user_accounts,
  from_mobile text NOT NULL, to_mobile text NOT NULL,
  requested_by uuid NOT NULL FK user_accounts,
  reason text NOT NULL, evidence text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid FK user_accounts, decided_at timestamptz, decision_reason text,
  sessions_ended integer,
  created_at, updated_at, deleted_at,
  CHECK (status IN ('pending','approved','rejected')),
  CHECK (from_mobile ~ '^9[0-9]{9}$' AND to_mobile ~ '^9[0-9]{9}$' AND from_mobile <> to_mobile),
  CHECK (length(trim(reason)) >= 3 AND length(trim(evidence)) >= 3),
  -- دونفره در پایگاه داده:
  CHECK (requested_by <> target_account_id
         AND (decided_by IS NULL OR decided_by <> target_account_id)
         AND (status <> 'approved' OR decided_by <> requested_by)),
  CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL))
);
CREATE INDEX patient_mobile_change_requests_target_idx ON … (target_account_id);
CREATE UNIQUE INDEX patient_mobile_change_requests_open_key    ON … (target_account_id) WHERE status = 'pending';
CREATE UNIQUE INDEX patient_mobile_change_requests_open_to_key ON … (to_mobile)         WHERE status = 'pending';
-- trigger BEFORE UPDATE: فقط pending تصمیم می‌گیرد؛ چه کسی، کدام شماره‌ها و چرا هرگز عوض نمی‌شوند
CREATE FUNCTION public.patient_mobile_change_requests_guard() …;
CREATE TRIGGER patient_mobile_change_requests_guard BEFORE UPDATE …;
CREATE TRIGGER patient_mobile_change_requests_set_updated_at BEFORE UPDATE … EXECUTE FUNCTION public.set_updated_at();
REVOKE DELETE ON patient_mobile_change_requests FROM sepehr_app;
INSERT INTO permissions (code) VALUES ('identity.change_patient_mobile');
```

- **قفل:** فقط جدول تازه، و یک ردیف در `permissions`. هیچ جدول موجودی قفل طولانی نمی‌گیرد و هیچ ردیف موجودی تغییر نمی‌کند.
- **پس از اجرا:** API محلی تا اجرای 0091 بالا نمی‌آید، چون کدهای مجوز `@sepehr/contracts` و جدول `permissions` باید برابر باشند (قاعده موجود). Testcontainers و e2e آن را در هر اجرا می‌سازند.
- `0091_snapshot.json` و `_journal.json` همراه مهاجرت‌اند.

## ۴. آزمون

**`apps/api/test/identity/patient-mobile-staff.int.test.ts` (۷ آزمون):**
1. **خاموش، بی مجوز و بیمار:**
   - پرچم خاموش `feature_disabled`.
   - کارمند بی مجوز و بیمار روی هر چهار مسیر ۴۰۳ می‌گیرند.
2. **جریان کامل:**
   - کد نادرست درخواستی نمی‌سازد.
   - پیشنهاد `pending` است، و در حین انتظار بیمار همچنان وارد است.
   - صف و پاسخ‌ها شماره کامل ندارند.
   - پیشنهاددهنده ۴۰۳ می‌گیرد.
   - نفر دوم تأیید می‌کند:
     - حساب و شخص با هم جابه‌جا می‌شوند (ردیف قبلی حذف منطقی، تازه `active` و `proved` و `mobile_change`)؛
     - هر دو نشست (گوشی گم‌شده و بیمار) ۴۰۱ می‌شوند؛
     - اعلان به شماره قبلی می‌رود؛
     - رضایت منتقل نمی‌شود؛
     - دو audit با دو بازیگر ثبت می‌شود، و هیچ audit شخص و حساب شماره کامل ندارد.
   - تأیید دوباره `already_decided` است.
   - شماره تازه همان حساب و شخص را باز می‌کند. شماره قبلی حساب و شخص تازه می‌گیرد.
3. **ناشناخته، گرفته و باز:**
   - `patient_not_found`، `mobile_taken` و `same_mobile`.
   - شناسه ناشناخته ۴۰۴.
   - درخواست دوم برای همان حساب یا همان شماره تازه `request_open`.
   - شماره تازه‌ای که در حین انتظار مال دیگری شده، در تأیید `mobile_taken` می‌گیرد.
4. **کهنه:** بیمار در حین انتظار خودش (ب۱) شماره را عوض می‌کند. تأیید `patient_mobile_change_stale` می‌گیرد و چیزی عوض نمی‌شود.
5. **رد:**
   - یک‌نفره، پیشنهاددهنده هم.
   - چیزی عوض نمی‌شود و نشست می‌ماند.
   - تصمیم نهایی است. پس از رد، پیشنهاد تازه ممکن است.
6. **پایگاه داده** (`sepehr_app`):
   - تأیید به‌دست پیشنهاددهنده: `two_people_check`.
   - تغییر شماره درخواست: guard.
   - `DELETE`: `permission denied`.
   - بازگرداندن درخواست تصمیم‌گرفته: guard.
7. **سقف:** ۸ کد در ساعت برای هر کارمند، و نهمی ۴۲۹.

**جهش‌ها (هر هشت قرمز، فایل‌ها با `cp` برگردانده شدند و `cmp` برابر):**

| جهش | نتیجه |
|---|---|
| حذف بررسی پیشنهاددهنده در سرور | ۱ قرمز |
| حذف بند دونفره از قید پایگاه داده (فایل 0091) | ۱ قرمز |
| نبستن نشست‌های بیمار | قرمز |
| حذف اعلان | ۱ قرمز |
| حذف بررسی کهنگی | ۱ قرمز |
| حذف بررسی کد | ۱ قرمز |
| حذف سقف هر کارمند | ۱ قرمز |
| بی‌اثر کردن پرچم | ۱ قرمز |

**e2e:** `apps/e2e/tests/patient-mobile-change.spec.ts`.
- **ب۱:** بیمار در `/me/mobile` شماره را با کد عوض می‌کند و با شماره تازه وارد همان حساب می‌شود.
- **ب۲:**
  - دو کارمند در پنل `/patient-mobile-changes`: نفر اول با کد و مدرک، و نفر دوم تأیید می‌کند.
  - پیشنهاددهنده دکمه تأیید ندارد، و صفحه شماره کامل ندارد.
  - نشست بیمار ۴۰۱ می‌شود، و شماره تازه همان حساب را باز می‌کند.

## ۵. صفحه‌ها (منتظر تأیید بصری مالک)

- **وب بیمار:**
  - صفحه `/me/mobile` با سه گام: شماره تازه، کد، و پایان (چهار رقم آخر و شمار دستگاه‌های بسته).
  - در سربرگ پیوند «شماره موبایل» افزوده شد.
  - متن صفحه می‌گوید رضایت تبلیغاتی منتقل نمی‌شود و گوشی گم‌شده کار پشتیبانی است.
- **پنل داخلی:**
  - صفحه `/patient-mobile-changes`: فرم نفر اول، و صف «در انتظار نفر دوم» (چهار رقم آخر، مدرک، دلیل، پیشنهاددهنده).
  - برای پیشنهاددهنده دکمه «پس گرفتن» هست، و برای دیگران «تأیید نفر دوم» و «رد».
  - در فهرست پنل، مورد «تغییر شماره بیمار» برای دارنده مجوز افزوده شد.
- **تصاویر:** `D:\sepehr-backup\shots\2026-10-17` (بیرون از مخزن)، با `apps/e2e/tests/visual-owner-1405-07-26.spec.ts` و `VISUAL=1`.

## ۶. اجرای 0091 (تأیید مالک ۱۴۰۵/۰۷/۲۶)

- **pg_dump تازه:** `D:\sepehr_app\db-backups\sepehr-before-0091-run-20261017-161627.dump`، ۱٬۳۶۰٬۴۷۳ بایت. `pg_restore --list` بی‌خطا (۲۸۱۴ سطر). پیش از اجرا ۹۱ مهاجرت.
- **تمرین روی کپی** (پایگاه موقت `sepehr_rehearsal_0091`):
  - restore با `--exit-on-error` بی‌خطا.
  - grantهای سطح database را `pg_dump` ندارد (یافته دور چهارم، سند ۱۹ §۱۰-۲). migrator بار اول با `CREATE SCHEMA IF NOT EXISTS "drizzle"` خطا داد و هیچ چیز اعمال نشد. پس همان grantهای پایگاه اصلی دوباره داده شد: `CREATE, TEMPORARY, CONNECT` به `sepehr_owner`، و `CONNECT` به `sepehr_app` و `sepehr_report`.
  - اجرای 0091 با `migrations applied`: **۹۱ به ۹۲**.
  - بررسی ساختار:
    - ۹ قید، همه معتبر: کلید اصلی، ۳ کلید خارجی، و قیدهای status، mobiles، text، two_people و decided.
    - ۴ ایندکس: کلید اصلی، `target_idx`، و دو کلید یکتای باز (`open_key` روی حساب و `open_to_key` روی شماره تازه).
    - ۲ trigger: `guard` و `set_updated_at`.
    - `sepehr_app` فقط `INSERT, SELECT, UPDATE` دارد و `DELETE` ندارد.
    - مجوز `identity.change_patient_mobile` با ۰ نقش. جدول خالی است. پرچم خاموش است: `{"enabled": false, "cooldownDays": 0, "recentLoginSeconds": 600}`.
  - بررسی رفتار با نقش `sepehr_app`، در یک تراکنش و با `ROLLBACK`:
    1. پیشنهاددهنده خودش تأیید کند: رد با `two_people_check`.
    2. درخواست باز دوم روی همان حساب: رد با `open_key`.
    3. تغییر شماره تازه: رد با guard («who, which mobiles and why do not change»).
    4. `DELETE`: `permission denied`.
    5. تأیید با نفر دیگر پذیرفته شد. پس از آن هر تغییری رد شد («a decided request does not change»).
    - پس از `ROLLBACK`، ۰ ردیف ماند.
  - پایگاه موقت حذف شد.
- **اجرا روی پایگاه اصلی:** `pnpm --filter @sepehr/api build` و `db:migrate`، با خروجی `migrations applied`. **۹۱ به ۹۲ مهاجرت.** همان بررسی ساختار، با همان نتیجه. پرچم **خاموش** ماند.
- **journal و snapshot:** `_journal.json` و `0091_snapshot.json` همان commit `ae3b026` هستند و بی تغییر. **drift پاک** (`Schema and migrations are in sync.`).
- **چک‌لیست راه‌اندازی:** بند ۱۳ RESUME آمد: نقش جدا «تغییر شماره بیمار» برای ۲ تا ۳ نفر نام‌دار، هرگز مشاور یا پشتیبانی، و روشن کردن پرچم دونفره. `ops:launch-check` بند ۱۳ را می‌سنجد:
  - **FAIL:** دارنده‌ای که مشاور یا پشتیبانی هم باشد، یا پرچم روشن با کمتر از ۲ دارنده.
  - **PASS:** ۲ یا ۳ دارنده.
  - **WARN:** باقی حالت‌ها.
  - آزمون تازه در `test/ops/launch-check.int.test.ts`.
  - **جهش، هر ۴ قرمز:**
    1. «مشاور یا پشتیبانی نادیده»
    2. «یک دارنده بس است»
    3. «بی سقف ۳»
    4. «پرچم نادیده»
- **آزمون‌های مرتبط پس از اجرا:**
  - integration ماژول‌های `identity`، `lead`، `config`، `ops` و `db`، به‌علاوه `search-analytics`: ۲۲ از ۲۲ فایل، ۲۳۴ سبز.
  - api واحد: ۲۴ از ۲۴، ۱۳۶ سبز.
  - اجرای اول این آزمون‌ها هیچ آزمونی را اجرا نکرد، چون موتور Docker پاسخ نمی‌داد (`Could not find a working container runtime strategy`؛ ۲۲ فایل در راه‌اندازی شکستند و ۲۳۴ آزمون skip شدند). Docker Desktop دوباره راه‌اندازی شد. پس از آن، پایگاه اصلی همان ۹۲ مهاجرت را داشت و پرچم خاموش بود، و اجرای دوم سبز شد.
  - لاگ‌ها: `D:{B}sepehr-backup{B}load10-logs{B}related-0091`.

## ۷. مهلت درخواست ب۲: ۷ روز (تصمیم مالک ۱۴۰۵/۰۷/۲۷، بند ۱۴)

- **پیکربندی:** `identity.patient_mobile_change.staffRequestDays`، پیش‌فرض ۷، و ۰ یعنی بی مهلت. ردیف موجود این فیلد را ندارد، پس پیش‌فرض ۷ به کار می‌رود و داده‌ای تغییر نمی‌کند.
- **مهلت بر پایه مقدار زمان پیشنهاد است** (قاعده ۱۶)، نه مقدار امروز.
- **روش، مثل بازنشانی TOTP و تنبل:**
  - تأیید یا رد درخواستِ گذشته‌ازمهلت، «منقضی» را ثبت و commit می‌کند و پاسخ ۴۱۰ (`request_expired`) می‌دهد.
  - صف آن را نشان نمی‌دهد، بی نوشتن.
  - پیشنهاد تازه برای همان حساب یا همان شماره تازه، درخواستِ گذشته‌ازمهلت را اول منقضی می‌کند تا کلید باز آن مانع نشود.
  - زمان انقضا `created_at + ۷ روز` است، نه زمان دیدن.
  - audit: `identity.patient_mobile_change_expired`، فقط با چهار رقم آخر.
- **مهاجرت 0092، خلاصه SQL (پیش از اجرا):** فقط قید وضعیت یک مقدار تازه می‌گیرد. هیچ ردیف موجودی نامعتبر نمی‌شود و چیز دیگری تغییر نمی‌کند.
  ```sql
  ALTER TABLE "patient_mobile_change_requests" DROP CONSTRAINT "patient_mobile_change_requests_status_check";
  ALTER TABLE "patient_mobile_change_requests" ADD CONSTRAINT "patient_mobile_change_requests_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'));
  ```
  - قید «تصمیم‌گرفته» با «منقضی» سازگار است: `decided_by` تهی است و `decided_at` پر.
  - trigger نگهبان فقط از «در انتظار» گذر می‌دهد، پس «منقضی» هم دیگر تغییر نمی‌کند.
- **آزمون:** ۳ آزمون تازه در `patient-mobile-staff.int.test.ts`؛ فایل ۱۰ از ۱۰.
- **جهش، هر ۵ قرمز:**
  1. «تصمیم بی توجه به مهلت»
  2. «پیکربندی امروز به‌جای زمان پیشنهاد»
  3. «صف با منقضی‌ها»
  4. «پیشنهاد بی منقضی کردن»
  5. «زمان انقضا = زمان دیدن»
