# م۱، نسخه گرد کردن برنامه اقساط: نقشه

**وضعیت:** فقط نقشه (دستور مالک ۱۴۰۵/۰۷/۱۹). **بدون کد و بدون مهاجرت.** [مالی]: پیش از هر کد، تأیید مالک لازم است.

## ۱. دقیقاً چه چیزی اشتباه است

**فرمول درست است.** `buildInstallmentSchedule` (`packages/contracts/src/repayment/schedule.ts`) همان سند ۰۲ §۵ را اجرا می‌کند:

- `base = floor(total / n / unit) × unit`، همیشه رو به پایین.
- `installment[1] = base + (total − base × n)` و `installment[2..n] = base`.
- مجموع همیشه دقیقاً `total` است. قسط صفر هرگز ساخته نمی‌شود (`total < n × unit` رد می‌شود).
- سررسید قسط k، k ماه شمسی پس از روز واریز است و هر بار از خود روز واریز حساب می‌شود. ۳۱ام در ماه ۳۰‌روزه ۳۰ام می‌شود، و اسفند ۲۹ (۳۰ در سال کبیسه).

**نسخه پیکربندی اشتباه است (قاعده ۱۶):**

| جا | `repayment.rounding_unit_rial` را از کجا می‌خواند |
|---|---|
| پیش‌نمایش، تصمیم و قرارداد (`CreditPlanService.quote`، `credit-decision.service.ts` `quoteFor`) | نسخه **قفل‌شده روی پرونده**: `credit_applications.rounding_version_id` |
| ساخت برنامه هنگام شارژ (`RepaymentService.createSchedule`، `repayment.service.ts:221`) | `config.resolve(…, fundedAt)`: نسخه **در زمان شارژ** |

اگر واحد گرد کردن بین تصمیم یا امضای قرارداد و شارژ عوض شود، برنامه با قراردادی که بیمار امضا کرده فرق می‌کند. حفاظ موقت ۴-۵ (`funding.service.ts`، `schedule_differs_from_contract`) امروز کل شارژ را رد می‌کند. پس بیمار پول اشتباه نمی‌پردازد، ولی **پرونده سالم شارژنشدنی می‌ماند** تا کسی دستی کاری کند.

### مثال عددی (ریال، bigint)

کل تعهد `50_000_000n` ریال، ۱۲ قسط، واریز ۳۰ مهر ۱۴۰۵:

| | واحد قفل‌شده هنگام تصمیم: `10_000n` | واحد در زمان شارژ: `100_000n` |
|---|---|---|
| `base` | `4_160_000n` | `4_100_000n` |
| ته‌مانده | `80_000n` | `800_000n` |
| قسط اول | `4_240_000n` | `4_900_000n` |
| قسط‌های ۲ تا ۱۲ | `4_160_000n` | `4_100_000n` |
| مجموع | `50_000_000n` | `50_000_000n` |
| نتیجه امروز | همان قرارداد | **شارژ رد می‌شود** (`409 schedule_differs_from_contract`) |

مجموع در هر دو دقیق است. خطا این است که **کدام** برنامه ساخته می‌شود.

**مبلغ کوچک:** کل `125_000n` ریال، ۱۲ قسط.

- با واحد قفل‌شده `10_000n`: قسط اول `15_000n` و باقی `10_000n` (درست).
- با واحد `100_000n` در زمان شارژ: `125_000 < 12 × 100_000`، پس `400 total_too_small_for_count`. پرونده‌ای که قراردادش معتبر است، اصلاً شارژ نمی‌شود.

(همه اعداد با خود `buildInstallmentSchedule` محاسبه و بررسی شدند. سررسیدها: ۱۴۰۵/۸/۳۰، ۹/۳۰، ۱۰/۳۰، ۱۱/۳۰، ۱۲/۲۹، ۱۴۰۶/۱/۳۰… . واریز ۳۱ فروردین: ۲/۳۱ … ۶/۳۱، ۷/۳۰، ۸/۳۰.)

## ۲. داده تحت تأثیر تا امروز (فقط گزارش، پایگاه محلی، ۱۴۰۵/۰۷/۱۹، تراکنش فقط‌خواندنی)

| پرسش | نتیجه |
|---|---|
| نسخه‌های `repayment.rounding_unit_rial` | **۱** (مقدار اولیه `10000`) |
| برنامه‌های اقساط | ۳، هر سه با پرونده اعتباری |
| برنامه با نسخه‌ای جز نسخه قفل‌شده پرونده | **۰** |
| برنامه با واحدی جز واحد قفل‌شده | **۰** |
| برنامه‌ای که مجموع اقساطش ≠ `total_rial` | **۰** |
| برنامه‌ای که قسط اولش ≠ `base + ته‌مانده` یا باقی ≠ `base` | **۰** |
| قسط صفر یا منفی | **۰** |
| بازنگری برنامه (`installment_schedule_revisions`) | ۰ |
| درخواست شارژ | ۳، همه `approved` (هیچ ردی ثبت نشده) |

**نتیجه:** هیچ داده‌ای تحت تأثیر نیست، چون واحد گرد کردن هرگز عوض نشده است. هیچ داده‌ای تغییر نکرد، و تا تأیید مالک هم تغییر نمی‌کند.

پرس‌وجو در scratchpad جلسه است (`m1-report.sql`). در تولید هنوز داده‌ای نیست. پیش از go-live همین گزارش روی هر پایگاه داده‌ای که شارژ داشته دوباره اجرا می‌شود.

## ۳. راه‌حل در ریشه

**قاعده ثابت حفظ می‌شود:** ته‌مانده به قسط اول می‌رود و مجموع اقساط دقیقاً برابر `total_rial` برنامه است.

- `total_rial` = اصل وام مصوب، به‌علاوه کارمزد طرح وقتی زمان‌بندی‌اش `spread` است (سند ۰۲ §۳، `funding.service.ts`).
- وقتی کارمزد `at_completion` است، `total_rial` = اصل مبلغ.
- **پرسش از مالک:** در دستور آمده «مجموع اقساط دقیقاً برابر اصل مبلغ». کد امروز با کارمزد `spread` آن را در کل تعهد می‌آورد، همان‌طور که قرارداد هم می‌گوید. نقشه همین را نگه می‌دارد. اگر منظور این بود که کارمزد هرگز در اقساط نیاید، آن تغییر قاعده مالی است و جدا پرسیده می‌شود.

**قاعده سررسید هم بی‌تغییر می‌ماند:** ۳۱ام → آخرین روز ماه کوتاه‌تر، و هر قسط از روز واریز.

**تغییرها** (پس از تأیید؛ بی مهاجرت، چون ستون `installment_schedules.rounding_config_version_id` از قبل هست):

1. **درگاه `RepaymentPort.createSchedule`:** ورودی تازه و **اجباری** `roundingConfigVersionId`.
   - `createSchedule` واحد را با `config.getVersion('repayment.rounding_unit_rial', roundingConfigVersionId)` می‌خواند، نه `resolve(…, fundedAt)`.
   - همان شناسه در `rounding_config_version_id` ذخیره می‌شود.
   - بی آن ورودی، فراخوانی رد می‌شود (fail closed). هیچ مسیری بی‌صدا به «نسخه امروز» برنمی‌گردد.
2. **`CreditContractFacts`:** `roundingVersionId` پرونده را بیرون می‌دهد (از `credit_applications.rounding_version_id`).
   - `funding.service.ts` همان را به `createSchedule` می‌دهد.
   - مرز ماژول حفظ می‌شود: wallet جدول credit را نمی‌خواند، فقط از درگاه.
3. **حفاظ `schedule_differs_from_contract` می‌ماند.** دیگر برای گرد کردن نباید رخ دهد، ولی برای هر ناهمخوانی دیگر (مثلاً مبلغ مصوب یا کارمزد) همچنان کل شارژ را برمی‌گرداند.
4. **دست نمی‌خورند:**
   - فرمول `buildInstallmentSchedule`.
   - ثبت‌های دفتر کل: هیچ سند تازه و هیچ تغییر در سند کارمزد طرح.
   - بازنگری‌های برنامه (لغو پس از شارژ).
   - تخصیص پرداخت.
5. **خارج از دامنه، فقط ثبت:**
   - `repayment.shift_due_to_next_working_day` و `repayment.grace_days` هنوز «در زمان شارژ» خوانده می‌شوند. اولی فقط تاریخ را جابه‌جا می‌کند و دومی مهلت است. هیچ‌کدام در مقایسه قرارداد نیستند و مبلغی را عوض نمی‌کنند.
   - اگر مالک بخواهد آن‌ها هم روی پرونده قفل شوند، تسک جدا است.

## ۴. آزمون‌ها (ادعاها ضعیف نمی‌شوند)

**خالص (`packages/contracts/src/repayment/schedule.test.ts`)**، علاوه بر آزمون ویژگی‌محور ۱۰٬۰۰۰ ترکیب موجود:

- **مجموع دقیق** برای ۱، ۲، ۳، ۶، ۱۲، ۱۸، ۲۴، ۳۶، ۶۰ و ۳۶۰ قسط، با مبلغ‌های بخش‌پذیر و نابخش‌پذیر.
- **قسط اول:**
  - دقیقاً `base + ته‌مانده`، و باقی دقیقاً `base`.
  - ته‌مانده همیشه کمتر از `n × unit`.
  - هیچ قسطی جز اولی ته‌مانده ندارد.
- **مبالغ کوچک:**
  - `total = n × unit`: همه برابر و بی ته‌مانده.
  - `total = n × unit + 1n`: قسط اول یک ریال بیشتر.
  - `total = n × unit − 1n`: رد با `total_too_small_for_count`.
  - `total = 1n` با یک قسط و واحد `1n`.
- **مثال‌های بخش ۱** به‌عنوان آزمون ثابت (۵۰ میلیون و ۱۲ قسط با دو واحد؛ ۱۲۵ هزار).
- **سررسید** (موجود، بی‌تغییر): ۳۱ام در ماه‌های ۳۱، ۳۰ و ۲۹ روزه؛ اسفند کبیسه.

**یکپارچه:**

- **`test/wallet/funding.int.test.ts`، آزمون تازه:** واحد گرد کردن پس از تصمیم و پیش از شارژ عوض می‌شود.
  - شارژ **موفق** است.
  - برنامه با قرارداد ریال‌به‌ریال یکی است.
  - `rounding_config_version_id` = نسخه قفل‌شده پرونده.
  - تکرار با همان کلید همان برنامه را برمی‌گرداند.
- **همان فایل، آزمون مبلغ کوچک:** واحد تازه کل تعهد را «خیلی کوچک» می‌کند، ولی شارژ با واحد قفل‌شده موفق است.
- **آزمون موجود که عوض می‌شود** (گزارش می‌شود، ضعیف نمی‌شود): `funding.int.test.ts` حدود سطر ۵۶۰ امروز با عوض شدن واحد `409 schedule_differs_from_contract` می‌خواهد.
  - این ادعا رفتار حفاظ موقت را قفل کرده است. پس از رفع ریشه، به «شارژ موفق با واحد قفل‌شده» تبدیل می‌شود.
  - حفاظ با یک ناهمخوانی دیگر همچنان آزموده می‌شود، تا ادعای «ناهمخوانی، کل شارژ را برمی‌گرداند» حذف نشود.
- **`test/repayment/repayment.int.test.ts`** («rule 16: a later change…») و دیگر فراخوانی‌های مستقیم `createSchedule` در آزمون‌ها (holidays، reconciliation، bank-statements، cycle، receipts، repayment):
  - شناسه نسخه را صریح می‌دهند.
  - یک آزمون تازه: فراخوانی بی شناسه نسخه رد می‌شود.
- **ثابت‌های دفتر کل** (موجود): تراز، فقط‌افزودنی، و سند کارمزد طرح بی‌تغییر.

## ۵. ADR و سند ۰۲

- **ثبت مالی تازه:** لازم نیست. هیچ حساب، هیچ سطر و هیچ نوع سند تازه‌ای نیست.
- **فرمول سند ۰۲:** بی‌تغییر است.
- **یک جمله روشن‌کننده در سند ۰۲ §۵ لازم است:** «واحد گرد کردن اقساط از نسخه‌ای خوانده می‌شود که پرونده هنگام ایجاد قفل کرده است، نه از نسخه زمان شارژ».
  - پیش از ۱۴۰۵/۰۷/۲۱ اینجا «هنگام پیش‌نمایش» نوشته شده بود، که دقیق نبود.
  - قفل در `INSERT` ایجاد پرونده است و پیش‌نمایش فهرست طرح‌ها (`planOptions`) قفل نمی‌شود. جزئیات در ADR-039 «زمینه». این متن سند ۰۲ را عوض می‌کند. پس طبق دستور مالک، **ADR-039 (پیشنهادی)** در `docs/00-architecture-decisions.md` نوشته شد. سند ۰۲ فقط همراه کد و پس از تأیید آن ADR ویرایش می‌شود.

## ۶. ترتیب پس از تأیید

1. ADR-039 پذیرفته شود.
2. کد و آزمون‌های بالا.
3. گزارش بخش ۲ دوباره اجرا شود.
4. سند ۰۲ §۵ ویرایش شود.
5. یک commit محلی.

بی مهاجرت و بی تغییر داده.

## ۷. دامنه م۱ و `TODO(decision)`های باز (دستور مالک، ۱۴۰۵/۰۷/۲۰)

**م۱ فقط واحد گرد کردن را درست می‌کند** (`repayment.service.ts:221`). سه مقدار دیگری که هنگام ساخت برنامه از تنظیمات زمان شارژ خوانده می‌شوند (گزارش شرط ۱) در م۱ دست نمی‌خورند و کدشان تغییر نمی‌کند:

| # | مقدار | امروز | `TODO(decision)`: پیشنهاد |
|---|---|---|---|
| ت۱ | جابه‌جایی سررسید به روز کاری (`repayment.shift_due_to_next_working_day`) | نسخه زمان شارژ؛ روی `installment_schedules.shift_config_version_id` قفل می‌شود (`repayment.service.ts:216`) | **روی پرونده قفل شود** (مثل واحد گرد کردن). |
| ت۲ | تعطیلات رسمی و روزهای تعطیل هفته (`calendar.weekly_days_off`) | تقویم زمان شارژ (`repayment.service.ts:245-256`) | **جاری بماند**: تقویم زمان شارژ. |
| ت۳ | روزهای مهلت (`repayment.grace_days`) | نسخه زمان شارژ؛ روی `installment_schedule_terms` قفل می‌شود (`repayment.service.ts:223`) | **روی پرونده قفل شود.** |

- **پیش‌فرض اعمال‌شده تا پاسخ:** رفتار فعلی بی‌تغییر می‌ماند (هر سه از نسخه زمان شارژ).
- قفل ت۱ و ت۳ روی پرونده به ستون تازه روی `credit_applications` و قفل در پیش‌نمایش نیاز دارد. تسک جدا و [مالی] است و پس از تأیید نقشه‌اش انجام می‌شود.

## ۸. دو شکاف شرط ۲: فقط پیشنهاد SQL (اجرا نشده)

### ۸.۱ گزارش فقط‌خواندنی ارجاع یتیم (پایگاه محلی، ۱۴۰۵/۰۷/۲۰، `BEGIN READ ONLY`)

| ستون | ردیف | مقداردار | یتیم | به نسخه غیرتأییدشده |
|---|---|---|---|---|
| `credit_applications.plans_version_id` | ۷ | ۷ | **۰** | ۰ |
| `credit_applications.rounding_version_id` | ۷ | ۷ | **۰** | ۰ |
| `credit_applications.reduction_version_id` | ۷ | ۷ | **۰** | ۰ |
| `installment_schedules.rounding_config_version_id` | ۳ | ۳ | **۰** | ۰ |
| `installment_schedules.shift_config_version_id` | ۳ | ۳ | **۰** | ۰ |
| `installment_schedules.weekly_days_off_config_version_id` | ۳ | ۰ | **۰** | ۰ |
| `installment_schedule_terms.grace_config_version_id` | ۳ | ۳ | **۰** | ۰ |
| `contract_penalty_terms.config_version_id` | ۴ | ۴ | **۰** | ۰ |

امروز در هیچ مهاجرتی هیچ FK به `config_values` نیست.

### ۸.۲ پیشنهاد (مهاجرت `0082` یا شماره آزاد بعدی؛ R4 همچنان 0082 را می‌خواهد، پس شماره هنگام ساخت معلوم می‌شود)

```sql
-- (الف) هیچ نقشی، حتی owner، ردیف نسخه را حذف فیزیکی نمی‌کند. حذف نرم با deleted_at
-- همچنان از مسیر config_values_guard است (که خودش deleted_at نسخه تصمیم‌گرفته را هم می‌بندد).
CREATE TRIGGER config_values_no_delete
  BEFORE DELETE ON config_values
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
-- TRUNCATE هم بسته شود (trigger سطری روی TRUNCATE اجرا نمی‌شود):
CREATE TRIGGER config_values_no_truncate
  BEFORE TRUNCATE ON config_values
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- (ب) FKها، بی قفل طولانی: اول NOT VALID، بعد VALIDATE.
ALTER TABLE credit_applications
  ADD CONSTRAINT credit_applications_plans_version_fk
    FOREIGN KEY (plans_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT credit_applications_rounding_version_fk
    FOREIGN KEY (rounding_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT credit_applications_reduction_version_fk
    FOREIGN KEY (reduction_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE installment_schedules
  ADD CONSTRAINT installment_schedules_rounding_version_fk
    FOREIGN KEY (rounding_config_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT installment_schedules_shift_version_fk
    FOREIGN KEY (shift_config_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT installment_schedules_weekly_version_fk
    FOREIGN KEY (weekly_days_off_config_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE installment_schedule_terms
  ADD CONSTRAINT installment_schedule_terms_grace_version_fk
    FOREIGN KEY (grace_config_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE contract_penalty_terms
  ADD CONSTRAINT contract_penalty_terms_version_fk
    FOREIGN KEY (config_version_id) REFERENCES config_values (id) ON DELETE RESTRICT NOT VALID;
-- سپس، هر کدام جدا:
ALTER TABLE credit_applications VALIDATE CONSTRAINT credit_applications_plans_version_fk;
-- ... (همه هشت قید)
```

- **نوع:** فقط‌افزودنی (trigger و قید)، ولی روی جدول‌های مالی (`installment_schedules`، `installment_schedule_terms`، `contract_penalty_terms`). پس طبق بند ۴ **با تأیید مالک** اجرا می‌شود.
- **جدول‌های فقط‌افزودنی:** `ADD CONSTRAINT` و `VALIDATE` ردیفی را UPDATE نمی‌کنند. triggerهای append-only (`BEFORE UPDATE OR DELETE`) فعال نمی‌شوند.
- **مرز ماژول:** FK در سطح پایگاه داده است و هیچ کدی جدول config را مستقیم نمی‌خواند. آزمون `no-direct-read` فقط کد را می‌سنجد.
- **Drizzle:** این قیدها در `schema.ts` هم با `.references()` می‌آیند تا drift پاک بماند. اگر Drizzle قید `NOT VALID` را نشناسد، مهاجرت دستی ویرایش و snapshot هماهنگ می‌شود (ADR-003). پیش از commit، `db-drift.sh` اجرا می‌شود.
- **بیرون از این پیشنهاد:** دیگر ستون‌های `*_version_id`، مثل `proformas.validity_config_version_id`، `centers.checklist_config_version_id`، `credit_applications.checklist_version_id`/`ruleset_version_id`، `score_sheets`، `credit_decisions`، `contracts.template_version_id`، `service_fees`، `doctor_payables`، `tickets` و `field_reencryption_runs`. اول باید معلوم شود هر کدام به `config_values` اشاره می‌کند یا به جدول نسخه دیگری (مثلاً تعرفه یا پروفایل). پیشنهاد: تسک جدا با همین الگو.
- **آزمون‌ها و DELETE:** هیچ آزمون، seed یا آیینی `config_values` را DELETE یا TRUNCATE نمی‌کند (جست‌وجو در `apps`، `packages` و `scripts`). harness برای هر فایل پایگاه داده تازه می‌سازد و seed فقط INSERT دارد. پس trigger هیچ آزمونی را نمی‌شکند و هیچ آزمونی ضعیف نمی‌شود.
- **آزمون پس از اجرا:** به `locked-version-immutability.int.test.ts` دو ادعا افزوده می‌شود: owner در DELETE و TRUNCATE روی `config_values` رد می‌شود (`42501`)، و درج ارجاع به نسخه ناموجود `23503` می‌گیرد.

### ۸.۳ اجرا (تأیید مالک ۱۴۰۵/۰۷/۲۱ = ۲۰۲۶-۱۰-۱۳: «تایید شده ادامه بده»، پس از چاپ کامل SQL §۸.۲)

- **دامنه تأیید:** فقط SQL §۸.۲ (دو trigger و هشت FK). نقشه م۱، ADR-039، کد گرد کردن، سند ۰۲ و R4 همچنان منتظرند و دست نخوردند.
- **شماره:** `0082_config_version_guard`. R4 ساخته نشده است و هنگام ساخت شماره آزاد بعدی را می‌گیرد.
- **ساخت:** `drizzle-kit generate --custom`، همان الگوی مهاجرت‌های فقط-SQL `0007` و `0054`. snapshot همان قبلی است و فقط شناسه‌اش عوض می‌شود.
- **تصمیم: بی `.references()` در `schema.ts`** (برخلاف بند Drizzle در §۸.۲). هیچ فایل `*.schema.ts` ماژول دیگری را import نمی‌کند (مرز سخت ماژول‌ها). `installment_schedules`، `installment_schedule_terms` و `contract_penalty_terms` هم اصلاً در `schema.ts` نیستند (جدول‌های فقط-SQL). پس قیدها مثل triggerها فقط در SQL می‌مانند. drift پاک می‌ماند، چون schema و snapshot هر دو بی این قیدها هستند و هم‌خوان‌اند.
- **متن:** همان §۸.۲، با هشت خط `VALIDATE` کامل. `VALIDATE` در همان تراکنش مهاجرت است. با ۷ و ۳ و ۴ ردیف، قفل‌ها چند میلی‌ثانیه‌اند.
- **ترتیب:** `pg_dump` روی `D:\sepehr_app\db-backups`، ساخت فایل، drift، `db:migrate` محلی، بررسی فقط‌خواندنی، دو ادعای افزوده در آزمون immutability، اجرای تنهای آن و `config.int.test.ts`، و commit محلی.

### ۸.۴ اجرای 0082: نتیجه‌ها و تأیید دوم مالک (۱۴۰۵/۰۷/۲۱)

- **FKها فقط در SQL مهاجرت `0082` هستند، نه در `schema.ts`** (تأیید مالک). علت: مرز سخت ماژول‌ها. هیچ `*.schema.ts` ماژول دیگری را import نمی‌کند، پس `credit.schema.ts` نمی‌تواند به `configValues` ماژول config ارجاع دهد. سه جدول اقساط و قرارداد هم اصلاً در `schema.ts` نیستند. snapshot `0082` همان `0081` است و فقط شناسه‌اش عوض شده؛ drift پاک است. اگر روزی FK در `schema.ts` لازم شد، فقط با بازنگری قاعده مرز ماژول‌ها.
- **محلی:** پشتیبان `D:\sepehr_app\db-backups\sepehr-before-0082-20261013-054203.dump` (۲۷۶۹ سطر TOC). پس از اعمال: ۸۳ مهاجرت، دو trigger فعال، هشت FK validated و `RESTRICT`، و شمارش ردیف‌ها بی‌تغییر.
- **آزمون تغییرکرده (ضعیف نشد، با تأیید مالک):** `test/repayment/repayment.int.test.ts`، «the database refuses a schedule whose installments do not add up».
  - **چه عوض شد:** `randomUUID()` در `rounding_config_version_id` جای خود را به شناسه آخرین نسخه تأییدشده و حذف‌نشده `repayment.rounding_unit_rial` داد که از `config_values` خوانده می‌شود.
  - **چه نماند:** ادعای `23514` هنگام COMMIT و مبالغ عمداً غلط (۶۰+۳۰≠۱۰۰) بی‌تغییرند.
  - **ستون `rounding_unit_rial`:** ۱۰ ماند، همان مقدار آزمون. این ستون به مقدار نسخه وابسته نیست.
- **اثبات معنا:** روی پایگاه محلی، در تراکنش rollback‌شده و با owner، همان درج‌ها انجام شد.
  - **با trigger `installment_schedules_total`:** در `SET CONSTRAINTS ALL IMMEDIATE` (همان لحظه COMMIT) خطای `23514` آمد: «has 2 installments totalling 90, expected 2 totalling 100».
  - **با trigger حذف‌شده در همان تراکنش:** خطایی نیامد و ردیف قابل commit بود، یعنی آزمون قرمز می‌شد.
  - **پس از ROLLBACK:** trigger سر جایش است (deferrable، initially deferred)، ۳ schedule مانده و هیچ ردیف آزمایشی نیست.
- **فهرست شناسه‌های ساختگی در این ۸ ستون** (آزمون، seed و harness): **فقط همین یک جا بود** (`repayment.int.test.ts:305`، اکنون اصلاح‌شده).
  - `holidays.int.test.ts`، `credit-applications.int.test.ts`، `credit-plans.int.test.ts` و `locked-version-immutability.int.test.ts` این ستون‌ها را فقط می‌خوانند. آزمون immutability فقط تلاش رد‌شده UPDATE دارد.
  - seedهای `apps/e2e/src` فقط در `config_values` درج می‌کنند و پرونده و برنامه را از مسیر سرویس می‌سازند.
  - harness فقط مهاجرت‌ها را اجرا می‌کند.

### ۸.۵ commit با یک آزمون قرمز شناخته‌شده (دستور مالک، ۱۴۰۵/۰۷/۲۱)

- commit `254c0fa` با یک آزمون قرمز شناخته‌شده انجام شد: `credit-queues.int.test.ts`، «10,000 picks…»، timeout در ۹۰۰ ثانیه، فقط زیر بار کامل (ب‌ف۱). همان فایل تنها ۵ از ۵ سبز بود. مالک commit را پذیرفت.
- **قاعده از این به بعد:** پیش از هر commit که اجرای آزمونش حتی یک قرمز دارد (شناخته‌شده یا نه، مربوط یا نامربوط)، **پرسیده می‌شود**.

### ۸.۶ ADR-039 دقیق‌تر شد؛ پیشنهاد اجرای آزمون‌ها (دستور مالک، ۱۴۰۵/۰۷/۲۱)

- **ADR-039:** لحظه قفل «ایجاد پرونده» است، نه «پیش‌نمایش». متن ADR و جمله سند ۰۲ اصلاح شد. وضعیت تا پاسخ مالک «پیشنهادی» می‌ماند. سند ۰۲ و کد گرد کردن دست نخوردند.
- **پیشنهاد پیکربندی (فقط پیشنهاد؛ فایل موقت `vitest.integration.proposal.mts` پس از اجرا پاک شد، `vitest.integration.config.mts` دست نخورد):**
  - `test/credit/credit-queues.int.test.ts` به فهرست `HEAVY` می‌رود: تنها و پشت‌سرهم، پس از گروه موازی.
  - در ریشه `test` مقدار `maxWorkers: 4` قرار می‌گیرد، یعنی نصف ۸ هسته.
  - هیچ timeout و هیچ ادعایی عوض نشد.
- **دو اجرای کامل پشت‌سرهم با همین پیکربندی** (لاگ: `D:\sepehr-backup\load10-logs\proposal`):
  - اجرای ۱ (۱۴:۱۲ تا ۱۴:۴۴): ۷۸ از ۷۸ فایل، ۹۷۳ سبز و ۱ todo، ۱۹۰۳ ثانیه.
  - اجرای ۲ (۱۴:۴۴ تا ۱۵:۱۰): ۷۸ از ۷۸ فایل، ۹۷۳ سبز و ۱ todo، ۱۵۶۳ ثانیه.
  - پس از هر دو اجرا هیچ کانتینر آزمونی نماند. فقط `sepehr-postgres-1` و `sepehr-redis-1` توسعه ماندند.
- **harness (تشخیصی):** `loggedInAccount` در شکست login یا enroll، وضعیت HTTP و بدنه خطا را در پیام خطا می‌آورد. این تغییر ادعایی را عوض نمی‌کند. در این دو اجرا رخ نداد.

### ۸.۷ پذیرش ADR-039 و تصمیم‌های همراه (دستور مالک، ۱۴۰۵/۰۷/۲۱)

- **ADR-039 پذیرفته شد (accepted).**
- **جمله سند ۰۲ §۵ (تأییدشده):** «واحد گرد کردن اقساط از نسخه‌ای خوانده می‌شود که پرونده هنگام ایجاد قفل کرده است، نه از نسخه زمان شارژ. تغییر بعدی واحد روی پرونده‌های موجود اثر ندارد.»
  - جای آن زیر «### گردکردن»، پس از بلوک فرمول است.
  - سند ۰۲ فقط همراه کد م۱ و در همان commit ویرایش می‌شود.
- **`TODO(decision)` پیش‌نمایش `planOptions`:**
  - **امروز:** پیش‌نمایش فهرست طرح‌ها از پیکربندی همان لحظه ساخته می‌شود و قفل نمی‌شود. قفل در ایجاد پرونده است.
  - **پیشنهاد:** روی پیش‌نمایش برچسب «تقریبی» بیاید، و مبالغ قفل‌شده در یک مرحله تأیید نهایی نشان داده شوند.
  - **پیش‌فرض تا پاسخ:** رفتار فعلی.
  - **وضعیت امروز مرحله تأیید نهایی (فقط گزارش):**
    - **بخشی هست.** پس از ایجاد، صفحه پرونده (`apps/web/app/(patient)/me/credit/[id]/page.tsx`) مبالغ قفل‌شده را از خود پرونده نشان می‌دهد: مبلغ پیش‌فاکتور، پیش‌پرداخت، وام و جمع اقساط. در وضعیت `draft` دکمه ارسال (`SubmitApplication`) هم هست.
    - **این صفحه جدول اقساط، کارمزد طرح، هزینه تشکیل پرونده و جمع همه پرداخت‌ها را نشان نمی‌دهد.** جدول اقساط قفل‌شده فقط بعدتر در متن قرارداد (`installments.table`) می‌آید، که وام‌گیرنده آن را می‌پذیرد.
    - انتخاب‌گر طرح (`plan-chooser.tsx`) برچسب «تقریبی» ندارد.
- **قاعده ثابت تخصیص:** داخل تراکنشی که قفل advisory تخصیص (`lead.assign:<versionId>`، `AssignmentService.assign`/`pick`) را گرفته است، **هیچ تماس بیرونی، اسکن فایل یا ارسال پیامک مجاز نیست**.
  - چنین کاری فقط از راه outbox و پس از commit انجام می‌شود.
  - **علت:** این قفل همه ورودهای همان صف را پشت سر هم نگه می‌دارد.
- **پیکربندی آزمون:** اعمال و جدا commit می‌شود: `credit-queues` در `HEAVY`، و `maxWorkers: '50%'` به‌جای عدد ثابت. timeout بی‌تغییر است. ب‌ف۱ باز می‌ماند تا یک اجرای کامل با پیکربندی واقعی.
- **harness:** بدنه پاسخ شکست به ۵۰۰ نویسه کوتاه می‌شود. فیلدهای secret، token، otp و password پنهان می‌شوند. ادعاها بی‌تغییرند.

### ۸.۸ کد م۱ (تأیید مالک ۱۴۰۵/۰۷/۲۱؛ commit فقط پس از تأیید دوباره مالک)

- **کد:**
  - `RepaymentPort.createSchedule` ورودی اجباری `roundingConfigVersionId` گرفت.
  - `RepaymentService.createSchedule` واحد را با `config.getVersion` از همان نسخه می‌خواند و همان شناسه را ذخیره می‌کند.
  - بی شناسه معتبر، فراخوانی با `400 rounding_version_required` رد می‌شود.
  - `CreditContractFacts.roundingVersionId` شناسه را از پرونده می‌آورد و `funding.service.ts` آن را می‌دهد.
  - فرمول، قاعده سررسید، دفتر کل و حفاظ `schedule_differs_from_contract` بی‌تغییرند.
  - مهاجرت لازم نشد.
- **آزمون‌های تازه:**
  - **خالص** (`schedule.test.ts`): ۱ تا ۳۶۰ قسط؛ تعدادهای نقشه؛ مبالغ کوچک (`n×unit`، `+1`، `−1` رد)؛ مثال‌های §۱ با سررسیدها.
  - **یکپارچه** (`funding.int.test.ts`):
    - واحد بزرگ‌تری که کل تعهد را «خیلی کوچک» می‌کند، شارژ با واحد قفل‌شده را متوقف نمی‌کند.
    - حفاظ با ناهمخوانی دیگری (یک ریال در کل تعهد) هنوز کل شارژ را برمی‌گرداند.
    - `createSchedule` بی نسخه رد می‌شود.
- **تنها آزمون موجودی که ادعایش عوض شد (تأیید مالک):** «owner's decision 6» در `funding.int.test.ts`.
  - **پیش:** 409 `schedule_differs_from_contract`، و هیچ purse ساخته نمی‌شد.
  - **پس:** 201 approved؛ برنامه ریال‌به‌ریال برابر قرارداد؛ نسخه و واحد برنامه همان نسخه قفل‌شده پرونده (۱۰٬۰۰۰)؛ تکرار همان برنامه؛ فقط یک برنامه.
- **فراخوانی‌های مستقیم در ۶ فایل آزمون (تأیید مالک: یک helper مشترک):**
  - `test/repayment/rounding-version.ts` (`roundingVersionNow`) نسخه جاری را از درگاه config می‌دهد.
  - فایل‌ها: holidays، reconciliation، bank-statements، cycle، receipts و repayment، روی هم ۱۰ فراخوانی.
  - هیچ ادعایی عوض نشد.
- **اثبات:** با برگرداندن موقت خواندن به `resolve(…, fundedAt)`، دو آزمون تازه قرمز شدند (409 و 400). سپس اصلاح برگردانده شد.
- **اجرای تنها:** pure repayment ۴۱ از ۴۱؛ یکپارچه repayment، wallet، credit، holidays و reconciliation ۲۵ فایل و ۱۷۶ از ۱۷۶ (۹۰۷ ثانیه).
- **گزارش §۲ دوباره (فقط‌خواندنی):** ۱ نسخه، ۳ برنامه، ۰ ناهمخوان.
- **سند ۰۲ §۵:** جمله تأییدشده افزوده شد.
