# م۱ §۷، ت۱ و ت۳ [مالی]: قفل جابه‌جایی سررسید و روزهای مهلت روی پرونده، نقشه

> **وضعیت:** **تأیید شد (مالک ۱۴۰۵/۰۷/۲۲)** با یک تغییر: ردیف‌های موجود `NULL` نمی‌مانند (§۸). ADR-041 پذیرفته. کد، آزمون‌ها و فایل مهاجرت `0084_application_schedule_versions` ساخته شد؛ **مهاجرت با تأیید مالک اجرا شد (۱۴۰۵/۰۷/۲۲، §۹).**
> نوشته‌شده ۱۴۰۵/۰۷/۲۲ (۲۰۲۶-۱۰-۱۴). دستور مالک: «قفل روی پرونده برای جابه‌جایی سررسید و روزهای مهلت؛ تعطیلات و آخر هفته جاری بمانند» (ت۲ بسته شد، `b7b9b05`).
> الگو: م۱ و ADR-039 (`go-live-m1-rounding-version-plan.md`).

## ۱. دقیقاً چه چیزی اشتباه است

- `RepaymentService.createSchedule` دو مقدار را **از پیکربندی در `funded_at`** می‌خواند، نه از نسخه‌ای که پرونده هنگام ایجاد دیده است:
  - **ت۱:** `repayment.shift_due_to_next_working_day` (`repayment.service.ts:221-225`، `config.resolve(…, fundedAt)`). شناسه نسخه روی `installment_schedules.shift_config_version_id` نوشته می‌شود.
  - **ت۳:** `repayment.grace_days` (`repayment.service.ts:229`، `config.resolve(…, fundedAt)`). مقدار و شناسه روی `installment_schedule_terms` (`grace_days`، `grace_config_version_id`) نوشته می‌شود.
- اگر یکی بین ایجاد پرونده و شارژ عوض شود، برنامه با شرایطی که پرونده با آن ساخته شده فرق می‌کند (قاعده ۱۶).
- **ت۲ (تعطیلات و آخر هفته):** به دستور مالک **جاری می‌ماند**، یعنی تقویم زمان شارژ (`repayment.service.ts:245-256`). این نقشه به آن دست نمی‌زند.
- **پس از ساخت برنامه** هیچ‌کدام دیگر از پیکربندی خوانده نمی‌شود: سررسیدها ذخیره‌اند و `graceOf` (`repayment.service.ts:1167`) و پرس‌وجوهای وضعیت (`:848`، `:950`، `:1069`) مهلت را از `installment_schedule_terms` می‌خوانند. این خوانش‌ها **تغییر نمی‌کنند**.

## ۲. لحظه قفل (همان ADR-039)

- **ایجاد پرونده اعتباری** (`CreditApplicationService.insert`). همه مسیرهای ایجاد (یک بیمار، گروه، کسری بزرگ) از آن می‌گذرند.
- **پیش‌نمایش `planOptions` قفل نمی‌شود**، مثل واحد گرد کردن. همان `TODO(decision)` م۱ §۸.۷ (برچسب «تقریبی») پوشش می‌دهد.

## ۳. تغییرها

### ۳.۱ مهاجرت (شماره آزاد بعدی از مخزن)

- **شماره:** آخرین مهاجرت در مخزن پس از R4، `0083_financial_key_forms` است (ساخته شده، اجرا نشده). پس شماره آزاد بعدی **`0084`**؛ نام پیشنهادی `0084_application_schedule_versions`. هنگام ساخت دوباره از مخزن خوانده می‌شود.
- **نوع:** فقط‌افزودنی روی جدول `credit_applications` (ماژول credit، پیرامون مالی)، پس طبق بند ۴ با پرسش اجرا می‌شود.
- **خلاصه SQL پیشنهادی:**
  1. `ALTER TABLE credit_applications ADD COLUMN shift_version_id uuid, ADD COLUMN grace_version_id uuid;` (nullable، برای ردیف‌های موجود؛ §۴).
  2. دو FK به `config_values(id)` با `ON DELETE RESTRICT`، به شکل `NOT VALID` سپس `VALIDATE`، مثل `0082`.
  3. **trigger تازه** `credit_applications_lock_schedule_versions` (BEFORE INSERT OR UPDATE):
     - در INSERT: هر دو ستون الزامی‌اند (پرونده تازه بی قفل ساخته نمی‌شود).
     - در UPDATE: هر دو ستون تغییرناپذیرند.
     - نگهبان موجود `credit_applications_guard_change` (`0024`) **دست نمی‌خورد**؛ فهرست ستون‌هایش ثابت است و این دو را نمی‌بیند، و trigger تازه جای آن را می‌گیرد.
  4. نقش برنامه حق UPDATE این دو ستون را نمی‌گیرد (`0024` UPDATE را گرفته و فقط ستون‌های وضعیت را داده است).
- **دست نمی‌خورد:** `installment_schedules`، `installment_schedule_terms`، جدول‌های دفتر کل و هر ستون موجود.

### ۳.۲ کد [مالی]، بی تغییر فرمول

| فایل | تغییر |
|---|---|
| `credit/credit-plan.service.ts` | `QuoteVersions` دو شناسه تازه می‌گیرد: `shiftVersionId` و `graceVersionId`. بی `versions` با `config.resolve(…, at)` خوانده می‌شوند؛ با `versions` با `getVersion`. در محاسبه پیش‌نمایش اثری ندارند. |
| `credit/credit.schema.ts` | دو ستون nullable. |
| `credit/credit-application.service.ts` (`insert`، حدود `:639`) | دو شناسه را می‌نویسد. |
| `common/credit/credit-contract-facts.port.ts` و `credit/credit-contract-facts.adapter.ts` (`:129`) | `shiftVersionId: string \| null` و `graceVersionId: string \| null`. |
| `common/repayment/repayment.port.ts` (`createSchedule`) | ورودی دو فیلد تازه: `shiftConfigVersionId` و `graceConfigVersionId`، هر کدام `string \| null`. |
| `wallet/funding.service.ts` (حدود `:247`) | دو شناسه را از facts به `createSchedule` می‌دهد. |
| `repayment/repayment.service.ts:221-229` | **تنها خوانش‌هایی که تغییر می‌کنند:** با شناسه، `config.getVersion(key, id)`؛ بی شناسه (فقط ردیف‌های پیش از `0084`) طبق گزینه §۴. همان شناسه مثل امروز روی `shift_config_version_id` و `grace_config_version_id` نوشته می‌شود. |

- **دست نمی‌خورد:** قاعده روز سررسید، `nextWorkingDay`، تقویم تعطیلات (ت۲)، `graceOf` و پرس‌وجوهای وضعیت، تخصیص، دفتر کل و حفاظ `schedule_differs_from_contract`.
- `credit-decision.service.ts:540` فقط مبلغ‌ها را از نو حساب می‌کند و به این دو نیاز ندارد؛ دست نمی‌خورد.

## ۴. مقدار پیش‌فرض ردیف‌های موجود

- **داده محلی (۱۴۰۵/۰۷/۲۲، فقط‌خواندنی):** ۷ پرونده؛ ۳ برنامه اقساط دارند و دیگر از پیکربندی نمی‌خوانند (تحت تأثیر نیستند)؛ ۴ هنوز شارژ نشده‌اند.

| گزینه | رفتار ردیف موجود | داده |
|---|---|---|
| **(الف) پیشنهادی** | `NULL` می‌ماند، و `createSchedule` برای `NULL` همان رفتار امروز را دارد: نسخه زمان شارژ. | هیچ UPDATE؛ کاملاً برگشت‌پذیر. |
| (ب) | backfill با نسخه‌ای که در `created_at` هر پرونده جاری بوده. | UPDATE روی `credit_applications` (از راه trigger تازه، فقط یک‌بار در مهاجرت). |
| (ج) | `NULL` پذیرفته نمی‌شود؛ شارژ پرونده قدیمی رد می‌شود. | هیچ UPDATE؛ ولی پرونده‌های در جریان گیر می‌کنند. |

- **چرا (الف):** امروز فقط یک نسخه از هر دو کلید هست، پس نسخه زمان ایجاد و زمان شارژ یکی‌اند و نتیجه (الف) و (ب) برای داده موجود یکسان است، بی هیچ نوشتنی.
  - پس از `0084` هر پرونده تازه قفل دارد (trigger INSERT)، پس `NULL` فقط برای ردیف‌های قدیمی می‌ماند.

## ۵. آزمون‌ها (ادعاها ضعیف نمی‌شوند)

1. **قفل:** پرونده با نسخه ۱ ساخته می‌شود؛ پیش از شارژ `repayment.shift_due_to_next_working_day` و `repayment.grace_days` نسخه تازه می‌گیرند؛ برنامه با نسخه ۱ ساخته می‌شود:
   - `shift_config_version_id` و `grace_config_version_id` همان نسخه پرونده‌اند؛
   - `grace_days` همان مقدار نسخه ۱؛
   - سررسیدها همان‌اند که با نسخه ۱ جابه‌جا می‌شدند.
2. **تعطیلات جاری (ت۲):** تعطیلی تازه‌ای که پس از ایجاد پرونده و پیش از شارژ افزوده شود، با جابه‌جایی روشن، سررسید را جابه‌جا می‌کند (رفتار امروز، ثابت می‌ماند).
3. **ردیف قدیمی (`NULL`):** همان رفتار امروز (گزینه الف).
4. **پایگاه داده:**
   - INSERT پرونده بی این دو شناسه رد می‌شود؛
   - UPDATE هر کدام رد می‌شود، با نقش برنامه (`42501`) و با مالک (trigger)؛
   - حذف نسخه ارجاع‌شده رد می‌شود (FK).
5. **همه مسیرهای ایجاد** (یک بیمار، گروه، کسری بزرگ) هر دو شناسه را می‌نویسند.
6. **بی‌تغییری:** آزمون‌های موجود اقساط، بازپرداخت، تأمین کیف و اعتبار بی تغییر ادعا سبز؛ `sum(installments) === total` و آزمون‌های سررسید سند ۰۲ §۸ (۴ و ۵).

## ۶. سند ۰۲ و ADR

- **دفتر کل:** هیچ حساب، سطر یا نوع سند تازه. مبلغ قسط تغییر نمی‌کند؛ فقط کدام نسخه تاریخ جابه‌جایی و مهلت را می‌دهد.
- **سند ۰۲ §۵ («قاعده روز سررسید»):** یک جمله لازم است، مثل ADR-039: «پیکربندی جابه‌جایی سررسید و روزهای مهلت از نسخه‌ای خوانده می‌شوند که پرونده هنگام ایجاد قفل کرده است؛ تقویم تعطیلات همان تقویم زمان شارژ است.» فقط همراه کد و در همان commit.
- **ADR:** لازم است. پیشنهاد: **ADR-041** «قفل جابه‌جایی سررسید و روزهای مهلت روی پرونده»، یا گسترش ADR-039. پیشنهاد: ADR تازه، تا ADR-039 پذیرفته‌شده دست نخورد.

## ۷. سؤال‌های باز برای مالک

| # | سؤال | پیشنهاد |
|---|---|---|
| ت-س۱ | پیش‌فرض ردیف‌های موجود (§۴) | **(الف)** `NULL` با رفتار امروز |
| ت-س۲ | ADR تازه یا گسترش ADR-039 | **ADR-041 تازه** |
| ت-س۳ | اجرای `0084` محلی پس از تأیید (فقط‌افزودنی، روی جدول credit) | با خلاصه SQL و `pg_dump` پیش از آن، مثل `0082` |

## ۸. تأیید مالک و ساخت (۱۴۰۵/۰۷/۲۲)

- **تغییر نسبت به §۴:** گزینه (ب)، backfill. هر ردیف موجود نسخه‌ای را می‌گیرد که در `created_at` آن جاری بوده؛ اگر نبوده، قدیمی‌ترین نسخه موجود.
  - **پیش‌نمایش فقط‌خواندنی روی پایگاه محلی:** ۷ پرونده، و برای همه نسخه‌ای در `created_at` هست (نسخه ۲۰۲۰-۰۱-۰۱). حالت «قدیمی‌ترین نسخه» **۰ بار**.
- **ADR-041 پذیرفته؛ جمله سند ۰۲ §۵ افزوده شد.**
- **شماره مهاجرت از مخزن:** پس از `0083_financial_key_forms`، شماره آزاد **`0084`**.
- **ترتیب `0084` (دستور مالک)، همه در یک تراکنش:**
  1. دو ستون nullable: `shift_version_id`، `grace_version_id`.
  2. backfill با همان قاعده `ConfigService.resolve` (global، approved، حذف‌نشده، آخرین `effective_at` تا `created_at`، سپس `decided_at` و `id`)؛ در نبود آن، قدیمی‌ترین نسخه.
  3. `SET NOT NULL` برای هر دو. اگر کلیدی هیچ نسخه‌ای نداشته باشد، همین گام مهاجرت را متوقف می‌کند.
  4. دو FK به `config_values(id)` با `ON DELETE RESTRICT`، `NOT VALID` سپس `VALIDATE` (مثل `0082`).
  5. trigger تازه `credit_applications_schedule_versions_locked` (BEFORE UPDATE): تغییر هر کدام رد می‌شود، با مالک هم. نقش برنامه حق UPDATE این دو ستون را اصلاً ندارد.
  - **پیامد backfill:** trigger `set_updated_at` ستون `updated_at` هر ۷ ردیف را جابه‌جا می‌کند. نگهبان‌های موجود می‌گذارند (این دو ستون در فهرستشان نیست و وضعیتی عوض نمی‌شود).
- **کد:** `QuoteVersions` دو شناسه تازه دارد. `insert` و مسیر تصمیم آن‌ها را می‌نویسند و می‌دهند. facts و `RepaymentPort.createSchedule` دو فیلد الزامی گرفتند. `repayment.service.ts` با `getVersion` می‌خواند. `funding.service.ts` آن‌ها را می‌دهد.
- **آزمون‌های تغییرکرده (فقط ورودی، بی تغییر ادعا):** ۱۰ فراخوانی مستقیم `createSchedule` در ۶ فایل (`holidays`، `reconciliation`، `bank-statements`، `cycle`، `receipts`، `repayment`) اکنون `...(await scheduleVersionsNow(h))` می‌دهند. آزمون `funding.int.test.ts` «ADR-039: … rounding version» دو شناسه معتبر تازه می‌گیرد تا همچنان فقط نبود نسخه گرد کردن را بسنجد.
- **آزمون تازه:** `test/repayment/schedule-versions.int.test.ts` (قفل در شارژ پس از تغییر هر دو، پرونده تازه نسخه تازه را قفل می‌کند، NOT NULL، trigger، نقش برنامه، FK، ورودی الزامی).
- **ثابت‌نشده:** مسیر backfill در پایگاه‌های آزمون اجرا نمی‌شود، چون آن‌ها پیش از `0084` پرونده‌ای ندارند. تنها شاهد، پیش‌نمایش فقط‌خواندنی بالاست. dry-run روی یک نسخه دورریختنی از dump فقط با اجازه مالک.

## ۹. اجرای `0084` (تأیید مالک ۱۴۰۵/۰۷/۲۲)

- **پشتیبان:** `D:\sepehr_app\db-backups\sepehr-before-0084-20261014-144955.dump` (`pg_restore --list` بی‌خطا، ۲۷۷۹ سطر).
- **تمرین روی کپی (الف)**، همان dump در پایگاه موقت، SQL با `SET ROLE sepehr_owner` در یک تراکنش:
  - هر ۷ ردیف هر دو ستون را دارند (`is_nullable = NO`)، و جفت نسخه هر ردیف با قاعده resolve در `created_at` برابر است (۷ از ۷، جدول ردیف‌به‌ردیف در گزارش).
  - دو FK `convalidated = t` با `ON DELETE RESTRICT`.
  - UPDATE هر یک از دو ستون با نقش مالک: «the schedule versions of credit application … are locked». با `sepehr_app`: «permission denied». UPDATE ستون دیگر با مالک: پذیرفته.
  - INSERT بی دو نسخه: `null value in column "shift_version_id" … violates not-null constraint`.
- **تمرین روی کپی (ب):** همه نسخه‌های `repayment.shift_due_to_next_working_day` در کپی حذف منطقی شدند (تنها راه اینکه ردیفی هیچ نسخه‌ای نیابد، چون backfill به قدیمی‌ترین نسخه برمی‌گردد). مهاجرت با `column "shift_version_id" … contains null values` متوقف شد. کل آن rollback شد: نه ستون، نه تابع، نه FK؛ ۷ ردیف و ۸۴ مهاجرت.
- هر دو پایگاه موقت حذف شدند.
- **اجرای اصلی:** `pnpm build` و `pnpm db:migrate`. **۸۵ مهاجرت**؛ ۷ ردیف و ۰ خالی؛ دو FK validated؛ trigger هست؛ همان برابری ۷ از ۷ روی پایگاه اصلی. **drift پاک.** journal و snapshot همان `e9f2641`.
- **آزمون‌ها پس از آن:** `credit`، `repayment`، `instrument` و `ledger`: ۲۴ از ۲۴ فایل، ۱۴۹ سبز. لاگ: `D:\sepehr-backup\load10-logs\t1t3\after-0084.log`.
