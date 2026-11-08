# تسک ۶-۸ [مالی]: اجرای ابزار تضمین و بازگشت چرخه قسط

> **وضعیت:** نقشه تأیید شد (مالک، ۱۴۰۵/۰۷/۱۶). پاسخ‌ها و طراحی نهایی در پایین فایل.
>
> **پایه:**
> - سند ۱۵ §۶، و §۹ آزمون‌های ۱۲ و ۱۴.
> - سند ۱۶، تسک ۶-۸.
> - ماژول instrument (۴-۲).
> - ۶-۲: فیش، تأیید و تخصیص.
> - ۶-۷: مرحله ۴ تشدید و `chequeBounced`.
> - ۶-۴: پیامک.
>
> **کد مالی موجود دست نمی‌خورد:** ledger، wallet، اقساط و تخصیص بی‌تغییر می‌مانند. وصول چک فقط **همان مسیر ۶-۲** را صدا می‌زند (`registerReceipt` و `approvePayment`)، و ثبت دفتر کل همان ثبت ۶-۲ است.

## آنچه هست (کد موجود)

- **`instruments` (۴-۲):**
  - **شماره:** رمزشده (قاعده ۲۷)، با blind index و چهار رقم آخر.
  - **صادرکننده:** `issuer_person_id`، که وام‌گیرنده یا ضامن است.
  - **مبلغ و سررسید:** `amount_rial` و `due_on`.
  - **مسیرهای trigger:** `received` به `verified` به `held`؛ `held` به `released` یا `presented`؛ `presented` به `cleared` یا `bounced`؛ `bounced` به `legal_action`.
  - **نتیجه:** این مسیرها از پیش هستند. **تغییر جدول لازم نیست.**
- **`physical_deliveries`:** `archived` به `released`.
- **کانال‌های `payments.channel`:** `staff`، `manual_receipt` و `bank_statement`. CHECK آن در 0055 است.
- **6-7:** `CollectionService.chequeBounced(caseId)` کار مرحله ۴ (`legal_referral`) را می‌سازد. تصمیم آن با `collection_manager` است و هرگز با پیشنهاددهنده.

## طراحی

### ۱. پیشنهاد اجرا

- **کار:** کارشناس معوقات، روی پرونده‌ای که در صف معوقات باز است، یک ابزار `held` همان پرونده را برای اجرا پیشنهاد می‌کند، با دلیل.
- **شرط‌ها:**
  - **پرونده:** پرونده معوق است، یعنی آیتم باز صف ۶-۷ دارد.
  - **سررسید:** سررسید چک (`due_on`) رسیده باشد. چک آینده‌دار در بانک وصول‌شدنی نیست؛ وگرنه ۴۰۹ `not_due`.
  - **یکتایی:** برای هر ابزار فقط یک پیشنهاد باز.
- **تأیید:**
  - **تأییدکنندگان:** دو تأیید جدا، یکی مدیر معوقات (`collection_manager`) و یکی مالی (`accounting`).
  - **دونفرگی:** هر دو ≠ پیشنهاددهنده، و ≠ یکدیگر.
  - **وضعیت ابزار:** با تأیید دوم، `held` به `presented` می‌رود.
  - **رویداد:** `instrument.presented`.
- **آزمون ۱۲:** اجرا با یک کاربر واحد رد می‌شود. نفر دوم همان کاربر، یا پیشنهاددهنده، پاسخ ۴۰۹ `same_person` می‌گیرد.

### ۲. وصول (`cleared`): بازگشت چرخه قسط

- **کار:** حسابداری وصول را ثبت می‌کند، با تاریخ وصول و شماره پیگیری بانک.
- **همان تراکنش:**
  1. `presented` به `cleared` می‌رود.
  2. **`RepaymentPort.registerReceipt`:**

     | فیلد | مقدار |
     |---|---|
     | `channel` | `bank_statement` (پرسش ۲) |
     | `reference` | `instrument:{id}` (هرگز شماره چک) |
     | `amountRial` | مبلغ ابزار |
     | `receivedAt` | تاریخ وصول |
     | `payerName` | نام صادرکننده |
     | idempotency | `instrument:{id}:cleared` |

  3. **`approvePayment`:**
     - **تخصیص:** همان تخصیص ۶-۲، از قدیمی‌ترین قسط.
     - **مازاد:** در `suspense.unallocated` می‌ماند، طبق تصمیم ۶.۷ (تعیین تکلیف دستی حسابداری).
     - **کار موجود:** تکمیل Case و لغو یادآوری‌ها هم همان کار موجود ۶-۲ است.
  4. **رویداد:** `instrument.cleared`.
- **بازگشت چرخه:** وضعیت قسط‌ها زنده محاسبه می‌شود (ت۲).
  - **قسط‌ها:** قسط‌های پرداخت‌شده `paid` می‌شوند.
  - **صف معوقات:** چرخه شبانه ۶-۷ آیتم را `cured` یا `settled` می‌بندد. وعده‌های باز لغو و کارهای باز کنار گذاشته می‌شوند.
  - **کد تازه:** لازم نیست.
- **آزمون ۱۴:** پس از وصول، تراز دفتر کل و تطبیق شبانه سالم‌اند، چون ثبت همان ثبت ۶-۲ است.

### ۳. برگشت (`bounced`)

- **کار:** حسابداری برگشت را ثبت می‌کند، با تاریخ و دلیل از فهرست بسته: `insufficient_funds`، `signature_mismatch`، `account_closed` و `other` با توضیح.
- **همان تراکنش:**
  1. `presented` به `bounced` می‌رود.
  2. `collection.chequeBounced(caseId)` کار مرحله ۴ را می‌سازد.
  3. **رویداد:** `instrument.bounced`.
- **ثبت مالی:** هیچ.
- **ارجاع حقوقی:**
  - **تصمیم:** تصمیم مرحله ۴ در ۶-۷ است: پیشنهاد کارشناس، تصمیم `collection_manager`.
  - **وضعیت ابزار:** با تصمیم «ارجاع»، `bounced` به `legal_action` می‌رود.
  - **فراتر از آن:** کار حقوقی بیرون از سامانه است، و پول حاصل از آن یک فیش عادی ۶-۲ است.

### ۴. استرداد پس از تسویه کامل

- **کار برای حسابداری:**
  - **سازنده:** چرخه شبانه.
  - **شرط:** پرونده‌ای که همه برنامه‌های اقساطش تسویه کامل شده است. این از درگاه repayment خوانده می‌شود، با متد فقط‌خواندنی تازه `isSettled(caseId)`.
  - **محتوا:** فهرست ابزارهای `held` آن.
- **تأیید:**
  - **مجوز:** حسابداری با `instrument.approve_release`.
  - **وضعیت ابزار:** `held` به `released`.
  - **وضعیت تحویل:** وقتی همه ابزارهای یک تحویل `released`، `cleared` یا `legal_action` باشند، `physical_deliveries` از `archived` به `released` می‌رود.
- **پیامک به صاحب ابزار:**
  - **قالب:** قالب تازه `instrument.release_ready`، با فیلدهای `name` و `link`.
  - **ممنوع در متن:** هیچ شماره، مبلغ یا درمانی.
  - **مخاطب:** وام‌گیرنده، یا ضامن با قالب ضامن.
- **آزمون ۱۲ (بخش دوم):** استرداد پیش از تسویه کامل ۴۰۹ `not_settled` می‌گیرد، چه از API و چه از سرویس.

### ۵. شماره ابزار

- **هرگز** در پیامک، لاگ، CSV، audit یا outbox نمی‌آید. فقط `numberLast4` در view.
- **آزمون:** متن همه پیامک‌ها، رویدادها و audit این تسک را برای شماره کامل جست‌وجو می‌کند.

## مهاجرت پیشنهادی `0062_instrument_execution` (فقط افزودنی)

خلاصه SQL پیش از اجرا در همین فایل کامل می‌شود.

- **`instrument_executions`:**
  - **ستون‌ها:**
    - `instrument_id` و `case_id`.
    - **پیشنهاد:** `proposed_by` و `reason`.
    - **تأیید:** `collection_approved_by` و `finance_approved_by`.
    - **نتیجه:** `status` با مقدارهای `proposed|presented|cleared|bounced|rejected`؛ `outcome_at`، `bounce_reason` و `payment_id` (FK `payments`).
  - **CHECK سه‌نفره:** `proposed_by`، `collection_approved_by` و `finance_approved_by` همه متفاوت.
  - **یکتایی:** UNIQUE روی پیشنهاد باز هر ابزار.
  - **نگهبان:** guard مسیر.
  - **دسترسی:** GRANT ستونی.
- **`instrument_releases`:**
  - **ستون‌ها:** `case_id`، `instrument_id`، `created_at` (کار)، `approved_by`، `approved_at`.
  - **یکتایی:** UNIQUE `instrument_id`.
  - **نگهبان:** guard.
- **مجوزها:**

  | مجوز | نقش |
  |---|---|
  | `instrument.propose_execution` | `collection` |
  | `instrument.approve_execution_collection` | `collection_manager` |
  | `instrument.approve_execution_finance` | `accounting` |
  | `instrument.record_outcome` | `accounting` |
  | `instrument.approve_release` | `accounting` |

- **قالب پیامک:** `instrument.release_ready` برای وام‌گیرنده و ضامن.
- **دست‌نخورده:**
  - `instruments` و `payments`: هیچ ستون یا CHECK آن‌ها عوض نمی‌شود (پرسش ۲).
  - کد ledger، wallet و اقساط.

## آزمون‌ها

1. **آزمون ۱۲:**
   - اجرا با یک کاربر رد می‌شود. پیشنهاددهنده تأییدکننده نیست، و مدیر معوقات تأیید مالی را نمی‌دهد.
   - استرداد پیش از تسویه کامل ۴۰۹ می‌گیرد.
2. **آزمون ۱۴:** پس از پیشنهاد، تأیید، وصول، برگشت و استرداد، تراز دفتر کل صفر است و تطبیق شبانه (`LedgerReconciliation` و تطبیق ۴-۶b) سالم است.
3. **وصول:**
   - **پرداخت:** درست یک پرداخت `approved` با کلید ابزار. تکرار ثبت وصول، پرداخت دوم نمی‌سازد.
   - **قسط‌ها:** `paid` می‌شوند و آیتم صف ۶-۷ در چرخه بعد `cured` بسته می‌شود.
   - **مازاد:** در suspense می‌ماند.
4. **برگشت:** کار مرحله ۴ ساخته می‌شود. تصمیم ارجاع دونفره است و ابزار `legal_action` می‌شود. هیچ ثبت مالی ندارد.
5. **چک آینده‌دار:** ۴۰۹ `not_due`.
6. **استرداد:** کار پس از تسویه ساخته می‌شود؛ ابزار `released` و تحویل `released` می‌شود؛ پیامک بی‌شماره و بی‌مبلغ است.
7. **شماره هرگز:** در پیامک، audit، outbox یا CSV نمی‌آید.
8. **دسترسی:** بی‌مجوز ۴۰۳، و ابزار پرونده دیگر ۴۰۴.

## پرسش‌ها برای مالک

1. **تأیید نقشه.**
2. **کانال پرداخت چک وصول‌شده:**
   - **پیش‌فرض:** `bank_statement` با `reference = instrument:{id}`. سند هر دو را مجاز می‌داند.
   - **گزینه دیگر:** کانال تازه `cheque`. این گزینه CHECK جدول مالی `payments` را با DROP و ADD عوض می‌کند، پس طبق قاعده پرسیده می‌شود.
3. **تأییدکنندگان اجرا:**
   - **پیش‌فرض:** سه نفر جدا: پیشنهاددهنده معوقات، تأیید مدیر معوقات، و تأیید مالی.
   - **حداقل سند:** «دو کاربر»: مدیر معوقات و مالی، بی پیشنهاددهنده جدا.
4. **مبلغ چک بیش از بدهی باقی:**
   - **پیش‌فرض:** کل مبلغ وصول می‌شود و مازاد به suspense می‌رود (۶.۷، تعیین تکلیف دستی). چک قابل وصول جزئی نیست.
   - **گزینه دیگر:** چنین چکی اصلاً پیشنهاد نشود (۴۰۹).
5. **سفته:** اجرای سفته کار حقوقی است و پول مستقیم ندارد.
   - **پیش‌فرض نسخه اول:** فقط ارجاع حقوقی، از مسیر مرحله ۴ ۶-۷. وضعیت سفته `held` می‌ماند تا پیشنهاد اجرا، و پول حاصل فیش عادی ۶-۲ است.
   - **پرسش:** برای سفته هم `presented` (ثبت درخواست اجرائیه) ساخته شود؟
6. **تطبیق با صورت‌حساب بانک (۶-۳):** ردیف بانکی همان وصول ممکن است دوباره پیشنهاد تطبیق شود.
   - **پیش‌فرض:** پرداخت چک با `reference` و مبلغ و روز، هشدار تکراری ۶-۲ را برمی‌انگیزد، و تأیید دوباره بدون تصمیم صریح ممکن نیست. رفتار موجود ۶-۲ است و تغییر نمی‌کند.

## تأیید مالک (۱۴۰۵/۰۷/۱۶)

- **نقشه:** تأیید شد.
- **۱. کد مالی فاز ۱:** دفتر کل، کیف و اقساط بی‌هیچ تغییر می‌مانند.
- **۲. کانال:** چک وصول‌شده از کانال موجود `bank_statement` ثبت می‌شود. CHECK جدول `payments` دست نمی‌خورد.
- **۳. ارائه چک:** سه نفر متفاوت: پیشنهاددهنده، مدیر وصول و مالی. همه با audit.
- **۴. مبلغ بیش از بدهی:** چکی که از بدهی باقی بزرگ‌تر است رد می‌شود.
  - **suspense:** هیچ مازادی در حساب معلق ثبت نمی‌شود.
  - **اضافه‌پرداخت:** تا ADR جدا ممنوع است.
- **۵. سفته:** فقط ارجاع حقوقی.
  - **وضعیت «ارائه‌شده برای اجرا»:** ساخته نمی‌شود.
  - **ثبت:** در `pending-client-decisions.md` به‌عنوان سؤال حقوقی ثبت می‌شود (۶.۹).
- **۶. ورود صورت‌حساب بانک:** ردیفی که به پرداخت یک چک وصول‌شده پیشنهاد شود، برچسب «مربوط به چک» می‌گیرد. هشدار تکراری ۶-۲ بی‌تغییر می‌ماند.
- **سقف‌ها و مهلت‌ها:** همه قابل‌تنظیم در پنل.
- **مهاجرت:**
  1. خلاصه SQL پیش از اجرا.
  2. بررسی drift پیش از commit.
  3. pg_dump، اجرا، بررسی فقط‌خواندنی و گزارش.

## طراحی نهایی (پس از تأیید)

1. **پیشنهاد اجرا:**
   - **مسیر:** `POST /instrument/executions`، با `instrumentId` و `reason`. مجوز: `instrument.propose_execution`.
   - **شرط‌ها:**
     - **نوع ابزار:** چک در وضعیت `held`. سفته پاسخ ۴۰۹ `promissory_legal_only` می‌گیرد.
     - **سررسید چک:** رسیده است؛ وگرنه ۴۰۹ `not_due`.
     - **پرونده ابزار:** از مسیر برنامه اقساط خوانده می‌شود: کیف درخواست، سپس برنامه، سپس پرونده. پرونده دست‌کم `instrument.execution_min_days_past_due` روز معوق است (کلید پیکربندی، پیش‌فرض ۰). وگرنه ۴۰۹ `not_overdue`.
     - **مبلغ:** مبلغ چک ≤ مانده برنامه؛ وگرنه ۴۰۹ `exceeds_outstanding` (مالک ۴).
     - **یکتایی:** یک پیشنهاد باز برای هر ابزار.
   - **snapshot:** مبلغ، برنامه و پرونده روی ردیف قفل می‌شوند.
2. **دو تأیید، به هر ترتیب:**
   - **مسیر:** `POST /instrument/executions/:id/approve`.
   - **نقش تأییدکننده:**
     - **`collection_manager`:** با `instrument.approve_execution_collection`.
     - **مالی:** با `instrument.approve_execution_finance`.
     - **دارنده هر دو مجوز:** باید بگوید از کدام نقش تأیید می‌کند (`as: collection|finance`).
   - **دونفرگی:** هیچ دو امضایی از یک نفر نیست. پاسخ ۴۰۹ `same_person` است، و CHECK پایگاه داده هم این را می‌گیرد.
   - **بازبینی مبلغ:** در هر تأیید، مانده دوباره بررسی می‌شود (مالک ۴).
   - **با تأیید دوم:** ابزار از `held` به `presented` می‌رود. رویداد `instrument.presented`.
   - **رد پیشنهاد:** پیش از ارائه، هر تأییدکننده‌ای رد می‌کند، با دلیل (`rejected`). ابزار `held` می‌ماند.
3. **وصول:**
   - **مسیر:** `POST /instrument/executions/:id/cleared`، با `clearedOn` و `bankRef` (شماره پیگیری بانک، نه شماره چک). مجوز: `instrument.record_outcome`.
   - **مانده دوباره بررسی می‌شود:**
     - اگر مبلغ بیش از مانده است، ۴۰۹ `exceeds_outstanding` برمی‌گردد و ابزار `presented` می‌ماند.
     - **TODO(decision) ۶.۱۰:** تکلیف پولی که بانک داده ولی بیش از مانده است، تا ADR اضافه‌پرداخت با حسابداری.
   - **همان تراکنش:**
     1. **`registerReceipt`:**

        | فیلد | مقدار |
        |---|---|
        | `channel` | `bank_statement` |
        | `reference` | `instrument:{id}` |
        | `paidOn` | تاریخ وصول |
        | `payerName` | نام صادرکننده |
        | idempotency | `instrument:{id}:cleared` |

     2. **`approvePayment`.**
     3. ابزار `cleared` و اجرا `cleared` با `payment_id`.
     4. رویداد `instrument.cleared`.
   - **تکرار:** وصول دوباره پاسخ ۴۰۹ می‌گیرد، و کلید پرداخت تکراری نمی‌سازد.
4. **برگشت:**
   - **مسیر:** `POST /instrument/executions/:id/bounced`، با `bouncedOn`، `reason` (`insufficient_funds|signature_mismatch|account_closed|other`) و `note`.
   - **وضعیت:** ابزار و اجرا `bounced` می‌شوند.
   - **پس از commit:** درگاه تازه `COLLECTION_ESCALATION.chequeBounced(caseId)` کار مرحله ۴ را می‌سازد (کد ۶-۷).
   - **رویداد:** `instrument.bounced`.
   - **ثبت مالی:** هیچ.
5. **ارجاع حقوقی:**
   - **محرک:** تصمیم `done` روی کار `legal_referral` در ۶-۷.
   - **عمل:** درگاه تازه `INSTRUMENT_LEGAL.referToLegal(caseId, tx)` چک‌های `bounced` آن پرونده را `legal_action` می‌کند.
   - **سفته‌ها:** `held` می‌مانند (مالک ۵).
   - **تغییر در کد ۶-۷:** فقط یک فراخوانی درگاه در `decideEscalation`.
6. **استرداد:**
   - **فهرست:** `GET /instrument/releases/due` زنده محاسبه می‌شود: ابزارهای `held` درخواست‌هایی که مانده برنامه‌شان صفر است. این فهرست، «کار حسابداری» نقشه است.
     - **ماهیت:** جدول کار جدا ساخته نمی‌شود، چون فهرست از داده زنده است و ردیف کهنه نمی‌گیرد. برگشت‌پذیر است.
   - **تأیید:** `POST /instrument/:id/release` با `instrument.approve_release`.
     - **پیش از تسویه کامل:** ۴۰۹ `not_settled`. این بخش دوم آزمون ۱۲ است.
   - **با تأیید:**
     - **ابزار:** `released`.
     - **ثبت:** ردیف `instrument_releases`.
     - **تحویل:** وقتی هیچ ابزار `held`، `presented` یا `verified` ندارد، `archived` به `released` می‌رود.
     - **پیامک:** با قالب `instrument.release_ready_borrower` یا `instrument.release_ready_guarantor`، فقط `name`. بی‌شماره و بی‌مبلغ. نگه‌داشته‌شده پیامک نمی‌گیرد.
     - **رویداد:** `instrument.released`.
7. **برچسب «مربوط به چک» در ۶-۳:**
   - **ستون view:** ستون تازه `relatedToCheque` در ردیف‌های ورود صورت‌حساب.
   - **مقدار:** درست است وقتی `reference` پرداخت پیشنهادی با `instrument:` شروع شود. این داده خود ماژول repayment است.
   - **دست‌نخورده:** منطق تطبیق و هشدار.
8. **شماره ابزار:** هرگز در پیامک، audit، رویداد، CSV یا view جز `numberLast4`.

## خلاصه SQL مهاجرت `0062_instrument_execution` (پیش از اجرا)

فقط افزودنی است. جدول‌های `instruments`، `payments` و `physical_deliveries` هیچ ستون، CHECK یا trigger تازه‌ای نمی‌گیرند. فقط وضعیتشان، در مسیرهای موجود trigger ۰۰۳۲، با سرویس عوض می‌شود.

1. **`CREATE TABLE instrument_executions`:**

   | گروه | ستون‌ها |
   |---|---|
   | ارجاع و snapshot | `id`، `instrument_id` (FK)، `case_id`، `schedule_id`، `amount_rial` bigint |
   | وضعیت | `status` (پیش‌فرض `proposed`) |
   | پیشنهاد | `proposed_by` NOT NULL، `proposal_reason`، `proposed_at` |
   | تأیید | `collection_approved_by` و `_at`، `finance_approved_by` و `_at` |
   | رد | `rejected_by`، `reject_reason` |
   | نتیجه | `outcome_by`، `outcome_on` date، `bank_ref`، `bounce_reason`، `bounce_note`، `payment_id` (FK `payments`) |
   | زمان | `created_at`، `updated_at` |

   - **CHECK:**
     - **وضعیت:** `status` در `proposed|presented|cleared|bounced|rejected`.
     - **مبلغ:** `amount_rial > 0`.
     - **سه نفر متفاوت:**
       - `collection_approved_by <> proposed_by`
       - `finance_approved_by <> proposed_by`
       - `finance_approved_by <> collection_approved_by`
     - **ارائه:** `status` در `presented|cleared|bounced` یعنی هر دو تأیید پر هستند.
     - **وصول:** `(status = 'cleared') = (payment_id IS NOT NULL)`.
     - **برگشت:** `(status = 'bounced') = (bounce_reason IS NOT NULL)`، و `bounce_reason` در فهرست بسته.
     - **رد:** `(status = 'rejected') = (reject_reason IS NOT NULL)`.
   - **index:** UNIQUE `(instrument_id) WHERE status IN ('proposed','presented')`، و `(status)`.
   - **guard:**
     - **ستون‌های ثابت:** ستون‌های تعریف.
     - **تأییدها:** هر کدام یک‌بار پر می‌شود.
     - **مسیر:** `proposed` به `presented` یا `rejected`؛ `presented` به `cleared` یا `bounced`.
   - **trigger‌ها:** `set_updated_at` و منع DELETE.
   - **دسترسی:** `REVOKE UPDATE, DELETE`، و GRANT ستونی روی ستون‌های وضعیت.
2. **`CREATE TABLE instrument_releases`:**
   - **ستون‌ها:** `id`، `instrument_id` (FK، UNIQUE)، `case_id`، `approved_by` NOT NULL، `approved_at`، `sms_dispatch_id`.
   - **trigger‌ها:** append-only (منع UPDATE و DELETE).
   - **دسترسی:** `GRANT SELECT, INSERT`.
3. **پیکربندی:** کلید `instrument.execution_min_days_past_due`، دسته business، مقدار `0`.
4. **مجوزها:** `instrument.propose_execution`، `instrument.approve_execution_collection`، `instrument.approve_execution_finance`، `instrument.record_outcome` و `instrument.approve_release`.
   - **اعطاها:**

     | نقش | مجوزها |
     |---|---|
     | `collection` | `propose_execution` |
     | `collection_manager` | `approve_execution_collection` |
     | `accounting` | `approve_execution_finance`، `record_outcome`، `approve_release` |

5. **قالب‌های پیامک (transactional):**

   | قالب | مخاطب | متن |
   |---|---|---|
   | `instrument.release_ready_borrower` | borrower | «{{name}} گرامی، مدرک ضمانت شما آماده تحویل است.» |
   | `instrument.release_ready_guarantor` | guarantor | همان متن |

## تأیید مالک بر دو تغییر (۱۴۰۵/۰۷/۱۶)

1. **رد وصول وقتی بدهی پس از ارائه کم شده و چک از مانده بزرگ‌تر است:**
   - **پاسخ:** ۴۰۹ `exceeds_outstanding`.
   - **وضعیت چک:** `presented` می‌ماند.
   - **ثبت:** هیچ ثبتی در suspense نیست.
   - **هشدار:** هشدار برای مدیر وصول و مالی ساخته می‌شود، از درگاه موجود `ADMIN_NOTICES` و با دو اعلان:
     - **مدیر وصول:** کد `instrument.clearance_exceeds:{executionId}:collection`، با مخاطب `instrument.approve_execution_collection`.
     - **مالی:** کد `...:finance`، با مخاطب `instrument.approve_execution_finance`.
     - **محتوای پیام:** شناسه اجرا و مبلغ‌ها، بی شماره چک و بی نام.
     - **دیده‌شدن:** در `GET /config/notices` برای دارندگان هر مجوز دیده می‌شود.
   - **تعیین تکلیف آن پول:** سؤال باز ۶.۱۰ در `pending-client-decisions.md`.
2. **صف استرداد حسابداری:** زنده و فقط‌خواندنی، بی جدول جدا (`GET /instrument/releases/due`).

## اصلاح پیش از کد: مرجع پرداخت چک (۱۴۰۵/۰۷/۱۶)

- **دلیل:** تطبیق ۶-۳ پرداخت تأییدشده را فقط «دقیق» پیدا می‌کند، یعنی با همان شماره پیگیری بانک و همان مبلغ. اگر مرجع پرداخت `instrument:{id}` بود، ردیف بانکی هرگز به پرداخت چک نمی‌رسید و برچسب «مربوط به چک» هیچ‌وقت دیده نمی‌شد.
- **اصلاح:**
  - **مرجع پرداخت:** `reference` شماره پیگیری بانک است (`bankRef` که حسابداری در وصول وارد می‌کند).
  - **شناسه چک:** کلید عدم تکرار پرداخت، `instrument:{instrumentId}:cleared`، که ستون خود repayment است.
  - **برچسب:** درست است وقتی کلید پرداخت پیشنهادی با `instrument:` شروع شود.
- **هشدار تکراری ۶-۲:** بی‌تغییر است، و فیشی از همان واریز که دوباره وارد شود را هم می‌گیرد.
- **تأیید مالک:**
  - **اصلاح:** اصلاح بالا تأیید شد: `bankRef` شماره پیگیری بانک است، و یکتایی با کلید `instrument:…:cleared`.
  - **آزمون صریح خواسته‌شده:**
    - سطر صورت‌حساب با همان شماره پیگیری و مبلغ، برچسب «مربوط به چک» می‌گیرد.
    - فیش دوباره همان سپرده، هشدار تکراری ۶-۲ را می‌گیرد.

## اجرا (۱۴۰۵/۰۷/۱۶)

- **مهاجرت `0062_instrument_execution`:**
  - **ترتیب:** خلاصه SQL پیش از اجرا در همین فایل نوشته شد.
  - **پشتیبان:** `sepehr-before-0062-20261007-155534.dump`.
  - **بررسی فقط‌خواندنی:**
    - ۶۳ مهاجرت.
    - دو جدول با فقط SELECT و INSERT، به‌اضافه ۱۴ ستون UPDATE روی اجراها.
    - ۹ CHECK، از جمله سه‌نفره.
    - چهار trigger.
    - کلید ۰.
    - پنج اعطا.
    - دو قالب.
- **باگ واقعی که آزمون گرفت:** کد اعلان من (`instrument.clearance_exceeds:{id}:…`) با CHECK جدول `admin_notices` نمی‌خواند، چون فقط حروف کوچک، رقم و `_` مجاز است.
  - **اصلاح:** دو کد ثابت `instrument_clearance_exceeds_collection` و `instrument_clearance_exceeds_finance`.
  - **پیام:** هر بار از داده زنده بازسازی می‌شود، با شناسه اجراها و مبلغ‌ها.
  - **بسته شدن:** وقتی هیچ چک ارائه‌شده‌ای از مانده بزرگ‌تر نباشد بسته می‌شود. پس وصول یا برگشت یکی، دیگری را پنهان نمی‌کند.
- **دیده‌شدن هشدار:**
  - **مشکل:** `GET /config/notices` مجوز `config.read` می‌خواهد. مدیر وصول آن را ندارد، و نقشش طبق دستور مالک فقط دو اختیار دارد.
  - **راه‌حل:** به‌جای افزودن مجوز، `GET /instrument-executions/alerts` ساخته شد. دسترسی با یکی از دو مجوز تأیید است؛ فقط‌خواندنی و زنده است؛ و همان داده اعلان را دارد، فقط با چهار رقم آخر.
- **آزمون‌ها:** ۷ آزمون integration:
  1. آزمون ۱۲ با سه نفر، و وصول از مسیر ۶-۲ با آزمون ۱۴.
  2. برچسب «مربوط به چک» و هشدار تکراری ۶-۲ (آزمون صریح خواسته‌شده مالک).
  3. مالک ۴: رد در پیشنهاد، و رد در وصول با چک ارائه‌شده، هشدار هر دو نقش، بی ثبت؛ سپس برگشت، که هشدار را برمی‌دارد.
  4. برگشت: مرحله ۴، و تصمیم که به `legal_action` می‌انجامد، بی ثبت.
  5. سفته، `not_due` و `not_overdue`.
  6. استرداد: آزمون ۱۲ پیش از تسویه، صف زنده، تحویل `released`، و پیامک فقط با نام.
  7. دسترسی.
- **تغییر در کد موجود (غیرمالی):**
  - **۶-۷:** `decideEscalation` با تصمیم `done` روی `legal_referral`، درگاه `INSTRUMENT_LEGAL` را صدا می‌زند.
  - **۶-۳:** ردیف‌های صورت‌حساب ستون `relatedToCheque` گرفتند. منطق تطبیق دست نخورد.
  - **دست‌نخورده:** کد ledger، wallet، اقساط و تخصیص.
- **نتیجه اجرای کامل (پیش از commit):**
  - **turbo:** ۳۳ از ۳۳، با drift پاک.
  - **integration:** ۶۰ از ۶۰ فایل، ۵۴۲ آزمون. آزمون ۱۰٬۰۰۰ انتخاب این بار در اجرای جمعی هم سبز بود.
  - **آزمون ۱۰٬۰۰۰ انتخاب سند ۰۵، اجرای تنها:** ۵ از ۵.
  - **e2e:** ۳۲ از ۳۲.
- **آزمون‌های تغییرکرده:** هیچ. هیچ آزمونی حذف یا ضعیف نشد.
