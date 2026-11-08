# R4 [مالی]: بازرمزگذاری `payout_orders` و `instruments`، نقشه کامل

> **وضعیت:** **تأیید شد (مالک ۱۴۰۵/۰۷/۲۲)** با پاسخ‌های §۱۲. کد، آزمون‌ها و فایل مهاجرت `0083_financial_key_forms` ساخته شد؛ **مهاجرت روی پایگاه داده محلی اجرا نشده است.** ADR-040 پیشنهادی.
> نوشته‌شده ۱۴۰۵/۰۷/۲۲ (۲۰۲۶-۱۰-۱۴) روی `b7b9b05`، از روی مخزن و پایگاه داده محلی.
> جایگزین بخش ۹ `task-9-3-decisions.md` نیست؛ آن را کامل می‌کند.

## ۰. دامنه R4: چه چیزی عوض می‌شود و چه چیزی نه

- **هر دو جدول از پیش هستند:**
  - `payout_orders` و `payout_order_nodes`: مهاجرت `0049`، تسک ۵-۵.
  - `instruments`: مهاجرت `0032`، تسک ۴-۲. `instrument_executions` و `instrument_releases`: مهاجرت `0062`، تسک ۶-۸.
- **R4 جدول، ستون، وضعیت، گذار، مبلغ، کارمزد یا ثبت دفتر کل تازه نمی‌سازد.** فقط اجازه می‌دهد سه ستون رمزشده با کلید تازه دوباره نوشته شوند:
  - `payout_orders.iban_enc`
  - `instruments.number_enc` و `instruments.number_bidx`
- **چرا لازم است:** ماژول‌های غیرمالی از ۹-۳ حلقه کلید دارند. settlement و instrument هنوز فقط کلید ۱ را می‌شناسند (`settlement.module.ts:62` و `instrument.crypto.ts:17-18`). تا این دو بازرمزگذاری نشوند، کلید ۱ هرگز بازنشسته نمی‌شود.
- **داده تحت تأثیر در پایگاه محلی (۱۴۰۵/۰۷/۲۲، فقط‌خواندنی):** `payout_orders` ۰ ردیف و `instruments` ۰ ردیف.
- بخش‌های ۱ و ۲ ساختار **موجود** را کامل می‌آورند، تا روشن باشد R4 به کدام بخش دست می‌زند (علامت **«R4»**) و به کدام نه.

## ۱. ستون‌ها، کلیدها، قیدها و ایندکس‌ها

### ۱.۱ `payout_orders` (ماژول settlement، `0049`)

| ستون | نوع | null | پیش‌فرض / توضیح |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `uuidv7()`، کلید اصلی |
| `statement_id` | `uuid` | NOT NULL | FK به `settlement_statements(id)` |
| `center_id` | `uuid` | NOT NULL | مرکز کاتالوگ؛ **بی FK** (مرز ماژول) |
| `entity_id` | `text` | NOT NULL | شرکت دفتر کل (آرامش ثروت) |
| `amount_rial` | **`bigint`** | NOT NULL | ریال؛ CHECK `> 0` |
| `iban_enc` | `text` | NOT NULL | **R4.** عکس شبای مرکز هنگام صدور، رمزشده (قاعده ۲۷)؛ context `payout_orders.iban:<id>`؛ **بی blind index** |
| `iban_last4` | `text` | NOT NULL | چهار رقم آخر، تنها بخش نمایش‌دادنی |
| `account_holder` | `text` | null | نام صاحب حساب |
| `status` | `text` | NOT NULL | `'issued'` |
| `issued_by` | `uuid` | null | |
| `issued_at` | `timestamptz` | NOT NULL | `now()` |
| `export_batch_id` | `uuid` | null | فایل بانکی |
| `exported_by`، `exported_at` | `uuid`، `timestamptz` | null | |
| `bank_tracking_ref` | `text` | null | شماره پیگیری بانک |
| `paid_on` | `date` | null | روز پرداخت |
| `tracking_recorded_by`، `tracking_recorded_at` | `uuid`، `timestamptz` | null | نفر اول |
| `confirmed_by`، `confirmed_at` | `uuid`، `timestamptz` | null | نفر دوم |
| `journal_entry_id` | `uuid` | null | سند دفتر کل پرداخت |
| `fail_requested_by`، `fail_requested_at`، `failure_reason` | `uuid`، `timestamptz`، `text` | null | درخواست شکست (نفر اول) |
| `failed_by`، `failed_at` | `uuid`، `timestamptz` | null | انجام شکست (نفر دوم) |
| `replaces_payout_id` | `uuid` | null | FK به `payout_orders(id)`، سفارش صدور دوباره |
| `created_at`، `updated_at` | `timestamptz` | NOT NULL | `now()`؛ `updated_at` با trigger `set_updated_at` |

**قیدها (همه بی‌تغییر در R4):**

- `payout_orders_amount_check`: `amount_rial > 0`.
- `payout_orders_status_check`: `status IN ('issued','sent_to_bank','confirmed','failed')`.
- `payout_orders_tracking_check`: شماره پیگیری null یا دست‌کم ۴ نویسه بی فاصله.
- `payout_orders_two_people_check`: `confirmed_by ≠ tracking_recorded_by` و `failed_by ≠ fail_requested_by`.
- `payout_orders_confirmed_check`:
  - `confirmed` اگر و فقط اگر `journal_entry_id` پر باشد.
  - `confirmed` یعنی شماره پیگیری، `paid_on`، `tracking_recorded_by`، `confirmed_by` و `confirmed_at` همه پر.
- `payout_orders_failed_check`: `failed` اگر و فقط اگر `failed_at` پر باشد؛ `failed` یعنی `failed_by` پر.
- **قالب `iban_enc`: هیچ CHECK ندارد** (برخلاف `instruments`). پیشنهاد افزودن: سؤال س۵.

**ایندکس‌ها (بی‌تغییر):**

- `payout_orders_live_key`: UNIQUE `(statement_id, center_id)` WHERE `status <> 'failed'`. هر مرکز در هر صورت‌وضعیت یک سفارش زنده.
- `payout_orders_tracking_key`: UNIQUE `(bank_tracking_ref)` WHERE `status <> 'failed' AND bank_tracking_ref IS NOT NULL`.
- `payout_orders_journal_key`: UNIQUE `(journal_entry_id)`.
- `payout_orders_status_idx`: `(status, issued_at)`.
- `payout_orders_batch_idx`: `(export_batch_id)`.

**triggerها و حق‌ها:**

- `payout_orders_guard` (BEFORE UPDATE): **R4 شاخه‌ای در آغاز آن می‌افزاید (§۵).** امروز:
  1. هر ستون بیرون از فهرست وضعیت تغییرناپذیر است: صورت‌وضعیت، مرکز، مبلغ و **شبا (`iban_enc`)**.
  2. سفارش `confirmed` یا `failed` کلاً تغییرناپذیر است، جز `updated_at`.
  3. گذار وضعیت فقط از مسیرهای §۲.۱.
- `payout_orders_set_updated_at` و `payout_orders_no_delete` (`reject_append_only_change`).
- `sepehr_app` فقط `UPDATE` ستونی روی ستون‌های وضعیت دارد؛ **نه** روی `iban_enc`. ابزار R4 با مالک schema اجرا می‌شود، پس هیچ حق تازه‌ای به نقش برنامه داده نمی‌شود.

### ۱.۲ `payout_order_nodes` (بی‌تغییر در R4)

| ستون | نوع | توضیح |
|---|---|---|
| `id` | `uuid` | `uuidv7()`، کلید اصلی |
| `payout_id` | `uuid` NOT NULL | FK به `payout_orders(id)` |
| `doctor_node_id` | `uuid` NOT NULL | بی FK (مرز ماژول) |
| `amount_rial` | **`bigint`** NOT NULL | CHECK `> 0` |
| `created_at` | `timestamptz` | `now()` |

- UNIQUE `(payout_id, doctor_node_id)`.
- فقط‌افزودنی (trigger `payout_order_nodes_append_only`)؛ `UPDATE` از `sepehr_app` گرفته شده.
- **ثابت:** جمع `amount_rial` گره‌های هر سفارش = `payout_orders.amount_rial`. سند پرداخت از همین گره‌ها ساخته می‌شود.

### ۱.۳ `instruments` (ماژول instrument، `0032`)

| ستون | نوع | null | توضیح |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `uuidv7()`، کلید اصلی |
| `credit_application_id` | `uuid` | NOT NULL | بی FK (مرز ماژول) |
| `delivery_id` | `uuid` | null | FK به `physical_deliveries(id)` |
| `item_id` | `uuid` | null | FK به `physical_delivery_items(id)` |
| `kind` | `text` | NOT NULL | `cheque` یا `promissory_note` |
| `issuer_person_id` | `uuid` | NOT NULL | |
| `role` | `text` | NOT NULL | `borrower` یا `guarantor` |
| `guarantor_id` | `uuid` | null | پر فقط برای ضامن |
| `amount_rial` | **`bigint`** | NOT NULL | ریال؛ CHECK `> 0` |
| `due_on` | `date` | null | |
| `bank_name` | `text` | null | |
| `number_enc` | `text` | NOT NULL | **R4.** شماره چک یا سفته، رمزشده؛ context `instruments.number` (`INSTRUMENT_NUMBER`) |
| `number_bidx` | `text` | NOT NULL | **R4.** blind index، دامنه `instrument_number` |
| `number_last4` | `text` | NOT NULL | ۱ تا ۴ نویسه |
| `sayad_registered_confirmed` | `boolean` | NOT NULL | `false` |
| `sayad_confirmed_at`، `sayad_confirmed_by` | `timestamptz`، `uuid` | null | |
| `status` | `text` | NOT NULL | `'received'` |
| `notes` | `text` | null | |
| `created_by` | `uuid` | NOT NULL | |
| `created_at`، `updated_at` | `timestamptz` | NOT NULL | `now()` |
| `deleted_at` | `timestamptz` | null | حذف منطقی |

**قیدها:**

- `instruments_amount_check`: `amount_rial > 0`.
- `instruments_role_check`: `role = 'guarantor'` اگر و فقط اگر `guarantor_id` پر باشد.
- `instruments_sayad_check`: تأیید صیاد با `sayad_confirmed_at` هم‌زمان است، و فقط برای چک.
- **`instruments_values_check` (R4 آن را گسترش می‌دهد، §۵):**
  - `kind IN ('cheque','promissory_note')` و `role IN ('borrower','guarantor')`.
  - `status IN ('received','verified','held','released','presented','cleared','bounced','legal_action')`.
  - **`number_enc LIKE 'v1.%' AND number_bidx LIKE 'v1.%'`**: این بخش در R4 به `~ '^(v1|k[0-9]{1,2})\.'` گسترش می‌یابد. باقی شرط بی‌تغییر می‌ماند.
  - `length(number_last4) BETWEEN 1 AND 4`.
  - چک فقط با تأیید صیاد از `received` جلوتر می‌رود.

**ایندکس‌ها (بی‌تغییر):**

- `instruments_application_idx`: `(credit_application_id)`.
- `instruments_number_key`: UNIQUE `(kind, number_bidx)` WHERE `deleted_at IS NULL`. **این همان قیدی است که در پنجره چرخش کلید سوراخ دارد** (§۷، یافته ی۱).
- `instruments_item_key`: UNIQUE `(item_id)` WHERE `item_id IS NOT NULL AND deleted_at IS NULL`.

**triggerها و حق‌ها:**

- `instruments_guard_change` (BEFORE UPDATE): **R4 شاخه‌ای در آغاز آن می‌افزاید.** امروز:
  1. فقط این ستون‌ها تغییر می‌کنند: `status`، ستون‌های صیاد، `notes` و `updated_at`.
  2. تأیید صیاد برنمی‌گردد.
  3. گذار وضعیت فقط از مسیرهای §۲.۳.
- `instruments_set_updated_at` و `instruments_no_delete`.
- `sepehr_app` فقط `UPDATE` روی همان ستون‌ها دارد.

### ۱.۴ جدول‌های وابسته‌ای که R4 به آن‌ها دست نمی‌زند

- **`instrument_executions` (`0062`):**
  - مبلغ `amount_rial` `bigint`، CHECK `> 0`، هرگز بیش از بدهی هنگام پیشنهاد.
  - سه نفر متفاوت: پیشنهاددهنده، مدیر وصول و مالی.
  - `bank_ref` شماره پیگیری بانک است، **نه** شماره چک. هیچ ستون رمزشده‌ای ندارد.
  - UNIQUE `(instrument_id)` WHERE `status IN ('proposed','presented')`.
- **`instrument_releases` (`0062`):** فقط‌افزودنی؛ UNIQUE `(instrument_id)`؛ بی ستون رمزشده.
- **`field_reencryption_runs` (`0077`):** UNIQUE `authorization_version_id`؛ `REVOKE ALL` از `sepehr_app`. R4 فقط از آن استفاده می‌کند.

## ۲. وضعیت‌ها، گذارها و idempotency

### ۲.۱ `payout_orders` (بی‌تغییر در R4)

| از | به | چه کسی | شرط |
|---|---|---|---|
| (ساخت) | `issued` | تصویب صورت‌وضعیت (`approve`، نفر دوم پس از `review`) | یک سفارش برای هر مرکز؛ جمع سفارش‌ها = `payable_rial` صورت‌وضعیت، وگرنه خطا و rollback |
| `issued` | `sent_to_bank` | `export` (مجوز `settlement.export_payouts`) | در یک دسته (`export_batch_id`) |
| `issued` | `failed` | دونفره: درخواست، سپس انجام توسط نفر دیگر | دلیل الزامی |
| `sent_to_bank` | `confirmed` | دونفره: ثبت شماره پیگیری و `paid_on` (نفر اول)، تأیید (نفر دوم) | ثبت دفتر کل در همان تراکنش؛ بی درخواست شکست باز |
| `sent_to_bank` | `failed` | دونفره، مثل بالا | ثبتی ندارد |
| `confirmed`، `failed` | — | پایانی | trigger هر تغییری را رد می‌کند |

- **صدور دوباره:** `reissue` روی سفارش `failed`، سفارش تازه `issued` با همان گره‌ها و مبلغ، و **شبای امروز مرکز** می‌سازد (`replaces_payout_id`). فقط وقتی صورت‌وضعیت هنوز `approved` است.
- **صورت‌وضعیت:** آخرین سفارش زنده که تأیید شود، صورت‌وضعیت را `paid` می‌کند.
- **صورت‌وضعیت بی مبلغ:** بی سفارش، بلافاصله `paid` می‌شود.
- **ترتیب قفل:** صورت‌وضعیت، سپس اقلامش (بدهی‌ها، سپس کارمزدها)، سپس سفارش‌ها. همه با `FOR UPDATE`.

**idempotency (کد امروز):**

- **تصویب دوباره:** روی `approved` یا `paid` هیچ کاری نمی‌کند.
- **تأیید دوباره:** روی `confirmed` هیچ کاری نمی‌کند.
- **کلید سند پرداخت:** `settlement:payout:<payoutId>:paid` (`payoutKey`)؛ تکرارش سند دوم نمی‌سازد (سند ۰۲ §۸ آزمون ۳). به‌علاوه UNIQUE `payout_orders_journal_key`.
- **شکست:** درخواست دوباره همان نفر هیچ کاری نمی‌کند؛ روی `failed` هم هیچ کاری نمی‌کند.
- **صدور دوباره:** اگر جایگزین هست، همان را برمی‌گرداند.
- **شماره پیگیری:** UNIQUE روی سفارش‌های زنده؛ تکرار یعنی ۴۰۹.
- **فایل بانکی:** `export` فقط سفارش‌های `issued` را برمی‌دارد؛ همان فایل با `exported(batchId)` دوباره گرفته می‌شود و چیزی جابه‌جا نمی‌شود.

### ۲.۲ بازرمزگذاری R4 (تازه، بی تغییر وضعیت)

- **هر ردیف، در هر وضعیتی، از جمله `confirmed` و `failed`:** فقط `iban_enc` (و `updated_at` با trigger) دوباره نوشته می‌شود. وضعیت، مبلغ، `journal_entry_id` و `statement_id` ثابت می‌مانند.
- **idempotency اجرا:**
  - هر نسخه تأییدشده `audit.field_reencryption` فقط یک اجرا دارد (UNIQUE `authorization_version_id`).
  - ردیفی که بر کلید فعال است رد می‌شود. پس اجرای قطع‌شده از سر گرفتنی است و اجرای دوباره چیزی را دوباره نمی‌نویسد.
  - دسته‌های ۵۰۰ ردیفی، هر دسته در یک تراکنش با `FOR UPDATE OF t`.
- **بن‌بست:** ابزار فقط ردیف‌های همین جدول را قفل می‌کند و هیچ قفل دیگری نمی‌خواهد. پس `confirm` و `export` فقط منتظر می‌مانند و بن‌بستی ساخته نمی‌شود.

### ۲.۳ `instruments` (بی‌تغییر در R4)

| از | به |
|---|---|
| `received` | `verified` (چک فقط با تأیید صیاد) |
| `verified` | `held` |
| `held` | `released` (آزادسازی پس از تسویه کامل) یا `presented` (اجرا) |
| `presented` | `cleared` یا `bounced` |
| `bounced` | `legal_action` |

- **idempotency و یکتایی:**
  - شماره تکراری: UNIQUE `(kind, number_bidx)`؛ `23505` به `409 instrument_exists`.
  - یک مدرک برای هر قلم تحویل: UNIQUE `item_id`.
  - یک اجرای باز برای هر مدرک.
  - کلید فیش وصول چک: `instrument:<id>:cleared`.
  - کلید پیامک آماده تحویل: `instrument:<id>:release-ready`.
- **بازرمزگذاری R4:** فقط `number_enc` و `number_bidx` (و `updated_at`). وضعیت، مبلغ، تأیید صیاد و `deleted_at` ثابت.

## ۳. رابطه با دفتر کل

### ۳.۱ ثبت‌های تازه R4: **هیچ**

- R4 هیچ سندی در `journal_entries` یا `ledger_entries` نمی‌سازد، معکوس نمی‌کند و نمی‌خواند.
- مبلغ، حساب، کلید عدم تکرار و `occurred_at` هیچ سندی تغییر نمی‌کند.
- آزمون ثابت (§۸): شمار و جمع هر دو جدول دفتر کل پیش و پس از اجرا برابر است.

### ۳.۲ ثبت‌های موجودی که این دو جدول به آن‌ها پیوند دارند (بی‌تغییر)

| رویداد | بدهکار | بستانکار | بند سند ۰۲ | کلید | کد |
|---|---|---|---|---|---|
| تأیید سفارش پرداخت (`settlement.payout_paid`) | `doctor.payable` (هر گره) | `bank.settlement` | §۴، سطر «پرداخت صورت‌وضعیت پزشک» | `settlement:payout:<id>:paid` | `payout.service.ts:405` |
| شکست سفارش | — | — | ثبتی ندارد | — | `payout.service.ts`، `fail` |
| وصول چک در اجرا، گام ۱ (`repayment.receipt_pending`) | `bank.collection` | `suspense.unallocated` | §۴، سطر «فیش در انتظار تأیید» | `instrument:<id>:cleared` | `execution.service.ts:360` به `registerReceipt` |
| وصول چک در اجرا، گام ۲ (`repayment.payment_allocated`) | `suspense.unallocated` | `borrower.debt` | §۴، سطر «تخصیص فیش تأییدشده به اقساط» | همان پرداخت | `approvePayment` |
| ثبت، تأیید، نگه‌داری، آزادسازی، برگشت و ارجاع حقوقی مدرک | — | — | ثبتی ندارد | — | — |

- **ثبت بیرون از سند ۰۲:** هیچ. R4 ثبتی ندارد، و همه ثبت‌های موجود مرتبط در جدول §۴ سند ۰۲ هستند.
- **ADR برای دفتر کل:** لازم نیست.
- **ADR غیر دفتر کل پیشنهادی:** ADR-040 «راه بازرمزگذاری از نگهبان‌های جدول‌های مالی» (س۷). شماره آخر در `docs/00` ADR-039 است.
- **سند ۰۲:** دست نمی‌خورد.

## ۴. مجوزها، پیکربندی و تغییر دونفره

### ۴.۱ مجوز تازه: **هیچ**

- **راه اجرا:** فقط CLI دستی (`pnpm security:reencrypt`)، با مالک schema (`MIGRATION_DATABASE_URL`). هیچ endpoint تازه‌ای ساخته نمی‌شود.
- **اجازه اجرا (موجود، `0077` و `0078`):** کلید پیکربندی `audit.field_reencryption`، دسته `technical`، **حساس**.
  - پیشنهاد: یک نفر با `config.manage_technical` (امروز نقش `system_admin`).
  - تأیید: نفر دوم. همان پیشنهاددهنده رد می‌شود (`config.service.ts:380`).
  - مقدار `{ "until": <زمان> }`. اجرا فقط تا `until` و یک‌بار برای هر نسخه.
  - همه گام‌ها audit دارند.

### ۴.۲ مجوزهای موجود این دو جدول (بی‌تغییر)

| مجوز | نقش‌ها | کار |
|---|---|---|
| `settlement.review_statement` | `accounting` | بازبینی، تصویب، ثبت و تأیید شماره پیگیری، شکست، صدور دوباره (هر گام دونفره) |
| `settlement.export_payouts` | `accounting` | فایل بانکی |
| `instrument.manage` | `case_completion` | ثبت و تغییر وضعیت مدرک |
| `instrument.read` | `case_completion`، `credit_manager`، `accounting`، `auditor` | دیدن و جست‌وجوی شماره |
| `instrument.view_numbers` | `case_completion` | شماره کامل، هر دیدن ثبت می‌شود |
| `instrument.propose_execution` | `collection` | پیشنهاد اجرا |
| `instrument.approve_execution_collection` | `collection_manager` | تأیید اول |
| `instrument.approve_execution_finance` | `accounting` | تأیید دوم |
| `instrument.record_outcome` | `accounting` | وصول یا برگشت |
| `instrument.approve_release` | `accounting` | آزادسازی |

- همه درخواست‌ها دامنه `global` می‌خواهند (`reach`)، و مالکیت پرونده در سرویس سنجیده می‌شود.

### ۴.۳ نرخ، سقف و عدد کسب‌وکار: **هیچ عدد تازه‌ای**

- R4 قاعده محاسبه، نرخ، کارمزد، سقف یا مهلتی ندارد.
- **اندازه دسته (۵۰۰):** ثابت فنی کد است (`REENCRYPTION_BATCH_SIZE`)، نه عدد کسب‌وکار. پیشنهاد: پیکربندی نشود.
- **کلیدهای موجود مرتبط (دست نمی‌خورند):** `settlement.payout_day`، `settlement.credit_service_fee`، `settlement.cash_service_fee`، `instrument.execution_min_days_past_due`، `instrument.sms_templates`.

## ۵. مهاجرت

### ۵.۱ شماره

- **از مخزن:** آخرین فایل `apps/api/drizzle/0082_config_version_guard.sql`؛ `_journal.json` آخرین `idx` = ۸۲، tag `0082_config_version_guard`؛ snapshot آخر `0082_snapshot.json`.
- **شماره آزاد بعدی: `0083`.** نام پیشنهادی: `0083_financial_key_forms`.
- شماره هنگام ساخت دوباره از مخزن خوانده می‌شود. اگر مهاجرت دیگری پیش از آن آمد، شماره بعدی گرفته می‌شود.

### ۵.۲ نوع: **مخرب** (`DROP CONSTRAINT` و `CREATE OR REPLACE FUNCTION` روی جدول‌های مالی)

- پیش از اجرا: خلاصه SQL، `pg_dump` روی `D:`، و **تأیید صریح مالک** (CLAUDE.md بند ۴).
- پس از اجرا: بررسی فقط‌خواندنی و drift.

### ۵.۳ خلاصه SQL پیشنهادی (همه در یک تراکنش مهاجرت)

1. **`instruments_values_check`:** `DROP CONSTRAINT`، سپس `ADD CONSTRAINT` با همان نام و همان شرط. فقط دو جزء عوض می‌شوند:
   - `"number_enc" ~ '^(v1|k[0-9]{1,2})\.'`
   - `"number_bidx" ~ '^(v1|k[0-9]{1,2})\.'`
2. **`CREATE OR REPLACE FUNCTION public.payout_orders_guard()`:** بدنه `0049` بی‌تغییر، و این شاخه در آغاز آن (همان الگوی تأییدشده `0079`):

   ```sql
   IF current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                      WHERE c.oid = TG_RELID) THEN
     IF EXISTS (
          SELECT 1 FROM field_reencryption_runs f
          WHERE f.id::text = current_setting('sepehr.field_reencryption_run', true)
            AND f.outcome = 'running'
        )
        AND (to_jsonb(NEW) - ARRAY['iban_enc', 'updated_at'])
          = (to_jsonb(OLD) - ARRAY['iban_enc', 'updated_at']) THEN
       RETURN NEW;
     END IF;
   END IF;
   ```

3. **`CREATE OR REPLACE FUNCTION public.instruments_guard_change()`:** بدنه `0032` بی‌تغییر، و همین شاخه با فهرست `ARRAY['number_enc', 'number_bidx', 'updated_at']`.
4. **اختیاری، اگر س۵ پذیرفته شود:** `ALTER TABLE payout_orders ADD CONSTRAINT payout_orders_iban_form_check CHECK ("iban_enc" ~ '^(v1|k[0-9]{1,2})\.')`.

- **دست نمی‌خورد:** هیچ ستون، داده، ایندکس، grant، trigger دیگر یا جدول دفتر کل.
- **برگشت:** مهاجرت معکوس (قید `LIKE 'v1.%'` و بدنه‌های قبلی)، فقط تا وقتی هیچ ردیفی `k2.` نشده است. پس از آن، برگشت یعنی اجرای دوباره ابزار با کلید ۱ فعال.

## ۶. کد [مالی]، بی تغییر قاعده

1. **`settlement.module.ts`:** `SETTLEMENT_CRYPTO` از `new FieldCrypto(secretKeyFromEnv('FIELD_ENCRYPTION_KEY'))` به `new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY'))`. با همه کلیدها می‌خواند و با کلید فعال می‌نویسد.
2. **`instrument.crypto.ts`:** `FieldCrypto` و `BlindIndex` هر دو با `keyRingFromEnv`.
3. **`settlement.reencryption.ts` (تازه):**
   - `columnReencryptor` روی `payout_orders`، ستون `iban_enc`، context `payout_orders.iban:<id>`.
   - `blockers()`: تا شاخه بازرمزگذاری در `payout_orders_guard` نیست، `payout_orders.payout_orders_guard` گزارش می‌شود.
   - `onRewrite`: audit هر ردیف در همان تراکنش (س۴).
4. **`instrument.reencryption.ts` (تازه):**
   - `columnReencryptor` روی `instruments`، ستون `number_enc` با نمایه `number_bidx` (دامنه `instrument_number`).
   - `blockers()` برای `instruments_guard_change`، و `onRewrite` با audit.
   - `pinnedConstraints()` از پیش `instruments_values_check` را تا `0083` مانع می‌شناسد.
5. **اگر س۲ گزینه (ب) پذیرفته شود:** جست‌وجو و بررسی تکرار شماره با نمایه زیر **همه** کلیدهای حلقه (§۷، یافته ی۱).
6. **دست نمی‌خورد:** مبلغ، وضعیت، دفتر کل، کارمزد، صادرات بانکی، ماشین وضعیت و هیچ قاعده محاسبه.

## ۷. یافته‌ها هنگام نوشتن نقشه

- **ی۱، باگ واقعی در پنجره چرخش کلید (`instruments`):**
  - `BlindIndex.of` فقط با کلید فعال می‌سازد (`blind-index.ts:25`). جست‌وجوی شماره (`instrument.service.ts:410`) و ثبت مدرک (`:318`) هر دو از آن استفاده می‌کنند.
  - پس از روشن شدن کلید ۲ و پیش از پایان اجرا، دو اثر دارد:
    1. جست‌وجو مدرک‌هایی را که هنوز نمایه `v1.` دارند **نمی‌یابد**.
    2. ثبت دوباره همان چک نمایه `k2.` می‌گیرد، و قید `instruments_number_key` با ردیف `v1.` برخورد نمی‌کند. یعنی **چک تکراری پذیرفته می‌شود.**
  - امروز اثری ندارد: کلید ۲ هیچ‌جا روشن نشده و جدول خالی است. راه‌حل: س۲.
- **ی۲، همان شکاف در ماژول‌های غیرمالی:** قیدهای UNIQUE روی blind index در پنجره چرخش همین سوراخ را دارند:
  - `centers_identifier_index_key` و `centers_sheba_index_key` (`0010`)
  - `doctors_national_id_index_key` (`0011`)
  - `persons_national_id_index_key` (`0015`)
  - این ماژول‌ها از ۹-۳ حلقه کلید دارند. بیرون از R4 مالی است؛ س۳.
- **ی۳:** `payout_orders.iban_enc` هیچ قید قالبی ندارد. متن ساده شبا را فقط کد برنامه مانع است، نه پایگاه داده (س۵).

## ۸. آزمون‌های ثابت (invariant)، پیش از commit

1. **پیش و پس از اجرا در جدول‌های مالی برابرند:**
   - `payout_orders`: شمار ردیف، `sum(amount_rial)`، توزیع `status`، و `journal_entry_id` و `statement_id` هر سفارش.
   - `payout_order_nodes`: شمار و جمع.
   - `instruments`: شمار، `sum(amount_rial)`، توزیع `status` و `deleted_at`.
2. **دفتر کل:**
   - `LedgerReconciliation` و `SettlementReconciliation` پاک.
   - شمار و جمع `journal_entries` و `ledger_entries` بی‌تغییر؛ هیچ ثبت تازه.
3. **رمزگشایی:** هر ردیف با کلید تازه همان شبا و شماره پیش از اجرا را می‌دهد. مقایسه درون آزمون است، نه در لاگ.
4. **فایل بانکی:** `exported(batchId)` پس از اجرا همان CSV پیش از اجرا را می‌دهد (بایت به بایت).
5. **جست‌وجو:** پس از اجرا، جست‌وجوی شماره هر چک همان چک را می‌یابد.
6. **تکرار در پنجره:** ثبت دوباره شماره‌ای که نمایه `v1.` دارد، پس از روشن شدن کلید ۲، رد می‌شود. این آزمون امروز **قرمز** است (ی۱) و با راه‌حل س۲ سبز می‌شود.
7. **نگهبان‌ها، مثل `center-guard.int.test.ts`:**
   - **پذیرفته:** فقط مالک، با اجرای `running`، و فقط ستون‌های رمز و نمایه، حتی روی سفارش `confirmed` و `failed`.
   - **رد:**
     - مالک بی اجرا، با اجرای پایان‌یافته، یا با شناسه نامعتبر؛
     - تغییر مبلغ، وضعیت، `journal_entry_id` یا `statement_id` در اجرا؛
     - نقش برنامه، با پیام نگهبان (نه خطای دسترسی).
8. **audit:** شمار رخدادهای چرخش برابر شمار ردیف‌های بازنوشته، بی مقدار.
9. **بی‌تغییری بقیه:** آزمون‌های موجود settlement و instrument بی تغییر ادعا سبز.

## ۹. ترتیب اجرا پس از تأیید

1. **commit [مالی] جدا:** مهاجرت `0083`، دو factory، دو بازرمزگذار و آزمون‌ها. پیش از اجرای مهاجرت: خلاصه SQL، `pg_dump` روی `D:`، تأیید مالک. پس از آن: بررسی فقط‌خواندنی و drift.
2. **استقرار با `_ACTIVE=1`:** رفتار امروز بی‌تغییر می‌ماند؛ فقط خواندن چندکلیدی فعال می‌شود.
3. **کلید ۲:** `FIELD_ENCRYPTION_KEY_2` و `BLIND_INDEX_KEY_2` فقط در محیط، هرگز در مخزن (قاعده ۲۹).
4. **پنجره نگه‌داری:**
   1. فایل بانکی، ثبت مدرک و جست‌وجوی شماره متوقف.
   2. `_ACTIVE=2` و راه‌اندازی دوباره.
   3. `--dry-run` (بی مانع).
   4. تأیید دونفره `until`.
   5. اجرا (پشتیبان خودکار پیش از نوشتن).
   6. `--dry-run` دوباره: صفر ردیف بر کلید غیرفعال.
   7. باز کردن کارها.
5. **کلید ۱:** تا پایان نگه‌داری آخرین پشتیبانِ پیش از چرخش بایگانی می‌ماند.

## ۱۰. ریسک‌ها

- **راه نگهبان روی مقصد پرداخت:** کسی با رمز مالک schema، در یک اجرای ثبت‌شده، می‌تواند `iban_enc` را با متن رمز شبای دیگری عوض کند.
  - این همان کسی است که امروز هم می‌تواند نگهبان را عوض کند، پس حق تازه‌ای پدید نمی‌آید.
  - مهار: تأیید دونفره، پشتیبان پیش از نوشتن، audit هر ردیف و آزمون §۸ بند ۴.
- **پنجره جست‌وجو و تکرار:** ی۱ (س۲).
- **قفل `ADD CONSTRAINT`:** کل `instruments` برای نوشتن قفل و سنجیده می‌شود. جدول کوچک است؛ در پنجره اجرا می‌شود (س۶).
- **پشتیبان‌های قدیمی:** متن رمز کلید ۱ دارند؛ کلید ۱ بایگانی می‌ماند.

## ۱۱. سؤال‌های باز برای مالک

| # | سؤال | گزینه‌ها | پیشنهاد |
|---|---|---|---|
| س۱ | سفارش‌های `confirmed` و `failed` هم بازرمزگذاری شوند؟ | (الف) بله؛ (ب) فقط زنده‌ها | **(الف)**. وگرنه کلید ۱ هرگز بازنشسته نمی‌شود. متن ساده یکی است و فقط متن رمز عوض می‌شود. |
| س۲ | سوراخ جست‌وجو و تکرار شماره چک در پنجره (ی۱) | (الف) فقط پنجره نگه‌داری با ثبت و جست‌وجوی متوقف، بی کد؛ (ب) جست‌وجو و بررسی تکرار با نمایه زیر همه کلیدهای حلقه، در `instrument.service.ts` (ماژول مالی، بی تغییر قاعده)، به‌علاوه پنجره | **(ب)**. پنجره فراموش‌شدنی است؛ (ب) قید را در هر حال نگه می‌دارد. |
| س۳ | همان شکاف در centers، doctors و persons (ی۲) | (الف) تسک غیرمالی جدا پیش از اولین چرخش واقعی؛ (ب) فقط پنجره | **(الف)**. |
| س۴ | audit هر ردیف بازنوشته (`settlement.payout_iban_key_rotated` و `instrument.number_key_rotated`، فقط شماره کلید و اجرا) | (الف) بله؛ (ب) فقط شمار هر جدول | **(الف)**، مثل `catalog.center_keys_rotated`. |
| س۵ | قید قالب روی `payout_orders.iban_enc` در `0083` | (الف) بله؛ (ب) نه | **(الف)**. پایگاه داده دیگر هرگز شبای متن ساده را نمی‌پذیرد. روی ردیف‌های امروز (۰ محلی) می‌گذرد. |
| س۶ | شکل افزودن قید | (الف) معمولی در پنجره؛ (ب) `NOT VALID` سپس `VALIDATE` | **(الف)**، جدول کوچک. |
| س۷ | ADR برای راه بازرمزگذاری از نگهبان‌های مالی | (الف) ADR-040؛ (ب) فقط همین فایل | **(الف)**. دو نگهبان مالی استثنا می‌گیرند. |
| س۸ | ترتیب | (الف) `0083` و کد با `_ACTIVE=1` اول، چرخش بعداً در پنجره؛ (ب) همه یکجا | **(الف)**. هر گام جدا برگشت‌پذیر است. |

## ۱۲. پاسخ‌های مالک (۱۴۰۵/۰۷/۲۲) و اجرا

| # | پاسخ | اجرا |
|---|---|---|
| س۱ | بله | سفارش `confirmed` و `failed` هم بازرمزگذاری می‌شود (نگهبان `0083`). |
| س۲ | بله (ضروری) | `BlindIndex.allOf` و `stableOf`؛ جست‌وجو زیر همه کلیدها؛ ثبت با قفل advisory و رد شماره ثبت‌شده زیر هر کلید (`instrument.service.ts`). |
| س۳ | بله، تسک جدا؛ در RESUME مانع روشن شدن کلید ۲ | ثبت در RESUME و ADR-040. |
| س۴ | بله، بی متن ساده و بی متن رمز | `settlement.payout_iban_key_rotated` و `instrument.number_key_rotated`، فقط شماره کلید و اجرا. |
| س۵ | بله؛ هر دو شکل قدیم و تازه در پنجره | `payout_orders_iban_form_check` با `^(v1\|k[0-9]{1,2})\.`. |
| س۶ | گزینه پیشنهادی | `ADD CONSTRAINT` معمولی، در پنجره. |
| س۷ | بله | ADR-040، پیشنهادی. |
| س۸ | بله | اول `0083` و کد با `_ACTIVE=1`؛ چرخش بعداً در پنجره. |

- **الزام مالک برای ADR-040:** هر ردیف پس از نوشتن در همان تراکنش دوباره خوانده و با متن ساده پیش از اجرا مقایسه می‌شود (`verifyRewrite` در `field-reencryption.ts`، برای همه جدول‌های ثبت‌شده با `columnReencryptor`). ناهمخوانی دسته را برمی‌گرداند و هر ردیف آن به شکل قبلی می‌ماند.
- **محدوده بررسی:** `catalog_import_rows` بازرمزگذار خودش را دارد (مقدارها درون JSON) و از این بررسی نمی‌گذرد. غیرمالی است؛ در تسک س۳ دیده می‌شود.

## ۱۳. اجرای `0083` (تأیید مالک ۱۴۰۵/۰۷/۲۲)

- **ADR-040 پذیرفته شد.**
- **آزمون جهش، تکرار شماره بین کلیدها** (لاگ‌ها در `D:\sepehr-backup\load10-logs\r4`):
  - **جهش ۱:** جست‌وجو فقط با نمایه کلید فعال. آزمون «during the rotation» قرمز شد (`expected [] to deeply equal [ Array(1) ]`).
  - **جهش ۲:** بررسی تکرار فقط با نمایه کلید فعال. ثبت دوباره همان چک پذیرفته شد (`promise resolved … instead of rejecting`) و دو آزمون قرمز شدند. یعنی قید یکتای پایگاه داده به‌تنهایی تکرار `v1.` و `k2.` را نمی‌گیرد.
  - هر دو تغییر موقت برگشت داده شدند (diff خالی).
- **نام آزمون:** «covers the non-financial tables only» اکنون «covers all nine tables with an encrypted field: seven non-financial, payouts and instruments (ADR-040)» است و شمار ۹ را صریح می‌سنجد.
- **پشتیبان پیش از مهاجرت:** `D:\sepehr_app\db-backups\sepehr-before-0083-20261014-141213.dump` (`pg_restore --list` بی‌خطا، ۲۷۷۹ سطر).
- **اجرا:** `pnpm build` و `pnpm db:migrate` (مالک schema). بررسی فقط‌خواندنی پس از آن:
  - ۸۴ مهاجرت.
  - `instruments_values_check` و `payout_orders_iban_form_check` هر دو validated و هر دو شکل را می‌پذیرند.
  - هر دو نگهبان شاخه بازرمزگذاری را دارند.
  - `payout_orders` و `instruments` محلی ۰ ردیف؛ دفتر کل بی‌تغییر (۱۹ سند، ۴۱ ثبت).
- **drift:** پاک. journal و snapshot همان `3c8a381`.
- **آزمون‌های R4 پس از `0083`** (`test/security`، `test/instrument`، `test/settlement`): ۱۵ از ۱۵ فایل، ۳۶۳ سبز (`after-0083-clean.log`).
  - یک اجرای پیشین (`after-0083.log`، ۱۳ قرمز) هم‌زمان با ویرایش کد ت۱ و ت۳ بود و کد نیمه‌کاره را برداشت (`null value in column "shift_version_id"`). بی‌اعتبار است و باگ کد نیست.
