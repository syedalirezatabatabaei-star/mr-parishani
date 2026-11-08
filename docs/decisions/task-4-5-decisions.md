# تسک ۴-۵ — شارژ کیف اعتبار و برنامه اقساط [مالی]

**وضعیت: نقشه و ADR-034 پیشنهادی نوشته شد (۱۴۰۵/۰۷/۱۱). منتظر تأیید مالک.** هیچ کد، مهاجرت یا ثبت مالی ساخته نشده است. پرسش‌ها در بخش «پرسش‌ها از مالک» پایین است.

سند مرجع: `docs/12` §۵ و §۹ (آزمون‌های ۲، ۳، ۴ و ۱۳)؛ `docs/13` ۴-۵؛ `docs/02` §۳ تا §۵؛ ADR-017 و ADR-019؛ تسک‌های ۱-۲ و ۱-۳ (کیف و اقساط فاز ۱)؛ ۴-۳ (فیش‌ها و `INCOME_ENTITIES`).

## الزام‌های مالک (۱۴۰۵/۰۷/۱۱، پس از تأیید گزارش ۴-۳)

### ۱. ADR پیش‌پرداخت: ثبت عطف‌به‌ماسبق

- فیش‌های پیش‌پرداختی که در ۴-۳ تأیید شده‌اند و بی‌ثبت مانده‌اند (`completion_receipts.kind = 'down_payment'`، `status = 'approved'`، `journal_entry_id IS NULL`)، باید با یک **ثبت عطف‌به‌ماسبق idempotent** وارد دفتر کل شوند.
- **کلید عدم تکرار هر فیش ثابت است:** مثلاً `contract:receipt:<receiptId>`، همان الگوی کارمزدها. اجرای دوباره سند دوم نسازد.
- **تطبیق با صورت‌حساب بانک نباید اختلاف داشته باشد.** جمع بدهکار `bank.collection` برای همه فیش‌های تأییدشده تکمیل (کارمزدها و پیش‌پرداخت) باید با جمع فیش‌های تأییدشده برابر باشد.
- **آزمون:**
  - فیش پیش‌پرداخت تأییدشده پیش از ADR ثبت می‌شود و اجرای دوباره چیزی نمی‌افزاید.
  - تراز دفتر کل سالم و تطبیق شبانه بی‌اختلاف است.
- **جای ثبت:** `journal_entry_id` همان فیش پر می‌شود. این ستون در مهاجرت `0033` برای UPDATE اعطا شده است. قید `completion_receipts_values_check` امروز برای پیش‌پرداخت تأییدشده `journal_entry_id IS NULL` را **الزام** می‌کند. پس ADR باید با مهاجرت جدا آن قید را به «بدون ثبت تا ADR» یا «با ثبت پس از ADR» تبدیل کند. این تغییر قید یک جدول مالی موجود است و تأیید جدا می‌خواهد.

### ۲. مرز ماژول در شارژ

- ماژول کیف (wallet) وضعیت تکمیل را **فقط** از رابط عمومی ماژول contract (یک پورت، مثلاً `COMPLETION_STATUS.completedAt(creditApplicationId)`) یا از رویداد outbox `contract.completed` بخواند.
- **هرگز از جدول `case_completions` نخواند** (CLAUDE.md §۵).

### ۳. هم‌روندی (از بررسی ۴-۳)

- **شارژ** باید شرط «تکمیل‌شده» را **درون تراکنش خودش، با قفل ردیف** دوباره بسنجد، نه از نتیجه‌ای که پیش از تراکنش خوانده شده است.
- **تکمیل:**
  - امروز برگشت‌ناپذیر است: trigger فقط‌افزودنی روی `case_completions` و نبود API برگشت.
  - **پیامد:** شارژ می‌تواند به ثابت ماندن آن تکیه کند. ولی اگر انصراف پیش از شارژ (۴-۸) پرونده را باطل کند، شارژ باید وضعیت پرونده اعتباری را هم بسنجد.

### ۴. یادآوری مالک برای نقشه (۱۴۰۵/۰۷/۱۱)

- ثبت‌های درآمد کارمزد از `INCOME_ENTITIES` استفاده کنند.
- پیش‌پرداخت به آرامش ثروت می‌رود.
- همه مبالغ `bigint` ریال.

---

## آنچه امروز در کد هست (بررسی فقط‌خواندنی)

- **کیف فاز ۱** (`WalletService`):
  - `approveCredit`: بدهکار `borrower.debt`، بستانکار `purse.approved`، به مبلغ مصوب. کیف را می‌سازد.
  - `charge`: کل `approved_amount_rial` را یک‌بار از `purse.approved` به `purse.available` می‌برد و `funded_at` را می‌گذارد.
  - **قید سخت در کد:** جمع مصرف ≤ `approved_amount_rial` (`consumption_exceeds_approved`).
  - **یکتایی:** هر Case فقط یک کیف (`ON CONFLICT (case_id)`).
- **اقساط فاز ۱** (`RepaymentService.createSchedule`):
  - اصل = `purse.approvedAmountRial`؛ جمع = اصل + کارمزد طرح.
  - کارمزد طرح همان لحظه شناسایی می‌شود: بدهکار `borrower.debt`، بستانکار `company.fee_income`. «سرشکن» یعنی همین رفتار فاز ۱ (پیش‌فرض ت۱).
  - واحد گردکردن از پیکربندی **در لحظه `funded_at`** خوانده می‌شود.
  - **یکتایی:** هر Case یا کیف فقط یک برنامه.
- **پیش‌نمایش تصمیم** (۳-۶) همه مبالغ را روی مبلغ مصوب دوباره حساب می‌کند: کارمزد طرح، جمع تعهد و جدول اقساط. همین‌ها در قرارداد (۴-۱) آمده‌اند. `CREDIT_CONTRACT_FACTS` آن‌ها را می‌دهد.
- **فیش پیش‌پرداخت تأییدشده (۴-۳)** هیچ سندی ندارد. دو چیز پر کردن `journal_entry_id` آن را **مسدود** می‌کنند:
  - قید `completion_receipts_values_check`.
  - trigger `completion_receipts_guard_change`: فیش تصمیم‌گرفته هیچ تغییری نمی‌پذیرد.

## ADR-034 (پیشنهادی) — پیش‌پرداخت در دفتر کل

> **پذیرفته شد (۱۴۰۵/۰۷/۱۱).** متن نهایی در `docs/00-architecture-decisions.md`، ADR-034. متن زیر پیشنهاد اولیه است، برای سابقه.

**مسئله:** بیمار پیش‌پرداخت را به حساب آرامش ثروت می‌ریزد. پزشک باید کل سهم پیش‌فاکتور را بگیرد. بدهی وام‌گیرنده فقط وام است، به‌علاوه کارمزد سرشکن. سند ۰۲ برای پیش‌پرداخت ثبتی ندارد.

**نمادها** (همه `bigint` ریال):
- **A:** مبلغ مصوب (وام).
- **D:** پیش‌پرداخت.
- **F:** کارمزد طرح سرشکن.
- **T:** مابه‌التفاوت نقدی کسری کم، که بیرون از سامانه مستقیم به پزشک می‌رسد.

### گزینه‌ها

| | **الف** (پیشنهاد مالک، پالایش‌شده): D درون کیف | **ب**: D بیرون کیف، به پزشک هنگام قطعی شدن | **ج**: D به پزشک هنگام شارژ |
|---|---|---|---|
| مسیر پول پزشک | یک مسیر: مجوز خدمت ← صورت‌وضعیت | دو منبع در هر خدمت (کیف و D) | پیش از خدمت |
| `borrower.debt` | A + F | A + F | A + F |
| قید «مصرف ≤ سقف» | برقرار، با سقف A + D | کیف بی‌تغییر؛ منطق ۴-۶ و ۵ دوشاخه | بی‌تغییر |
| تغییر کد مالی فاز ۱ | کم و دقیق (پایین) | هیچ؛ پیچیدگی در ۴-۶ و ۵ | هیچ |
| ریسک | کم | تقسیم هر خدمت بین دو منبع و خطای گرد | پزشک پیش از خدمت طلبکار؛ انصراف پس‌گرفتن از پزشک می‌خواهد |

**پیشنهاد: الف.**

### ثبت‌ها در گزینه الف

1. **تأیید مالی فیش پیش‌پرداخت** (فیش‌های تازه و عطف‌به‌ماسبق):
   - بدهکار `bank.collection` D، بستانکار حساب تازه `downpayment.held` D.
   - **`downpayment.held`:** نوع `liability`، مالک `borrower` (شخص وام‌گیرنده). مالک تازه نمی‌خواهد، پس CHECK `ledger_accounts` تغییر نمی‌کند.
   - کلید `contract:receipt:<receiptId>`؛ `credit_application_id` روی سند.
   - **نهاد:** پیش از ثبت `assertIncomeEntity` (فقط آرامش). پیش‌پرداخت درآمد نیست، ولی پول آرامش است.
   - **چرا مستقیم به کیف نه:** کیف تا شارژ وجود ندارد.
2. **تصویب اعتبار هنگام شارژ** (اگر D > 0):
   - بدهکار `borrower.debt` A، و بدهکار `downpayment.held` D.
   - بستانکار `purse.approved` به مبلغ A + D.
   - D = 0: همان ثبت امروز.
3. **شارژ:** بدهکار `purse.approved`، بستانکار `purse.available`، به مبلغ A + D.
4. **پس از شارژ:** رزرو، ثبت خدمت و قطعی شدن بی‌تغییرند.
   - پزشک A + D را از `doctor.payable` می‌گیرد.
   - زنجیره کیف و `downpayment.held` صفر می‌شوند.
   - فقط طلب از وام‌گیرنده (A + F) می‌ماند.
5. **ترتیب مصرف** (اثرش در ابطال مانده ۴-۸):
   - **پیشنهاد:** اول پیش‌پرداخت، بعد وام.
   - **دلیل:** مانده مصرف‌نشده تا جای ممکن از وام است و ابطالش بدهی را کم می‌کند. پیش‌پرداخت مصرف‌نشده باید مسترد شود (ثبت استرداد در ۴-۸).
   - `TODO(decision)`، پرسش پ۳.

### تغییر لازم در کد مالی موجود (بند ۴؛ تأیید صریح لازم)

- **مهاجرت افزودنی:** `credit_purses.down_payment_rial bigint NOT NULL DEFAULT 0 CHECK (>= 0)`.
  - `approved_amount_rial` همان معنای امروز را نگه می‌دارد: وام مصوب.
  - پس `RepaymentService` (اصل = مبلغ مصوب) **بی‌تغییر** می‌ماند.
- **`WalletService`، چهار تغییر دقیق.** D = 0 یعنی رفتار و هش فاز ۱ بی‌تغییر.
  - `approveCredit`: ورودی اختیاری `downPayment: { amountRial, heldAccountId }`، سطر بدهکار دوم، و ستون تازه.
  - `charge`: مبلغ = approved + down_payment.
  - قید مصرف: سقف = approved + down_payment.
  - `summary`: فیلد `downPaymentRial`.
- **سند ۰۲ §۳ و §۴:**
  - حساب `downpayment.held`.
  - دو سطر: «دریافت پیش‌پرداخت» و «تصویب اعتبار با پیش‌پرداخت».
  - یادداشت اینکه زنجیره `purse.*` حالا A + D است.

### ثبت عطف‌به‌ماسبق فیش‌های پیش‌پرداخت ۴-۳ (الزام ۱)

- **جای ثبت: همان `journal_entry_id` فیش** (خواسته مالک).
- **مهاجرت `0034` روی جدول مالی موجود (پرسش پ۲).** داده‌ای حذف یا عوض نمی‌شود، ولی DROP و جایگزینی دارد:
  - **قید:** `completion_receipts_values_check` با `DROP CONSTRAINT` و `ADD CONSTRAINT` جایگزین می‌شود.
    - کارمزد تأییدشده همیشه سند دارد.
    - پیش‌پرداخت تأییدشده سند دارد یا ندارد.
    - بقیه شرط‌ها بی‌تغییر.
  - **تابع trigger** `completion_receipts_guard_change` (`CREATE OR REPLACE FUNCTION`) یک استثنا می‌گیرد: در فیش `down_payment` تأییدشده، `journal_entry_id` فقط از NULL به یک مقدار (و `updated_at`) عوض می‌شود. هر تغییر دیگر همچنان رد می‌شود.
- **جایگزین بی‌تغییر جدول، اگر مالک ترجیح دهد:** جدول فقط‌افزودنی `down_payment_postings(receipt_id unique, journal_entry_id)`. پیشنهاد من همان ستون فیش است: یک منبع حقیقت.
- **اجرا: `CompletionService.postDownPayment(receiptId)`، idempotent.**
  - **روش:** قفل فیش (`FOR UPDATE`)، `postJournal` با کلید ثابت، و پر کردن ستون.
  - **صدا زده می‌شود از:**
    - `approve()` برای فیش تازه، در همان تراکنش.
    - فرمان CLI یک‌باره `contract:post-down-payments` برای فیش‌های قدیم.
    - شارژ، پیش از تصویب.
  - **تکرار:** سند دوم نمی‌سازد.
- **تطبیق بانک (فقط‌خواندنی، ماژول contract، کار شبانه worker):**
  - **بررسی:** جمع فیش‌های تأییدشده = جمع بدهکار `bank.collection` در سندهای `contract:receipt:*`، و هر فیش تأییدشده دقیقاً یک سند.
  - **کد تطبیق ledger فاز ۱** دست نمی‌خورد.

## نقشه ۴-۵

### مدل (ماژول `wallet`، فقط‌افزودنی)

- **`funding_requests`:**
  - **ستون‌ها:** `credit_application_id`؛ وضعیت `requested` → `approved` | `rejected` | `cancelled`؛ `requested_by`، `decided_by`، زمان‌ها، دلیل؛ `purse_id` و `schedule_id`.
  - **قیدها:** CHECK `decided_by <> requested_by`؛ یکتای جزئی یک درخواست باز یا تأییدشده برای هر پرونده؛ trigger چرخه.
- **مجوزها:**
  - `wallet.fund.request`: کارشناس تکمیل و مالی (پ۶).
  - `wallet.fund.approve`: مالی.

### پورت‌ها (الزام ۲ و ۳)

- **`COMPLETION_STATUS`** (پیاده‌سازی در contract):
  - `lockCompleted(creditApplicationId, tx)`: `FOR SHARE` روی ردیف تکمیل، درون تراکنش شارژ.
  - `postDownPayment` و نهاد قرارداد.
  - wallet هرگز `case_completions` را نمی‌خواند.
- **`CREDIT_CONTRACT_FACTS.lockForFunding(id, tx)`** (افزودنی):
  - `FOR SHARE` روی پرونده اعتباری.
  - دوباره‌سنجی `approved` یا `conditional`.
  - دامنه کیف: مرکز، پزشک و فیلد درمان، از پیش‌فاکتور.

### شارژ: `FundingService.approve`

یک تراکنش، با کلید `fund:{creditApplicationId}`:

1. **قفل درخواست:**
   - اگر تأییدشده است، همان نتیجه برمی‌گردد (آزمون ۳).
   - اگر تأییدکننده همان درخواست‌کننده است ← ۴۰۹ (آزمون ۲).
2. **قفل وضعیت:** `lockForFunding` و `lockCompleted`. هر کدام برقرار نباشد ← ۴۰۹ (آزمون ۱).
3. **نهاد:** `assertIncomeEntity(contract.entityId)` پیش از هر ثبت؛ کارمزد سرشکن فقط به آرامش.
4. **اگر D > 0:** `postDownPayment` (idempotent).
5. **`wallet.approveCredit`:** کلید `fund:{id}:approve`؛ A و D.
6. **`wallet.charge`:** کلید `fund:{id}:charge`؛ `funded_at` ثبت می‌شود.
7. **`repayment.createSchedule`:** کلید `fund:{id}:schedule`؛ کارمزد F اگر `spread`، وگرنه ۰؛ مبنا `funded_at` (آزمون ۴).
8. **سازگاری با قرارداد:**
   - جمع برنامه = `totalObligationRial`، و مبلغ هر قسط = پیش‌نمایش.
   - وگرنه ۴۰۹ `schedule_differs_from_contract` و برگشت کل (پ۵).
9. **ثبت نتیجه:** `wallet.funded` در outbox، درخواست تأییدشده با شناسه‌ها، و audit.

**پس از commit:**
- **worker:**
  - **پیامک بیمار:** شارژ، مبلغ و جدول اقساط شمسی.
  - **پیامک پزشک:** «بیمار آماده دریافت خدمت»، **بی‌مبلغ و بی‌اطلاعات مالی**.
  - قالب‌ها در کلید تازه `wallet.sms_templates`.
- **Case ← `funded`:** شکاف قیف (سؤال ۸ RESUME) باز است. فقط رویداد، مثل ۴-۳.

### صفحه‌ها (کوچک، همین تسک)

- **پنل داخلی:** درخواست شارژ در `/completion/[id]` پس از تکمیل، و صف تأیید شارژ برای مالی.
- **بیمار:** کیف و جدول اقساط شمسی در `/me/credit/[id]`، با مبالغ دقیق ریالی.

### مهاجرت‌ها (خلاصه SQL پیش از اجرا در همین فایل)

- **`0034_down_payment`** (روی جدول مالی موجود؛ پ۱ و پ۲):
  - جایگزینی CHECK و تابع trigger `completion_receipts`.
  - ستون `credit_purses.down_payment_rial`.
- **`0035_funding`** (فقط افزودنی): `funding_requests`، دو مجوز، و کلید `wallet.sms_templates`.

### آزمون‌ها

- **سند ۱۲ §۹:**
  - **۱:** شارژ بی‌تکمیل رد.
  - **۲:** یک نفر رد.
  - **۳:** تکرار، سند و برنامه دوم نسازد.
  - **۴:** سررسید از `funded_at`.
  - **۱۳:** تراز و تطبیق شبانه پس از هر گام.
- **ADR-034:**
  - **عطف‌به‌ماسبق:** فیش تأییدشده پیش از ADR ثبت می‌شود و CLI دوم چیزی نمی‌افزاید.
  - **تطبیق بانک:** فیش‌ها = `bank.collection`.
  - **پس از شارژ:** `borrower.debt` = A + F؛ `purse.available` = A + D؛ `downpayment.held` = ۰.
  - **مصرف کامل A + D:** زنجیره صفر، و فقط طلب A + F می‌ماند.
- **هم‌روندی:** دو تأیید هم‌زمان ← یک کیف و یک برنامه.
- **نهاد:** قرارداد `sepehr` از پایگاه داده ← ۴۰۹ و صفر سند.
- **ثابت:** برای A، D، F و تعداد قسط تصادفی، جمع اقساط = A + F و هر سند تراز.
- **پیامک پزشک:** بی‌مبلغ و بی‌شرح درمان.
- **پس از تسک:** تطبیق شبانه روی داده آزمون.

## پرسش‌ها از مالک (توقف بند ۴)

- **پ۱ — ADR-034، گزینه الف:**
  - D درون کیف و سقف A + D.
  - `borrower.debt` = A + F.
  - چهار تغییر دقیق `WalletService` و ستون افزودنی.
  - تأیید است؟
- **پ۲ — مهاجرت `0034` روی `completion_receipts`:**
  - **پیشنهاد:** جایگزینی CHECK و تابع trigger، تا `journal_entry_id` پیش‌پرداخت یک‌بار پر شود.
  - **گزینه دیگر:** جدول جدای `down_payment_postings`.
- **پ۳ — ترتیب مصرف:** اول پیش‌پرداخت، بعد وام؟
- **پ۴ — گروه درمان (یافته):**
  - **مشکل:** اعضای یک گروه (۳-۷) `case_id` مشترک دارند، ولی کیف و برنامه فاز ۱ برای هر Case **یکتا**ند. عضو دوم شارژ نمی‌شود (`purse_exists_for_case`).
  - **گزینه الف (پیشنهاد):** یکتایی کیف و برنامه به `credit_application_id`. یعنی DROP و ساخت ایندکس یکتای دو جدول مالی، و تغییر شرط `createSchedule`.
  - **گزینه ب:** هر عضو گروه Case خودش (تغییر ۳-۷).
  - **تا پاسخ:** شارژ عضو دوم با ۴۰۹ روشن رد می‌شود.
- **پ۵ — نسخه گردکردن:**
  - **مشکل:** `createSchedule` واحد گردکردن را در `funded_at` می‌خواند، ولی قرارداد با نسخه قفل‌شده پرونده ساخته شده است (قاعده ۱۶). اگر پیکربندی بین این دو عوض شود، برنامه با قرارداد فرق می‌کند.
  - **پیشنهاد:** شارژ ناسازگاری را رد کند (گام ۸). رفع ریشه‌ای، یعنی پذیرفتن نسخه قفل‌شده در `createSchedule`، تسکی جدا با تأیید.
- **پ۶ — درخواست شارژ:** کارشناس تکمیل هم، یا فقط مالی؟ پیش‌فرض: هر دو (سند ۱۲ §۵).

## پاسخ مالک (۱۴۰۵/۰۷/۱۱): نقشه و ADR-034 تأیید شد، با این تصمیم‌ها

1. **`toman()`:**
   - فرمت‌کننده مشترک (UI، API، PDF و پیامک) با نمایش دقیق «تومان و ریال»، بی‌حذف بی‌صدا.
   - قاعده ریشه‌ای در **ADR-035**: پیش‌پرداخت گرد شود و وام = سهم − پیش‌پرداخت بماند؛ فقط طرح‌های تازه؛ ذکر در متن قرارداد.
   - آزمون: جمع مبالغ PDF = جدول اقساط، دقیقاً.
   - **commit جدا، پیش از کد ۴-۵.**
2. **گزینه الف تأیید.**
   - ADR مسیر **برگشت پیش‌پرداخت پیش از شارژ با سند معکوس** را مشخص کند.
   - تطبیق شبانه `downpayment.held` را در بر گیرد.
   - چهار تغییر `WalletService` فهرست شود؛ هیچ آزمون فاز ۱ ضعیف نشود.
3. **مهاجرت `0034`:**
   - **جدول پیوند فقط‌افزودنی**، با یکتایی روی `receipt_id` و `journal_entry_id`.
   - CHECK و trigger `completion_receipts` **تغییر نمی‌کند**.
   - ثبت عطف‌به‌ماسبق با همین جدول و کلید `contract:receipt:<id>`.
4. **ترتیب مصرف:** اول پیش‌پرداخت، بعد وام؛ در ADR مستند شود.
5. **یکتایی کیف و برنامه اقساط روی پرونده اعتباری تأیید.**
   - ترتیب: اول ایندکس تازه، بعد حذف قدیمی.
   - بدهی هر عضو جدا بماند، با آزمون دو عضو.
   - **پیش از `db:migrate`، SQL خلاصه و پرسیده شود.**
6. **ناهمخوانی واحد گردکردن:**
   - رد کامل، با برگشت کل شارژ.
   - رفع ریشه‌ای در RESUME به‌عنوان **مانع راه‌اندازی** ثبت شود.
7. **درخواست شارژ:** کارشناس تکمیل می‌تواند بدهد. **تأیید فقط مالی، و شخصی دیگر.**
8. **هر فیلد پولی به ریال،** با جداکننده سه‌رقمی، و برچسبی کنار یا زیرش که همان مبلغ را به تومان نشان دهد.

## اجرای بخش ۱ (ADR-035)، commit جدا

- **فرمت‌کننده مشترک** `packages/contracts/src/text/money.ts`:
  - `formatToman`، `formatRial`، `groupedDigits` و `parseRial`.
  - `toman()` و `rial()` در UI، PDF قرارداد و پیامک دعوت ضامن از آن استفاده می‌کنند.
- **`MoneyField`** (`packages/ui`): ورود ریالی با جداکننده سه‌رقمی و تومان دقیق زیر فیلد.
  - **جایگزین همه ورودی‌های تومانی:**
    - قیمت واحد پیش‌فاکتور و تعرفه خدمات.
    - داده خام امتیاز (چهار مبلغ).
    - مبلغ مصوب تصمیم.
    - مبلغ چک و سفته.
    - مبلغ فیش.
  - **باگ واقعی پیداشده و رفع‌شده:** صفحه اصلاح پیش‌فاکتور (`tomansOf`) قیمت قبلی را بریده به تومان در فرم می‌گذاشت. اصلاح یک ردیف غیرگرد، قیمت را بی‌صدا چند ریال کم می‌کرد.
- **ADR-035** در `docs/00`. جزئیات و آزمون‌ها همان‌جاست.

## نقشه اصلاح‌شده ۴-۵ (پس از پاسخ‌ها)

### ADR-034 — تکمیل متن

- **برگشت پیش‌پرداخت پیش از شارژ:**
  - **اجرا:** سند معکوس کامل ثبت پیش‌پرداخت (`LedgerPort.reverseJournal`): بدهکار `downpayment.held`، بستانکار `bank.collection`.
  - **ثبت در جدول پیوند:** `reversal_journal_entry_id`، دلیل، کننده و زمان. این ستون‌ها یک‌بار از NULL پر می‌شوند (trigger).
  - **چه کسی:** فقط مالی (`repayment.approve_payment`)، با دلیل، و پیش از شارژ. پس از شارژ ۴۰۹ `already_funded`. انصراف پس از شارژ مسیر ۴-۸ است.
  - **پیامد:** پیش‌پرداخت برگشت‌خورده شرط تکمیل را از بین نمی‌برد، چون تکمیل برگشت‌ناپذیر است. ولی شارژ آن را **رد** می‌کند (`down_payment_reversed`)، تا پیش‌پرداخت تازه فیش و تأیید بگیرد.
  - **استرداد پول** به بیمار بیرون از این سند است (پرداخت بانکی). ثبت پرداخت استرداد، `TODO(decision)` ۴-۸ است.
- **تطبیق شبانه:**
  - **بررسی منفی‌نبودن مانده:** `downpayment.held` (liability، مانده عادی بستانکار) هم در فهرست حساب‌هایی است که منفی‌شدنشان گزارش می‌شود. این یک تغییر کوچک در `reconciliation.ts` فاز ۱ است (تأیید مالک بند ۲).
  - **بررسی تازه ماژول contract:**
    - جمع فیش‌های تأییدشده = جمع بدهکار `bank.collection` سندهای `contract:receipt:*`، منهای معکوس‌ها.
    - هر فیش پیش‌پرداخت تأییدشده دقیقاً یک پیوند دارد.
- **ترتیب مصرف:** اول پیش‌پرداخت، بعد وام (بند ۴).
  - **مصرف‌شده از پیش‌پرداخت** = min(مصرف، D). **مصرف‌شده از وام** = بقیه.
  - **ابطال مانده (۴-۸):** فقط بخش وامِ مصرف‌نشده `borrower.debt` را کم می‌کند. پیش‌پرداخت مصرف‌نشده، استرداد است.
  - **در ۴-۵:** فقط مستند و در `summary` قابل محاسبه است. هیچ ثبتی به آن وابسته نیست.
- **سند کارمزد طرح در گروه درمان (تأیید مالک، ۱۴۰۵/۰۷/۱۱):**
  - **تغییر:** `RepaymentService.createSchedule` روی سند `repayment.plan_fee` ارجاع `creditApplicationId` کیف را هم می‌گذارد.
  - **بی‌تغییر:** مبلغ، سطرها و حساب‌ها.
  - **کلید:** هر عضو کلید خودش را دارد: `repayment:plan-fee:funding:<applicationId>:schedule`.
  - **دلیل:** اعضای یک گروه Case مشترک دارند. بی این ارجاع، کارمزد هر عضو از روی Case قابل تشخیص نبود.
  - **پایگاه محلی:** هیچ سند کارمزد قدیمی ندارد (۰ سند، ۰ برنامه). سند معکوس لازم نیست.
- **پیامک «بیمار آماده است» به پزشک (سؤال ۱۲؛ پاسخ از کد فعلی، بی‌تغییر):**
  - **منبع موبایل:** حساب کاربری پزشک، نه کاتالوگ. زنجیره:
    - `CreditFundingFacts.doctorAccountId`
    - مطب (`WorkplaceDirectory`)
    - `doctors.account_id`
    - `ACCOUNT_DIRECTORY.find`
    - `user_accounts.mobile`
  - **جدول `doctors` کاتالوگ ستون موبایل ندارد.**
  - **پیامد ۱:** پزشکی که حساب ورود متصل ندارد پیامک نمی‌گیرد، و هشداری هم ثبت نمی‌شود.
  - **پیامد ۲:** حساب مرکزی که موبایل ندارد هم پیامک نمی‌گیرد، و فقط هشدار در لاگ می‌ماند. ساخت حساب مرکز (`createAccount`) امروز موبایل نمی‌گیرد.
  - **تا تصمیم مالک، کد بی‌تغییر.** در آزمون‌ها، موبایل حساب پزشک فقط داده آزمون است (`test/credit/world.ts`).

### چهار تغییر `WalletService` (و یک تغییر `RepaymentService`)

1. **`approveCredit`:**
   - **ورودی اختیاری** `downPayment: { amountRial, heldAccountId }`.
   - **سطرها:** بدهکار `borrower.debt` A و بدهکار `downpayment.held` D؛ بستانکار `purse.approved` A + D.
   - **درج:** `down_payment_rial`.
   - **سازگاری فاز ۱:** بی‌ورودی، سطرها و هش درخواست همان فاز ۱.
   - **ON CONFLICT:** `(case_id)` به `DO NOTHING` بی‌هدف، تا هر دو ایندکس یکتای تازه را بپوشاند. خطای `purse_exists_for_case` همان می‌ماند.
2. **`charge`:** مبلغ = `approved_amount_rial + down_payment_rial`.
3. **قید مصرف:** سقف = `approved_amount_rial + down_payment_rial` (`consumption_exceeds_approved`).
4. **`summary`:** فیلد `downPaymentRial`.
5. **`RepaymentService.createSchedule`:**
   - **شرط وجود برنامه:** `purse_id = … OR case_id = …` به `purse_id = …`. خطای `schedule_exists_for_case` همان می‌ماند.
   - اصل همچنان `approvedAmountRial` (= A).

### مهاجرت‌ها (خلاصه SQL؛ **پیش از `db:migrate` محلی پرسیده می‌شود**)

**`0034_down_payment_postings` (فقط افزودنی):**
```sql
CREATE TABLE down_payment_postings (
  id uuid PK DEFAULT uuidv7(),
  receipt_id uuid NOT NULL REFERENCES completion_receipts(id),
  credit_application_id uuid NOT NULL REFERENCES credit_applications(id),
  journal_entry_id uuid NOT NULL,             -- FK به journal_entries
  reversal_journal_entry_id uuid NULL,         -- FK به journal_entries
  reversal_reason text NULL, reversed_by uuid NULL, reversed_at timestamptz NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_id), UNIQUE (journal_entry_id), UNIQUE (reversal_journal_entry_id),
  CHECK (ستون‌های برگشت همه NULL یا همه پر)
);
-- trigger: بدون DELETE؛ UPDATE فقط ستون‌های برگشت، یک‌بار از NULL.
GRANT SELECT, INSERT ON down_payment_postings TO sepehr_app;
GRANT UPDATE (reversal_journal_entry_id, reversal_reason, reversed_by, reversed_at) ...;
```

**`0035_funding`:**
```sql
-- افزودنی روی جدول مالی موجود:
ALTER TABLE credit_purses ADD COLUMN down_payment_rial bigint NOT NULL DEFAULT 0
  CHECK (down_payment_rial >= 0);
-- یکتایی به پرونده اعتباری (بند ۵): اول ایندکس‌های تازه
CREATE UNIQUE INDEX credit_purses_application_key ON credit_purses (credit_application_id)
  WHERE credit_application_id IS NOT NULL;
CREATE UNIQUE INDEX credit_purses_case_without_application_key ON credit_purses (case_id)
  WHERE credit_application_id IS NULL;        -- رفتار کیف‌های بی‌پرونده فاز ۱
-- سپس حذف قدیمی‌ها (مخرب؛ تأیید مالک بند ۵):
ALTER TABLE credit_purses DROP CONSTRAINT credit_purses_case_key;
ALTER TABLE installment_schedules DROP CONSTRAINT installment_schedules_case_key;
  -- installment_schedules_purse_key می‌ماند: هر کیف (= هر پرونده اعتباری) یک برنامه
-- افزودنی:
CREATE TABLE funding_requests (... requested_by, decided_by, CHECK decided_by <> requested_by,
  یکتای جزئی (credit_application_id) WHERE status IN ('requested','approved'), trigger چرخه);
INSERT permissions: wallet.fund.request (case_completion), wallet.fund.approve (accounting);
INSERT config: wallet.sms_templates (پیامک بیمار و پزشک، بی‌اطلاعات مالی برای پزشک).
```
