# ف۱۲: تغییر موبایل بیمار، گزینه «ب» (تصمیم مالک ۱۴۰۵/۰۷/۲۶)

**دستور مالک:** «گزینه «ب» (OTP روی شماره تازه + اعلان به شماره قبلی) تأیید شد، با محدودیت تعداد و زمان OTP و لاگین فعال؛ رضایت تبلیغاتی منتقل نشود. کد را بساز ولی مهاجرت 0091 را اجرا نکن.»

**وضعیت:**
- کد و مهاجرت ساخته شدند.
- مهاجرت **`0090_patient_mobile_change`** (در نقشه «0091» آمده بود؛ شماره واقعی 0090 است) **با تأیید مالک (۱۴۰۵/۰۷/۲۶) روی پایگاه اصلی محلی اجرا شد** (§۵). پایگاه اصلی ۹۱ مهاجرت دارد.
- پرچم `identity.patient_mobile_change` در مهاجرت خاموش است. پس حتی پس از اجرا، تا روشن شدن دونفره هیچ بیماری شماره را عوض نمی‌کند.
- نقشه: `task-plans-1405-07-25.md` §۳.

## ۱. جریان (ب۱)

| گام | مسیر | بررسی |
|---|---|---|
| درخواست کد | `POST /me/mobile/request` `{ mobile }` | فقط نشست بیمار (`patients_only`)؛ پرچم روشن (`feature_disabled`)؛ ورود فعال: نشست در `recentLoginSeconds` اخیر وارد شده باشد (`recent_login_required`)؛ فاصله از تغییر قبلی (`mobile_change_too_soon`)؛ شماره دیگر (`same_mobile`)؛ سقف کد هر حساب در ساعت (۴۲۹)؛ سپس کد به شماره تازه، با همه محدودیت‌های کد ورود |
| تأیید | `POST /me/mobile/verify` `{ mobile, code }` | همان بررسی‌ها؛ کد نادرست ۴۰۱ و در قفل حساب می‌شود؛ ششمین کد نادرست قفل (۴۲۹)؛ سپس در **یک تراکنش**، گام‌های زیر |

**گام‌های تراکنش تأیید:**
1. ردیف حساب با `FOR UPDATE` خوانده می‌شود.
2. اگر شماره ورود حساب بیمار دیگری است: `mobile_taken`.
3. پورت سرنخ (`PERSON_MOBILE_CHANGE`):
   - قفل advisory هر دو شماره، به ترتیب ثابت؛
   - اگر شماره روی شخص دیگری زنده است: `mobile_taken`، و هیچ ادغام خودکاری؛
   - اگر روی همین شخص در انتظار است: `mobile_pending`؛
   - ردیف شماره قبلی `deleted_at` می‌گیرد (سابقه می‌ماند)؛
   - ردیف تازه `active`، با `proved_at` و `added_via = 'mobile_change'`؛
   - audit `lead.person_mobile_replaced`، فقط با شناسه ردیف‌ها.
4. `user_accounts.mobile` به شماره تازه می‌رود.
5. همه نشست‌های دیگر بیمار بسته می‌شوند (`patient_mobile_changed`). نشست جاری می‌ماند.
6. اعلان `patient_mobile_changed` به **شماره قبلی** (`FactorNotices`؛ پیامک پس از commit با الگوی موجود 0080، در صورت روشن بودن `identity.factor_change_sms`).
7. audit `identity.patient_mobile_changed`، قبل و بعد فقط چهار رقم آخر (قاعده ۳۰)، به‌علاوه `method: 'self'` و شمار نشست‌های بسته.

**تصمیم‌های ساخت (برگشت‌پذیر، ثبت‌شده):**
- **«گرفته شده» فقط پس از کد گفته می‌شود.** فرم پیشگوی «این شماره ثبت‌نام کرده؟» نمی‌شود. کسی که کد شماره را دارد، صاحب آن است.
- **سقف هر حساب:** همان `identity.otp.sendsPerMobilePerHour` (امروز ۸) برای هر حساب، روی همه شماره‌ها. پس یک حساب نمی‌تواند به شماره‌های بسیار پیامک بفرستد. کلید تازه‌ای برای آن نیست.
- **«لاگین فعال»:** `recentLoginSeconds` در کلید تازه (اولیه ۶۰۰، یعنی ورود در ده دقیقه اخیر). پس داشتن شماره قبلی تازه ثابت شده است، و نشستی که مدتی باز مانده کافی نیست.
- **فاصله دو تغییر:** `cooldownDays`، اولیه ۰ (بی فاصله)، طبق قاعده عددهای کسب‌وکار. عددش پرسیده نمی‌شود.
- **کلید فنی و دونفره** (`technical`، `sensitive`) کنار دیگر کلیدهای `identity`.
- **رضایت تبلیغاتی منتقل نمی‌شود.** `sms_consents` به ازای شماره است و شماره تازه هیچ ردیفی ندارد. پیامک‌های عملیاتی از شماره فعال شخص خوانده می‌شوند.
- **پرونده‌ها، کیف و اقساط** به `person_id` بسته‌اند و دست نمی‌خورند.
- **شماره قبلی آزاد می‌شود.** دارنده بعدی آن حساب و شخص خودش را می‌گیرد و هیچ چیز از این شخص نمی‌بیند (آزمون).
- **ب۲** (شماره قبلی گم‌شده، دونفره با جریان 0085) و **صفحه وب بیمار** `/me/mobile`: ساخته شدند (تصمیم مالک ۱۴۰۵/۰۷/۲۶)، در `task-f12-b2-staff-mobile-change-decisions.md`. مهاجرت 0091 اجرانشده.

## ۲. مهاجرت 0090، خلاصه کامل SQL (اجرانشده روی پایگاه اصلی)

```sql
-- تغییر قید: DROP و ADD همان نام (پس طبق CLAUDE.md پرسیدنی). همه ردیف‌های موجود می‌گذرند؛ هیچ ردیفی بازنویسی نمی‌شود.
ALTER TABLE "person_mobiles" DROP CONSTRAINT "person_mobiles_added_via_check";
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_added_via_check"
  CHECK ("person_mobiles"."added_via" IN ('person_created', 'intake', 'import', 'credit_transfer', 'merge', 'mobile_change'));
-- فقط افزودنی:
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES ('identity.patient_mobile_change', 'technical', true);
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.patient_mobile_change', 'global', '{"enabled": false, "recentLoginSeconds": 600, "cooldownDays": 0}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: خاموش تا راه‌اندازی، دستور مالک ۱۴۰۵/۰۷/۲۶ (مهاجرت 0090)', now());
```

**قفل:**
- `ADD CONSTRAINT … CHECK` در یک تراکنش همه ردیف‌ها را می‌خواند، با قفل `ACCESS EXCLUSIVE` کوتاه روی `person_mobiles`.
- امروز ۱۰ ردیف محلی دارد. در production کوچک است و نیازی به `NOT VALID` نیست.

## ۳. پشتیبان و تمرین روی کپی (۱۴۰۵/۰۷/۲۵)

- **pg_dump تازه:** `D:\sepehr_app\db-backups\sepehr-before-0090-20261017-093615.dump`، ۱٬۳۶۰٬۲۶۸ بایت. `pg_restore --list` بی‌خطا (۲۸۱۴ سطر).
- **کپی:** پایگاه موقت `sepehr_rehearsal_0090` در همان سرور.
  - همان dump با مالکان اصلی؛ همان مجوزهای پایگاه اصلی (`CREATE` برای `sepehr_owner`، `CONNECT` برای دو نقش دیگر).
  - مهاجرت با **همان مهاجرگر واقعی** (`node dist/db/cli/migrate.js`، `MIGRATION_DATABASE_URL` فقط با نام پایگاه کپی) اجرا شد: `migrations applied`. کپی ۹۱ مهاجرت؛ **اصلی ۹۰ (دست‌نخورده)**.
- **بررسی‌های فقط‌خواندنی روی کپی:**
  1. قید `person_mobiles_added_via_check` با `convalidated = t` و فهرست تازه.
  2. ردیف‌ها بر اساس `added_via` در کپی و اصلی برابرند (۱۰ ردیف، همه `null` از پیش از 0081). هیچ ردیفی تغییر نکرد.
  3. کلید `identity.patient_mobile_change` با دسته `technical`، `sensitive` و مقدار `{"enabled": false, "cooldownDays": 0, "recentLoginSeconds": 600}` و وضعیت `approved`. در اصلی نیست.
  4. مجوزهای ستونی `sepehr_app` روی `person_mobiles` بی تغییر.
  5. در تراکنشی که rollback شد: درج با `mobile_change` پذیرفته شد، و درج با مقدار نادرست با `violates check constraint "person_mobiles_added_via_check"` رد شد.
  6. شمار ردیف‌های `person_mobiles`، `persons`، `user_accounts`، `cases` و `audit_events` در اصلی و کپی برابر است. `config_values` در کپی دقیقاً یکی بیشتر است.
- **پایان:** پایگاه موقت حذف شد. فقط پایگاه `sepehr` مانده است.
- **drift:**
  - `scripts/ci/db-drift.sh` (بخشی از `lint` در api)، یعنی `drizzle-kit check` و یک `generate` آزمایشی، پاک است. طرح Drizzle با مهاجرت‌ها هم‌خوان است.
  - `0090_snapshot.json` و `_journal.json` همراه مهاجرت‌اند.

## ۴. آزمون

**`apps/api/test/identity/patient-mobile-change.int.test.ts` (۶ آزمون):**
1. **خاموش و کارکنان:** پرچم خاموش `feature_disabled`؛ کارکنان `patients_only`.
2. **جریان کامل:**
   - کد نادرست یا کد شماره دیگر چیزی عوض نمی‌کند.
   - حساب و شخص با هم جابه‌جا می‌شوند: ردیف قبلی حذف منطقی، ردیف تازه `active` و `proved` و `mobile_change`.
   - `personByMobile` تازه همان شخص است و قبلی `null`.
   - نشست دیگر ۴۰۱ و نشست جاری ۲۰۰.
   - اعلان به شماره قبلی.
   - دو audit بی هیچ شماره کامل.
   - رضایت منتقل نشد.
   - ورود با شماره تازه همان حساب و شخص را باز می‌کند؛ ورود با شماره قبلی حساب و شخص تازه می‌گیرد.
3. **دو تغییر هم‌زمان یک حساب:** پشت‌سرهم اجرا می‌شوند، و در پایان یک شماره زنده برابر شماره ورود حساب است.
4. **«گرفته شده»:** درخواست کد برای شماره بیمار دیگر ۲۰۲ است (بی پیشگو)، ولی تأیید ۴۰۹. شماره روی شخصی بی حساب هم ۴۰۹. هیچ تغییری و هیچ اعلانی.
5. **سقف:** ۸ کد در ساعت برای هر حساب، و نهمی ۴۲۹. ششمین کد نادرست قفل می‌کند و پس از آن کد درست هم ۴۲۹ است.
6. **ورود فعال و فاصله دو تغییر:** ورود ۶۰۱ ثانیه پیش `recent_login_required`، و ۵۹۹ ثانیه پیش پذیرفته. با `cooldownDays = 2`: یک روز بعد `mobile_change_too_soon`، و سه روز بعد پذیرفته.

**جهش‌ها (هر شش قرمز):**
- حذف `FOR UPDATE`: آزمون هم‌زمانی قرمز.
- نبستن نشست‌های دیگر.
- حذف اعلان.
- حذف بررسی دارنده در پورت.
- بی‌اثر کردن «ورود فعال».
- حذف سقف هر حساب.

## ۵. اجرا روی پایگاه اصلی محلی (تأیید مالک ۱۴۰۵/۰۷/۲۶)

- **pg_dump تازه:** `D:\sepehr_app\db-backups\sepehr-before-0090-run-20261017-104202.dump`، ۱٬۳۶۰٬۲۶۸ بایت. `pg_restore --list` بی‌خطا (۲۸۱۴ سطر).
- **اجرا:** `pnpm --filter @sepehr/api build` و `db:migrate`، با خروجی `migrations applied`. **۹۰ به ۹۱ مهاجرت.**
- **پس از آن، فقط‌خواندنی:**
  - قید `person_mobiles_added_via_check` معتبر است (`convalidated = t`) و `mobile_change` را دارد.
  - هر ۱۰ ردیف موجود دست‌نخورده‌اند (`added_via` تهی).
  - پرچم `identity.patient_mobile_change` **خاموش** است: `{"enabled": false, "cooldownDays": 0, "recentLoginSeconds": 600}`، وضعیت `approved`.
- **journal و snapshot:** `_journal.json` و `0090_snapshot.json` همان commit `207f1f6` هستند و بی تغییر. **drift پاک** (`Schema and migrations are in sync.`).
- **آزمون‌های مرتبط پس از آن:**
  - integration ماژول‌های `identity`، `lead`، `config`، `ops` و `db`: ۲۰ از ۲۰ فایل، ۲۱۷ سبز.
  - api واحد: ۲۴ از ۲۴، ۱۳۶ سبز.
