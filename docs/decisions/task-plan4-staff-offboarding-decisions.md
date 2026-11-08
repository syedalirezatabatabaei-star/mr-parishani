# نقشه ۴: خروج کارمند (offboarding)، تصمیم‌ها و خلاصه SQL مهاجرت ۰۰۸۷

ثبت ۱۴۰۵/۰۷/۲۳ (۲۰۲۶-۱۰-۱۵). دستور مالک: «کد و فایل مهاجرت ۰۰۸۷ را بساز ولی اجرا نکن؛ خلاصه کامل SQL را در گزارش بیاور. تأیید اجرا با من. غیرفعال‌سازی حساب و پایان نشست‌ها، با audit و تغییر دونفره.»

**وضعیت:** کد و مهاجرت ساخته شدند. **۰۰۸۷ روی پایگاه اصلی محلی اجرا شد** (۱۴۰۵/۰۷/۲۴، دستور مالک)، همراه 0088، پس از پشتیبان `D:\sepehr_app\db-backups\sepehr-before-0087-0088-run-20261016-001553.dump` (`pg_restore --list` بی‌خطا، ۲۷۹۴ سطر).
- **بررسی فقط‌خواندنی:**
  - ۸۹ ردیف مهاجرت (۰۰۰۰ تا ۰۰۸۸)؛
  - جدول و دو trigger آن هست؛ `sepehr_app` حق DELETE ندارد؛
  - هر دو مجوز با `system_admin` و `ceo`؛
  - `db-drift.sh` پاک؛ `drizzle-kit generate`: «No schema changes».
- **آزمون‌ها:** `staff-offboarding`، `launch-check` و `access`، ۳ فایل، ۴۲ سبز.
- آزمون‌های integration و e2e روی Postgres موقت Testcontainers اجرا می‌شوند. هر بار همه مهاجرت‌ها، ۰۰۸۷ هم، روی همان پایگاه دورریختنی اعمال می‌شوند.
- این همان روال 0085 است.

## ۱. فرق با نقشه دور یازدهم (بند ۴ `backlog-plans-1405-07-23.md`)

| نقشه قبلی | ساخته‌شده | چرا |
|---|---|---|
| یک‌نفره، یک مجوز `identity.offboard_staff` | **دونفره**: `identity.request_staff_offboarding` و `identity.approve_staff_offboarding` | دستور مالک: «تغییر دونفره» |
| `deleted_at` روی حساب | **`status = 'disabled'`** | مالک گفت «غیرفعال‌سازی». ستون و CHECK آن از 0001 هست و ورود (`account_disabled`) و هر خواندن نشست آن را می‌سنجند، ولی تا امروز هیچ کدی آن را نمی‌نوشت. حذف منطقی لازم نشد (قاعده ۷)؛ نام کاربری آزاد نمی‌شود. |
| endpoint تکی `POST .../staff/:id/offboard` | درخواست، فهرست در انتظار، تأیید و رد | الگوی بازنشانی TOTP (`totp-reset.service.ts`) |

## ۲. رفتار

- **درخواست:** `POST /api/v1/identity/staff-offboardings`، با بدنه `{ targetAccountId, reason }` و مجوز request. شرط‌ها:
  - بازاحراز TOTP (`assertFreshMfa`، R1)؛
  - دلیل ۳ تا ۵۰۰ نویسه، یکسان‌سازی‌شده؛
  - نه خود (`403 cannot_offboard_self`)؛
  - فقط حساب `staff` یا `center`؛ بیمار یا ناموجود `404`؛
  - حساب غیرفعال `409 already_offboarded`؛
  - یک درخواست باز برای هر حساب (`409 request_open`).
- **فهرست:** `GET /api/v1/identity/staff-offboardings`، درخواست‌های در انتظار، با هر یک از دو مجوز.
- **تأیید یا رد:** `POST .../:id/approve` یا `.../:id/reject`، با مجوز approve و بازاحراز.
  - تصمیم‌گیرنده هرگز درخواست‌دهنده یا خود هدف نیست (`403 second_person_required`)، حتی اگر هر دو مجوز را داشته باشد.
  - یک بار تصمیم (`409 already_decided`).
- **تأیید، در یک تراکنش:**
  1. قفل ردیف درخواست، سپس ردیف حساب؛
  2. `status = 'disabled'`؛
  3. لغو هر نقش زنده با `AccessPort.revokeAllOf` (مرز ماژول؛ برای هر نقش یک audit `access.role_revoked` با همان دلیل)؛
  4. ثبت تصمیم و شمار نقش‌های لغوشده؛
  5. audit `identity.staff_offboarded` (قبل `active`، بعد `disabled`).
- **پس از commit:** `SessionService.revokeAll(…, 'offboarded')`. دسترسی همان لحظه commit تمام شده است، چون هر خواندن نشست `status = 'active'` را می‌خواهد. این گام ردیف‌های نشست را هم می‌بندد.
- **رد:** هیچ چیزی جز درخواست تغییر نمی‌کند؛ audit `identity.staff_offboarding_rejected`.
- **بی مهلت انقضا،** برخلاف بازنشانی TOTP: خروج فقط دسترسی را می‌گیرد. بازگشت کارمند یعنی حساب تازه.
- **`launch-check` بند ۸ (WARN):** دست‌کم یک نفر که بپرسد و نفر دیگری که تأیید کند. یک نفر با هر دو مجوز کافی نیست.

## ۳. خلاصه کامل SQL مهاجرت `0087_staff_offboarding.sql` (فقط‌افزودنی)

1. **`CREATE TABLE "staff_offboarding_requests"`:**
   - ستون‌ها:
     - `id uuid PK DEFAULT uuidv7()`؛
     - `target_account_id uuid NOT NULL`؛
     - `requested_by uuid NOT NULL`؛
     - `reason text NOT NULL`؛
     - `status text NOT NULL DEFAULT 'pending'`؛
     - `decided_by uuid`؛
     - `decided_at timestamptz`؛
     - `roles_revoked integer`؛
     - `created_at` و `updated_at timestamptz NOT NULL DEFAULT now()`؛
     - `deleted_at timestamptz`.
   - CHECKها:
     - `status_check`: `status IN ('pending','approved','rejected')`؛
     - `reason_check`: `length(trim(reason)) >= 3`؛
     - `two_people_check`: `requested_by <> target_account_id` و (`decided_by IS NULL` یا (`decided_by <> requested_by` و `decided_by <> target_account_id`))؛
     - `decided_check`: `(status = 'pending') = (decided_by IS NULL AND decided_at IS NULL)`.
2. **سه FOREIGN KEY** به `user_accounts(id)`: `target_account_id`، `requested_by` و `decided_by`.
3. **ایندکس‌ها:**
   - `staff_offboarding_requests_target_idx` روی `target_account_id`؛
   - **UNIQUE** `staff_offboarding_requests_open_key` روی `target_account_id` با `WHERE status = 'pending'`.
4. **`CREATE FUNCTION public.staff_offboarding_requests_guard()`** و trigger `BEFORE UPDATE`. خطا می‌دهد اگر:
   - ردیف دیگر `pending` نیست (تصمیم نهایی است)؛
   - `target_account_id`، `requested_by`، `reason` یا `created_at` عوض شود.
5. **trigger `staff_offboarding_requests_set_updated_at`** با `public.set_updated_at()` موجود.
6. **`REVOKE DELETE ON "staff_offboarding_requests" FROM sepehr_app`.** SELECT، INSERT و UPDATE از default privileges ۰۰۰۰ می‌آیند.
7. **`INSERT INTO "permissions" ("code")`**: `identity.request_staff_offboarding` و `identity.approve_staff_offboarding`.
8. **`INSERT INTO "role_permissions"`** (دستور مالک ۱۴۰۵/۰۷/۲۴، پیش از اجرا به فایل افزوده شد): هر دو مجوز به `system_admin` و `ceo`.
   - **نقش امنیتی وجود ندارد.** «نقش مالک» همان `ceo` (مدیرعامل) گرفته شد. `TODO(decision)` در سؤال‌های RESUME.
   - دونفره همچنان: پایگاه تصمیم درخواست‌دهنده یا هدف را رد می‌کند. یک نفر با هر دو مجوز تنها کافی نیست (`launch-check` بند ۸).

**آنچه ۰۰۸۷ دست نمی‌زند:**
- هیچ جدول موجود عوض نمی‌شود: نه `ALTER` روی `user_accounts`، نه `role_assignments`، نه `sessions`؛
- هیچ ردیف موجود عوض یا حذف نمی‌شود (فقط ردیف‌های تازه `permissions` و `role_permissions`)؛
- هیچ `DROP` یا `RENAME` نیست.

**بازگشت (اگر لازم شد، فقط با دستور):** `DROP TABLE` و `DROP FUNCTION` و حذف دو کد از `permissions`. مخرب است، پس طبق CLAUDE.md پرسیده می‌شود.

## ۴. پیامد تا اجرای ۰۰۸۷

- **API محلی روی پایگاه اصلی بالا نمی‌آید** تا ۰۰۸۷ اجرا شود. API هنگام شروع فهرست مجوزهای کد را با جدول `permissions` می‌سنجد (`packages/contracts/src/access/permissions.ts`). مثل هر مهاجرت مجوز قبلی است.
  - آزمون‌ها و e2e اثر نمی‌گیرند، چون پایگاه خودشان را می‌سازند.
- **`pnpm ops:launch-check` روی پایگاه محلی:** بند مهاجرت‌ها FAIL می‌شود (۸۷ از ۸۸) تا اجرا.

## ۵. اجرا، پس از تأیید مالک

1. `pg_dump -Fc` در `D:\sepehr_app\db-backups\` و `pg_restore --list` بی‌خطا.
2. `pnpm --filter @sepehr/api db:migrate`.
3. **بررسی فقط‌خواندنی:**
   - ۸۸ مهاجرت؛
   - جدول، دو trigger و دو کد مجوز موجودند؛
   - `drizzle-kit generate` بگوید «No schema changes»؛
   - `pnpm ops:launch-check`.
4. **ساخت نقش از پنل:** دست‌کم دو نفر، یکی درخواست و دیگری تأیید. سپس بند ۸ PASS.

## ۶. آزمون‌ها

- **`test/identity/staff-offboarding.int.test.ts`** (۵ آزمون):
  - تأیید: نشست باز ۴۰۱، ورود ۴۰۳ `account_disabled`، نقش‌ها و نشست‌ها لغو، audit سه‌گانه، هیچ حذف؛
  - رد: هیچ تغییری؛
  - دونفره: نه درخواست‌دهنده با هر دو مجوز، نه هدف، نه خود؛
  - بیمار ۴۰۴؛ بی مجوز ۴۰۳؛
  - قاعده در پایگاه: CHECK دونفره و trigger تصمیم نهایی؛
  - بازاحراز R1.
- **جهش‌ها، هر چهار قرمز:**
  - نقش‌ها لغو نشوند؛
  - حساب غیرفعال نشود؛
  - شرط نفر دوم حذف شود (پایگاه می‌گیرد، ۵۰۰ به‌جای ۴۰۳)؛
  - نشست‌ها بسته نشوند.
- **`test/ops/launch-check.int.test.ts`:** بند ۸ تازه (WARN، یک نفر با هر دو مجوز WARN، دو نفر PASS)، ۸ از ۸.
