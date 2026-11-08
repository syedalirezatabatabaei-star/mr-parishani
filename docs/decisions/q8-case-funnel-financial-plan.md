# سؤال ۸، مصرف‌کننده قیف پرونده: بررسی وابستگی مالی و نقشه (۱۴۰۵/۰۷/۲۳)

دستور مالک (۱۴۰۵/۰۷/۲۳، بند ۲):

- اول فقط گزارش داده شود: آیا هیچ کد مالی (کیف پول، اقساط، تسویه، payout، instruments) وضعیت پرونده را شرط می‌خواند؟
- اگر بله: توقف و نقشه مالی.
- اگر نه: ساخت.

**نتیجه: بله، یک مسیر. پس ساخته نشد.** هیچ کد، مهاجرت یا سندی برای ساخت عوض نشد. این فایل فقط گزارش و نقشه است.

## ۱. بررسی (فقط خواندن)

همه مصرف‌کنندگان `LEAD_CASES` بیرون از lead بررسی شدند، به‌علاوه هر خواندن `cases.status`، `OPEN_CASE_STATUSES`، `LOAN_CASE_STATUSES` و `CLOSED_CASE_STATUSES`.

| کد مالی | چه چیزی از پرونده می‌خواند | وضعیت را شرط می‌خواند؟ |
|---|---|---|
| **اقساط: `repayment.service.ts:698-699`** (تسویه آخرین قسط، `loan_settlements`) | `LEAD_CASES.completeCase(tx, actor, caseId)` | **بله، غیرمستقیم.** `lead-cases.adapter.ts:166-200` پرونده را فقط از `advising` (مستقیم) یا `in_treatment` (زنجیره) به `completed` می‌برد. در هر وضعیت دیگر، `new` هم، تکمیل نمی‌کند و هشدار `case_completion_alerts` و audit `lead.case_completion_pending` می‌سازد. نتیجه `caseCompleted` در audit `repayment.loan_settled` و payload رویداد outbox `loan.settled` می‌آید. **پول و دفتر کل اثر نمی‌گیرند.** |
| guard پایگاه داده `cases_guard_status` (0057) | — | همان قاعده: `completed` فقط از `advising`، یا گام زنجیره از `in_treatment`. |
| تکمیل دستی کارمند `POST /lead/cases/:id/complete` (`case.service.ts:240-250`) | — | همان: جز `advising` یا `in_treatment`، `case_not_ready`. |
| کیف: `funding.service.ts`، `credit-funding-facts.adapter.ts:63` | `caseFacts`: رشته درمان و شهر | نه. `closed` از `closed_at` می‌آید و قیف آن را عوض نمی‌کند. |
| کیف: `special-operations.service.ts:499`، و credit (لغو و رد) | `closeCase` (بستن با علت) | نه. از هر وضعیت باز `cancelled` می‌شود. |
| وصول: `collection.service.ts:275`؛ تسویه: `cash-service.service.ts:426` | `caseFacts` | نه. |
| payout، instruments (`execution.service.ts`، `instrument.service.ts`) | پیامک و نام | نه. |
| `LOAN_CASE_STATUSES` (`existing-customer.ts`)، `OPEN_CASE_STATUSES` (`intake.service.ts`، `person.service.ts`) | — | فقط lead، غیرمالی. قیف تا `proforma_issued` پرونده را «باز» نگه می‌دارد و این‌ها را عوض نمی‌کند. |

**چرا این مهم است:**

- قاعده 0057 (مالک ۱۴۰۵/۰۷/۱۵) `advising` را برگزید، چون «هیچ چیز پرونده را جلوتر نمی‌برد» (`task-6-2-decisions.md` §۲۰۱-۲۰۲).
- مصرف‌کننده قیف پرونده‌ها را به `appointment_booked`، `examined` و `proforma_issued` می‌برد. در لحظه تسویه آخرین قسط، پرونده در `proforma_issued` است، چون هیچ رویدادی آن را از `proforma_issued` جلوتر نمی‌برد.
- پس با قیف، **تسویه وام دیگر پرونده را تکمیل نمی‌کند**. هر پرونده تسویه‌شده هشدار می‌گیرد و کارمند هم نمی‌تواند دستی تکمیلش کند (`case_not_ready`).
- این تغییر رفتار یک مسیر اقساط است، با `caseCompleted = false` در audit و رویداد `loan.settled`. پول اثر نمی‌گیرد.

## ۲. گزینه‌ها

### گزینه الف (پیشنهاد): قیف تا `proforma_issued`، و گسترش قاعده تکمیل

قاعده تکمیل 0057 گسترش می‌یابد: «تکمیل مستقیم از هر وضعیت باز پیش از قرارداد که قیف به آن می‌رسد».

- **وضعیت‌ها:** `advising`، `appointment_booked`، `examined`، `proforma_issued`.
- **بی‌تغییر:**
  - `new` همچنان عبور نمی‌کند و هشدار می‌سازد (قاعده ۱۴۰۵/۰۷/۱۵).
  - `in_treatment` همان گام زنجیره است.
  - `credit_requested` تا `funded` امروز دست‌نیافتنی‌اند و بیرون می‌مانند.
- **کد مالی؟**
  - repayment دست نمی‌خورد.
  - تغییر در lead است: `lead-cases.adapter.ts` `completeCase`، `case.service.ts` تکمیل دستی، و یک فهرست مشترک `SETTLEABLE_CASE_STATUSES` در contracts.
  - تابع guard هم عوض می‌شود.
  - ولی نتیجه یک مسیر اقساط (`caseCompleted`) عوض می‌شود. پس طبق بند ۴ CLAUDE.md پرسیده می‌شود.
- **مهاجرت:** `0086_cases_guard_settleable.sql` فقط `CREATE OR REPLACE FUNCTION public.cases_guard_status()`:

  ```sql
  -- شرط امروز:
  AND NOT (NEW.status = 'completed' AND OLD.status = 'advising')
  -- شرط تازه:
  AND NOT (NEW.status = 'completed'
           AND OLD.status IN ('advising','appointment_booked','examined','proforma_issued'))
  ```

  - هیچ جدول، ستون یا ردیفی عوض نمی‌شود.
  - مانند 0057، جایگزینی تابع است و مالک باید آن را تأیید کند.
- **داده موجود:** پرونده‌ها (محلی ۸، همه `new`) و هشدارهای موجود بی‌تغییر می‌مانند.
- **آزمون‌ها:**
  - تسویه در هر یک از چهار وضعیت: `completed` و `caseCompleted = true`.
  - تسویه در `new`: هشدار و `false`، بی‌تغییر.
  - guard: `credit_requested` به `completed` همچنان رد می‌شود.
  - تکمیل دستی از `proforma_issued` با هشدار مجاز است.
  - جهش: برداشتن یکی از چهار وضعیت، آزمون را قرمز می‌کند.

### گزینه ب: قیف کامل تا `in_treatment`

مصرف‌کننده رویدادهای بعدی را هم می‌گیرد، تا پرونده تسویه‌شده از راه زنجیره به `in_treatment` برسد و قاعده 0057 بی‌تغییر بماند:

- `credit.application_submitted` به `credit_requested`؛
- `credit.decided` به `credit_decided`؛
- `contract.signed` به `contracted`؛
- `wallet.funded` به `funded`؛
- اولین ثبت خدمت به `in_treatment`.

- **کد مالی؟ بله، بیشتر:**
  - رویداد outbox تازه در تراکنش شارژ کیف (`funding.service.ts`) و ثبت خدمت لازم است. این‌ها کد کیف و خدمت‌اند.
  - مشکل دیگر: پرونده‌ای که کیفش شارژ شده ولی هرگز خدمتی نگرفته، در `funded` تسویه می‌شود و باز تکمیل نمی‌شود. پس قاعده تکمیل در هر حال گسترش لازم دارد.
- **نتیجه:** گزینه ب جانشین الف نیست، گام بعدی آن است (همان «یافته وابسته» §۵.۳).

### گزینه ج: قیف ساخته نشود

پرونده‌ها در `new` یا `advising` می‌مانند و گزارش قیف v1 همین را نشان می‌دهد (task-7-4). امروز همین برقرار است.

## ۳. پیشنهاد

**گزینه الف**، در یک تسک با دو قدم:

1. **[مالی]** مهاجرت 0086 (جایگزینی تابع guard) و `SETTLEABLE_CASE_STATUSES` در lead، با آزمون‌های بالا. پیش از اجرای 0086 پرسیده می‌شود.
2. **[غیرمالی]** مصرف‌کننده `lead.case_funnel` طبق دستور مالک (۱۴۰۵/۰۷/۲۳):
   - رویدادهای `booking.appointment_confirmed` و `booking.appointment_examined` تازه، و `proforma.issued` موجود.
   - حرکت فقط از مسیر `CaseService.move`، گام‌به‌گام.
   - `processed_events` در همان تراکنش جابه‌جایی.
   - هرگز به عقب؛ پرونده بسته بی‌تغییر.
   - **رویداد نامرتب:**
     - گام را نمی‌پرد. برای مثال اگر `examined` پیش از `appointment_confirmed` برسد و پرونده در `advising` باشد، مصرف‌کننده آن را با خطای قابل retry پس می‌دهد و `processed_events` ثبت نمی‌شود. صف BullMQ با backoff نمایی دوباره می‌کوشد (`outbox-relay.ts`: ۸ تلاش، از ۵ ثانیه)، تا رویداد پیشین برسد.
     - پس از سقف تلاش، کار در صف «failed» می‌ماند و لاگ worker هشدار می‌دهد. هرگز پرشی رخ نمی‌دهد.
   - کاربر audit سیستم است (`systemActor('lead.case_funnel')`).
   - **آزمون‌ها:** هفت آزمون نقشه §۵.۳، به‌علاوه جهش برای هر مسیر (هر نگاشت رویداد، idempotency، بی‌برگشتی، پرونده بسته، صبر بر رویداد نامرتب).

**ترتیب:** قدم ۱ پیش از قدم ۲. وگرنه از لحظه روشن شدن قیف، تکمیل خودکار پرونده‌های تسویه‌شده می‌ایستد.

**به‌روزرسانی اسناد و قواعد** (پس از تأیید و هنگام ساخت، با ذکر «تصمیم مالک ۱۴۰۵/۰۷/۲۳»). جاهایی که می‌گویند پرونده از `advising` جلوتر نمی‌رود:

- **سند و تصمیم‌ها:**
  - `docs/00-architecture-decisions.md:427` («این ماژول فقط `new → advising` و بستن را انجام می‌دهد»).
  - `docs/decisions/task-6-2-decisions.md` §۱۳۲ و §۲۰۱-۲۰۳ («مرحله واقعی Case تسویه‌شده: `advising`»).
  - `docs/decisions/task-3-4-decisions.md:48` و `task-7-4-decisions.md:46` (محدودیت شناخته‌شده).
  - RESUME: سؤال ۸ و ردیف پ۱۰-۳.
- **توضیح‌های کد:**
  - سرآغاز `drizzle/0057_cases_guard_completion.sql`: فقط ارجاع در 0086، چون مهاجرت اعمال‌شده ویرایش نمی‌شود.
  - `lead-cases.adapter.ts:172-175`.
  - `lead-cases.port.ts:101`.

امروز هیچ‌کدام عوض نشدند، چون ساخت متوقف شد.

~~**منتظر تأیید مالک:** گزینه الف (یا ب یا ج) و اجازه نوشتن 0086.~~ **تصمیم مالک ۱۴۰۵/۰۷/۲۳: گزینه الف؛ «0086 را بنویس».** ساخت در §۴.

## ۴. ساخت (تصمیم مالک ۱۴۰۵/۰۷/۲۳، گزینه الف)

### قدم ۱ [مالی، با تأیید مالک]: قاعده تکمیل

- **`SETTLEABLE_CASE_STATUSES`** در `packages/contracts/src/lead/lead.ts`: `advising`، `appointment_booked`، `examined`، `proforma_issued`.
- **`lead-cases.adapter.ts` `completeCase`** و **`case.service.ts` `completeSettled`** هر دو همین فهرست را می‌خوانند (به‌علاوه `in_treatment`). repayment دست نخورد.
- **مهاجرت `0086_cases_guard_settleable.sql`: نوشته‌شده، اجرانشده.** فقط `CREATE OR REPLACE FUNCTION public.cases_guard_status()`، با همان شرط §۲. هیچ جدول، ستون یا ردیفی عوض نمی‌شود. snapshot همان 0085 است (بی تغییر طرح). 0057 ویرایش نشد. Testcontainers آن را در هر اجرای آزمون می‌سازد.
  - روی پایگاه محلی اجرا نشد، چون 0085 هم هنوز اجرا نشده و مالک فقط «بنویس» گفت. ترتیب اجرا: 0085، سپس 0086.

### قدم ۲ [غیرمالی]: مصرف‌کننده `lead.case_funnel`

- **رویدادها:** `booking.appointment_confirmed` و `booking.appointment_examined` **از پیش** رویداد outbox بودند (`appointment-lifecycle.ts` `EVENT_OF`، payload با `caseId` nullable). booking عوض نشد. `proforma.issued` هم موجود بود.
- **نگاشت:** `CASE_FUNNEL_TARGETS` در contracts.
- **`CaseService.advanceFunnel`:**
  - پرونده با `FOR UPDATE` قفل می‌شود.
  - هر گام با همان `move` خصوصی (قاعده ۸) ثبت می‌شود: یک ردیف `case_status_changes` با `reason_code = 'funnel_event'` و `note` = شناسه رویداد، و یک audit `lead.case_status_changed`.
  - **بی پرش:** `appointment_booked` از `new` (با گذر از `advising`، که رویدادی ندارد) یا از `advising`؛ هر هدف دیگر فقط از وضعیت درست پیش از خودش.
  - پرونده عقب‌تر خطای `FunnelEventEarly` می‌گیرد. تراکنش برمی‌گردد، `processed_events` ثبت نمی‌شود و BullMQ دوباره می‌کوشد.
  - پرونده بسته، در هدف یا جلوتر: بی تغییر (هرگز به عقب).
- **`CaseFunnelConsumer`** (`case-funnel.consumer.ts`): کاربر audit `systemActor('lead.case_funnel')`، بی `accountId`. ثبت در API (`LeadModule`) و worker (`worker.module.ts`، با `CaseService`). نوبت بی پرونده: کاری نمی‌شود.

### آزمون‌ها

- **`test/lead/case-funnel.int.test.ts` (تازه، ۹ از ۹):** فهرست رویدادها؛ ۱ (دو گام، audit سیستم)؛ ۲؛ ۳ (تکراری یک‌بار، نامرتب صبر و retry)؛ ۴ (بسته، هم‌تراز، جلوتر)؛ ۵ (guard یک‌گامی)؛ ۶ (بی پرونده)؛ ۶ب (رویداد واقعی پیش‌فاکتور)؛ ۷ (گزارش `sales_funnel`).
- **`test/lead/case-completion.int.test.ts` (۱۲ از ۱۲؛ تغییرکرده، گزارش):**
  - `it.each` «پرش به completed رد می‌شود» `examined` را نداشت. حالا `examined` طبق تصمیم مالک مجاز است. پس `examined` از این فهرست به آزمون تازه «تکمیل از سه وضعیت قیف» رفت، و `credit_requested` و `credit_decided` به فهرست رد افزوده شدند. هیچ ادعای دیگری حذف یا ضعیف نشد.
  - تازه: تکمیل از `appointment_booked`، `examined` و `proforma_issued` (guard و پورت، بی هشدار)؛ `credit_requested` با هشدار؛ تکمیل دستی از `proforma_issued` مجاز و از `credit_requested` `case_not_ready`.

### جهش‌ها (هر هفت قرمز شدند)

| جهش | نتیجه |
|---|---|
| شرط «صبر برای وضعیت پیشین» برداشته شود (پرش) | ۲ قرمز |
| یک‌جا به هدف برود، بی گام میانی | ۲ قرمز |
| نگاشت غلط: تأیید نوبت به `examined` | ۴ قرمز |
| ادعای `processed_events` در دیسپچر برداشته شود | ۱ قرمز |
| کاربر audit دیگر | ۱ قرمز |
| `proforma_issued` از `SETTLEABLE_CASE_STATUSES` برداشته شود | ۲ قرمز |
| 0086 به «فقط `advising`» برگردد | ۴ قرمز |

بی‌برگشتی و پرونده بسته جهش هم‌ارز دارند: با برداشتن شرطشان هم برش زنجیره خالی است و حرکتی نمی‌شود. آزمون ۴ رفتار را می‌پوشاند.

### یافته (برای مالک)

- **پیش‌فاکتور بی معاینه:** پیش‌فاکتور روی هر نوبتِ دارای ارجاع صادر می‌شود، و ارجاع هنگام درخواست نوبت ساخته می‌شود. پس پیش‌فاکتور ممکن است پیش از تأیید یا معاینه نوبت صادر شود (آزمون ۶ب، با رویداد واقعی).
- **رفتار امروز، طبق دستور «هرگز گام نپرد»:** آن رویداد صبر می‌کند و retry می‌شود. اگر معاینه هرگز ثبت نشود، پس از ۸ تلاش در صف «failed» می‌ماند و پرونده در وضعیت پیشین خود می‌ماند.
- پول اثر نمی‌گیرد. تکمیل هنگام تسویه از هر وضعیت پیش از `proforma_issued` هم (جز `new`) ممکن است.
- **پیشنهاد، بی اجرا:** یا مرکز معاینه را پیش از صدور پیش‌فاکتور ثبت کند (قاعده booking یا proforma)، یا مالک اجازه دهد `proforma.issued` از `appointment_booked` با گذر ثبت‌شده از `examined` جلو برود.

## ۵. پیش‌فاکتور فقط پس از معاینه (تصمیم مالک ۱۴۰۵/۰۷/۲۳، گزینه ۱؛ گزینه ۲ رد شد)

- **کد:**
  - `ProformaService.issue` در همان تراکنش صدور، وضعیت نوبتِ ارجاعِ پیش‌فاکتور را از پورت booking (`REFERRAL_DIRECTORY.referral`) می‌خواند.
  - جز `examined`، پاسخ ۴۰۹ `appointment_not_examined` می‌دهد، با `appointmentStatus`.
  - پیام فارسی در `packages/ui/src/app/errors.ts`: «پیش‌فاکتور فقط پس از ثبت معاینه همین نوبت صادر می‌شود. اول معاینه را در نوبت ثبت کنید.»
  - پیش‌نویس همچنان پیش از معاینه ساخته می‌شود. فقط صدور بسته است.
  - **مبلغ یا محاسبه دست نخورد:** قیمت‌گذاری، جمع، اعتبار و انقضا همان است و شرط پیش از آن‌ها می‌آید.
- **پورت:** `ReferralRecord.appointmentStatus` تازه است (فقط افزودنی). پرس‌وجوی booking با `JOIN appointments`، درون ماژول booking.
- **پنل مرکز:** پیوند «صدور پیش‌فاکتور» فقط برای نوبت `examined` نشان داده می‌شود (پیش‌تر `checked_in` هم).
- **رویدادی که به failed می‌رود:** سازوکار هشدار موجود `QueueMonitor` است (`queue_failed`، آستانه `ops.queue_alert_thresholds.maxFailed`، لاگ و سنجه `sepehr.alerts.active` برای Grafana). هشدار در پنل کارمند نیست. پس کد تازه‌ای ساخته نشد و بند ۶ چک‌لیست راه‌اندازی RESUME ثبت شد.
- **پیامد برای قیف:** هر `proforma.issued` حالا پس از `booking.appointment_examined` همان نوبت است. پس یافته §۴ بسته شد (آزمون ۶ب: رویدادهای واقعی پرونده را تا `proforma_issued` می‌برند).

### آزمون‌ها

- **تازه:** `proforma.int.test.ts`: «only once the appointment is examined». پیش‌نویس ۲۰۱؛ صدور در `requested`، `confirmed` و `checked_in` ۴۰۹ با همان وضعیت، بی رویداد `proforma.issued`؛ پس از معاینه ۲۰۱.
- **تغییرکرده: آزمون ۶ب `case-funnel.int.test.ts`.** پیش‌تر نشان می‌داد پیش‌فاکتورِ بی معاینه صبر می‌کند. حالا رویدادهای واقعی تأیید، معاینه و صدور، و صبر رویدادِ زودرس را نشان می‌دهد.
- **fixtureها، بی ضعیف شدن ادعا:** هر جا آزمون پیش‌فاکتور صادر می‌کرد، نوبت اول از راه API مرکز معاینه می‌شود (تأیید، پذیرش با کد بیمار، معاینه). helper تازه `test/booking/examine.ts`.
  - **فایل‌ها:** `test/credit/world.ts` (`confirmedProforma` و `examine`)، `proforma.int.test.ts` (`referred`)، `tickets.int.test.ts`، `service.int.test.ts`، `credit-applications.int.test.ts`.
  - **e2e:** `seed-funded.ts` (کلید تازه `center`) و `support.ts` (`bookedAndCheckedIn` به `bookedAndExamined`، با کلیک «معاینه شد»). e2e اجرا نشد.
- **جهش:** شرط برداشته شود: ۱ قرمز.

## ۶. ماشین وضعیت پرونده: گزارش فقط‌خواندنی (دستور مالک ۱۴۰۵/۰۷/۲۳، بند ۳)

> **تصمیم مالک ۱۴۰۵/۰۷/۲۳: گزینه ج تأیید شد (فعلاً هیچ کاری).** هر تسکی که روزی پرونده را تا `credit_requested` یا `funded` ببرد، باید در **همان تسک** شرط تکمیل (`SETTLEABLE_CASE_STATUSES` و تابع نگهبان) را گسترش دهد (گزینه الف پایین).

بی تغییر کد. وضعیت کد پس از `a242abf` و تسک «پیش‌فاکتور فقط پس از معاینه»، با مهاجرت 0086 (نوشته‌شده؛ روی کپی تمرین شد، روی پایگاه اصلی اجرا نشده).

### ۶.۱ وضعیت‌ها (`CASE_STATUSES`، `packages/contracts/src/lead/lead.ts`)

| # | وضعیت | گروه | امروز کسی پرونده را به آن می‌برد؟ |
|---|---|---|---|
| ۱ | `new` | باز، پیش از قرارداد | بله، ورود (`LeadIntakeService.openCase`) |
| ۲ | `advising` | باز | بله، مشاور؛ یا قیف در گذر |
| ۳ | `appointment_booked` | باز | بله، قیف |
| ۴ | `examined` | باز | بله، قیف |
| ۵ | `proforma_issued` | باز | بله، قیف |
| ۶ | `credit_requested` | باز | **نه** |
| ۷ | `credit_decided` | باز | **نه** |
| ۸ | `contracted` | وام در جریان (`LOAN_CASE_STATUSES`) | **نه** |
| ۹ | `funded` | وام در جریان | **نه** |
| ۱۰ | `in_treatment` | وام در جریان | **نه** |
| ۱۱ | `completed` | بسته | بله، تسویه وام یا کارمند |
| ۱۲ | `cancelled` | بسته | بله، کارمند، credit یا کیف |

### ۶.۲ گذارها

**نگهبان پایگاه داده `cases_guard_status`** (0015، 0057، 0086):

- **درج:** فقط `new`.
- **پرونده بسته:** دیگر حرکت نمی‌کند.
- **مجاز:** یک گام رو به جلو در زنجیره ۱ تا ۱۱؛ `cancelled` از هر وضعیت باز؛ و `completed` مستقیم از `advising`، `appointment_booked`، `examined` و `proforma_issued` (0086).
- `cancelled` علت از فهرست می‌خواهد (`cases_closed_check`).

| گذار | چه کسی (ماژول، نقش) | مسیر کد |
|---|---|---|
| (درج) به `new` | ورود: اپ، وردپرس، اکسل، مشاور؛ و booking برای نوبت | `intake.service.ts` `openCase`؛ booking از راه `LEAD_CASES` |
| `new` به `advising` | کارمند با `lead.update_cases` (نقش `advisor`، با دامنه خودش، R18) | `POST /lead/cases/:id/advising`، `CaseService.startAdvising` |
| `new` به `advising` به `appointment_booked` | سیستم، `lead.case_funnel`، رویداد `booking.appointment_confirmed` | `CaseService.advanceFunnel` |
| `appointment_booked` به `examined` | سیستم، رویداد `booking.appointment_examined` | همان |
| `examined` به `proforma_issued` | سیستم، رویداد `proforma.issued`. صدور از این پس فقط پس از معاینه است. | همان |
| `proforma_issued` به `credit_requested`، و هر گام تا `in_treatment` | **هیچ کدی** (فقط نگهبان اجازه می‌دهد) | — |
| `advising` تا `proforma_issued` به `completed` | سیستم: تسویه آخرین قسط (repayment، بازیگرِ همان پرداخت) | `repayment.service.ts:699` به `LEAD_CASES.completeCase` |
| همان | کارمند با `lead.update_cases`، فقط پرونده‌ای با هشدار تکمیل | `POST /lead/cases/:id/complete`، `CaseService.completeSettled` |
| `in_treatment` به `completed` | گام زنجیره. همان دو مسیر بالا، ولی `in_treatment` امروز دست‌نیافتنی است. | همان |
| هر وضعیت باز به `cancelled` | کارمند با `lead.update_cases` (علت از فهرست) | `CaseService.cancel` |
| همان | credit: لغو درخواست (`treatment_cancelled`) | `credit-cancellation.service.ts:190` به `closeCase` |
| همان | credit: رد نهایی (`credit_rejected`) | `credit-decision.service.ts:619` |
| همان | کیف: عملیات ویژه لغو درمان (`treatment_cancelled`) | `special-operations.service.ts:499` |

### ۶.۳ کدام وضعیت‌ها به `completed` می‌رسند

| وضعیت هنگام تسویه وام | تکمیل خودکار؟ | راه کارمند |
|---|---|---|
| `new` | نه؛ هشدار `case_completion_alerts` (قاعده ۱۴۰۵/۰۷/۱۵) | **دارد:** `advising` (`startAdvising`)، سپس `complete` |
| `advising` تا `proforma_issued` | **بله** (0086) | — |
| `credit_requested` تا `funded` | نه؛ هشدار | **ندارد:** `complete` پاسخ `case_not_ready` می‌دهد و هیچ endpointی پرونده را جلو نمی‌برد |
| `in_treatment` | بله (گام زنجیره) | — |
| `completed`، `cancelled` | بی تغییر (بسته)؛ `false`، بی هشدار | — |

### ۶.۴ آیا پرونده‌ای با وام تسویه‌شده می‌تواند بی راه تکمیل بماند؟

**امروز، با کد فعلی: نه.**

- پرونده وام‌دار فقط می‌تواند در `new` تا `proforma_issued` باشد، چون هیچ کدی آن را به `credit_requested` یا جلوتر نمی‌برد.
- `new` راه دستی دارد: مشاور، سپس تکمیل. بقیه خودکار تکمیل می‌شوند.
- پرونده بسته‌شده پیش از تسویه، مثلاً با لغو درمان، بسته می‌ماند و هشدار نمی‌گیرد.

**بله، در دو حالت که امروز رخ نمی‌دهند:**

1. **پرونده در `credit_requested` تا `funded` (یا `in_treatment` بی گام بعد):** اگر روزی کدی (گزینه ب سؤال ۸) یا ویرایش دستی پایگاه داده پرونده را به آن‌جا ببرد، و وام پیش از `in_treatment` تسویه شود (مثلاً کیف شارژ شده و هیچ خدمتی ثبت نشده)، پیامدها:
   - `completeCase` هشدار می‌سازد؛
   - کارمند `case_not_ready` می‌گیرد؛
   - هیچ گامی جلو نیست، و پرونده تا ابد باز می‌ماند؛
   - اگر در `credit_requested` یا `credit_decided` باشد، در `OPEN_CASE_STATUSES` هم هست، پس ورود تازه همان شخص «تکراری فعال» حساب می‌شود و به این پرونده می‌چسبد.

   پول اثر نمی‌گیرد (`loan_settlements` و دفتر کل جدا هستند).
2. **داده پیش از قیف:** پرونده‌هایی که پیش از روشن شدن مصرف‌کننده نوبت، معاینه یا پیش‌فاکتور داشته‌اند، در `new` یا `advising` مانده‌اند. همان راه بالا را دارند (خودکار از `advising`، دستی از `new`)، پس بی راه نیستند. فقط آمار قیفشان کم است.

### ۶.۵ نقشه مالی (فقط برای حالت ۱؛ بی اجرا)

برای وقتی که پرونده از `proforma_issued` جلوتر برود (گزینه ب)، پیش از آن تسک:

- **الف، پیشنهاد:** `SETTLEABLE_CASE_STATUSES` و تابع نگهبان (مهاجرت تازه، فقط `CREATE OR REPLACE FUNCTION`) به `credit_requested`، `credit_decided`، `contracted` و `funded` گسترش یابد. پیامدها:
  - همه وضعیت‌های باز به‌جز `new` تکمیل‌پذیر می‌شوند.
  - کد repayment دست نمی‌خورد.
  - فقط نتیجه `caseCompleted` در audit `repayment.loan_settled` و رویداد `loan.settled` برای این وضعیت‌ها `true` می‌شود.
  - آزمون: تسویه در هر وضعیت، و جهش.
- **ب:** تکمیل دستی کارمند (`completeSettled`) از هر وضعیت باز با هشدار مجاز شود (فقط lead)، و تکمیل خودکار همان بماند.
- **ج:** کاری نشود تا گزینه ب سؤال ۸. امروز همین برقرار است و حالت ۱ رخ نمی‌دهد.

**پیشنهاد:** ج تا تصمیم گزینه ب سؤال ۸؛ و الف در همان تسک، پیش از هر کدی که پرونده را از `proforma_issued` جلوتر ببرد.
