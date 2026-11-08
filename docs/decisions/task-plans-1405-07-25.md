# سه نقشه، فقط متن (۱۴۰۵/۰۷/۲۵ = ۲۰۲۶-۱۰-۱۷)

دستور مالک: «فقط نقشه (بدون کد) بنویس: ۱) انتخابگر پزشک … ۲) ۷ مسیر مالی بدون schema … ۳) تغییر موبایل بیمار … کد مالی نساز.»
در این فایل هیچ کدی ساخته نشده و هیچ مهاجرتی اجرا نشده است. هر سه منتظر تأیید جدای مالک‌اند.

---

## ۱. انتخابگر پزشک (ف۷): **از پیش ساخته شده است**

**یافته:** این مورد در دور دوازدهم با نقشه ۲ (`backlog-plans-1405-07-23.md` §۲) ساخته و commit شده است (`82a5235`).
فهرست مسدودی‌های دورهای ۲۰ تا ۲۲ و جدول ف در RESUME کهنه بودند و این دور اصلاح شدند. پس کار تازه‌ای نمی‌ماند. آنچه هست، برای بازبینی مالک:

| بخش | آنچه ساخته شده |
|---|---|
| مسیر | `GET /wallet/purses/:id/doctor-candidates?q=` (`apps/api/src/modules/wallet/special-operations.controller.ts`) |
| مجوز | `wallet.request_doctor_change` در controller، و دوباره در سرویس (`require` و `reachable`: دامنه کیف، ضد IDOR) |
| پاسخ | `@ZodResponse(z.array(doctorCandidateSchema))`؛ حداکثر ۲۰ ردیف؛ فقط پزشکان همان رشته و همان شهر، بی پزشک فعلی |
| نام پزشک | فقط برای دارنده `access.view_treatment` (سند ۰۴ §۴). بقیه فقط مرکز و شعبه را می‌بینند و با نام جست‌وجو نمی‌کنند. RESUME سؤال ۱۵: اگر باید ببینند، مجوز از پنل داده می‌شود، بی کد |
| هیچ نوشتنی | کل خواندن در یک تراکنش `accessMode: 'read only'` است، پس Postgres هر نوشتن را رد می‌کند. `WalletPort.scopeOf` فقط خواندن است. هیچ audit، outbox یا ledger |
| خطاها | `purse_not_found` (404)، `purse_not_funded` (409)، 403 بی مجوز، و کیف بیرون از دامنه پنهان |
| آزمون | `apps/api/test/wallet/special-operations.int.test.ts`: فهرست، یکسان‌سازی «ي/ك» در جست‌وجو، جست‌وجو با نام فقط با `view_treatment`، 403 برای حسابداری، 404 برای کیف ناموجود، پنهان بودن بیرون از دامنه. سه جهش قرمز بود. مرحله e2e: درخواست از انتخابگر، رد به دست مدیر اعتبار |

**ریسک باقی‌مانده:** ندارد.

---

## ۲. هفت مسیر مالی بی شمای پاسخ

**هدف:** هر پاسخ همان است که امروز برمی‌گردد. فقط `@ZodResponse` افزوده می‌شود، که در آزمون‌ها (`SEPEHR_CHECK_RESPONSES=1`) هر پاسخ را می‌سنجد و `openapi.json` و کلاینت را نوع‌دار می‌کند.
**هیچ تغییری در منطق، SQL یا ثبت مالی نیست.** با این حال فایل‌ها در ماژول‌های ledger، wallet و repayment‌اند، پس طبق CLAUDE.md §۴ بند ۴ با تأیید مالک.

**قاعده مشترک:** مبلغ‌ها رشته ریال‌اند، با `rialString = z.string().regex(/^-?\d+$/)`. شمای تازه در `packages/contracts` می‌آید (`ledger.ts`، `wallet.ts` و `repayment.ts`، هر کدام کنار شماهای موجود همان ماژول). اسکیما به‌صورت non-strict سنجیده می‌شود، پس فیلد اضافه پاسخ را نمی‌شکند.

| # | مسیر | شکل پاسخ پیشنهادی | آزمون | ریسک |
|---|---|---|---|---|
| ۱ | `GET /ledger/accounts/:id/balance` (`LedgerController_balance`) | `{ accountId: uuid, debitRial, creditRial, netDebitRial }` | آزمون موجود ledger با `SEPEHR_CHECK_RESPONSES=1`، به‌علاوه یک مورد `netDebitRial` منفی (حساب بستانکار) | **کم.** فقط علامت منفی؛ regex باید `-` بپذیرد |
| ۲ | `GET /ledger/journals/:id` (`LedgerController_journal`) | `{ id, entityId, eventType: string, occurredAt: instant, caseId: uuid\|null, creditApplicationId: uuid\|null, reversesJournalEntryId: uuid\|null, reason: string\|null, createdBy: uuid\|null, createdAt: instant, lines: [{ id, accountId, direction: 'debit'\|'credit', amountRial }] }` | آزمون موجود سند و سند معکوس. سند سیستمی با `createdBy` تهی | **کم تا متوسط.** nullable بودن `createdBy` و `reason` باید از نوع `PostedJournal` خوانده شود. اگر `eventType` enum بسته شود، رویداد تازه آینده پاسخ را قرمز می‌کند، پس `string` می‌ماند |
| ۳ | `GET /ledger/reconciliation/runs` (`LedgerController_runs`) | آرایه `{ id, startedAt: instant, clean: boolean, accountsChecked, journalsApplied, mismatches, invariantViolations, unbalancedEntities, overdueUnapplied: int≥0, discrepancies: [{ kind: string, accountId: uuid\|null, expected/actual Debit/Credit Rial: rialString\|null }], reports: [{ entityId, reportDate: 'YYYY-MM-DD', day/total Debit/Credit Rial, balanced: boolean }] }` | آزمون موجود تطبیق شبانه (اجرای پاک و اجرای با اختلاف) | **متوسط.** پاسخ از SQL خام است (`reporting.execute`)، نه از نوع TS، پس هیچ نوعی تضمینش نمی‌کند. ستون‌های شمارشی `integer`اند (0008) و عدد برمی‌گردند. ولی `accountId` و ستون‌های مبلغ اختلاف ممکن است برای نوع اختلاف «بی حساب» تهی باشند؛ پیش از بستن، از 0008 خوانده شود. این مسیر بیشترین سود را دارد: امروز هیچ چیز شکلش را نگه نمی‌دارد |
| ۴ | `GET /repayment/schedules/:id` (`RepaymentController_schedule`) | `{ id, caseId, purseId, principalRial, planFeeRial, totalRial, fundedAt: instant, roundingUnitRial, paidRial, outstandingRial, unallocatedRial, installments: [{ id, index: int≥1, dueOn: 'YYYY-MM-DD', amountRial, paidRial, outstandingRial, status: installmentStatusSchema }] }` | آزمون موجود جدول اقساط، به‌علاوه یک قسط پرداخت‌شده و یک قسط جابه‌جاشده با تعطیلی (ت۱) | **کم.** `status` از enum موجود `InstallmentStatus` خوانده می‌شود؛ اگر در contracts نیست، یک بار از نوع پورت ساخته می‌شود |
| ۵ | `POST /repayment/payments/:id/approve` (`RepaymentController_approve`) | `paymentDecisionSchema = { paymentId, status: 'approved'\|'rejected', allocatedRial, surplusRial, allocations: [{ installmentId, amountRial }] }` | آزمون‌های موجود تأیید: عادی، با مازاد، تکراری مشکوک با `notDuplicate`. پاسخ تکرار idempotent هم سنجیده شود | **متوسط.** این یک نوشتن مالی است. `ResponseSchemaInterceptor` پس از commit تراکنش می‌سنجد و فقط در آزمون فعال است، پس در production رفتار عوض نمی‌شود. اگر روزی در production روشن شود، شکست اسکیما پس از commit خطای ۵۰۰ می‌دهد و پول جابه‌جا شده است. پس سنجش در production برای این دو مسیر روشن نشود؛ در فایل تصمیم ثبت می‌شود |
| ۶ | `POST /repayment/payments/:id/reject` (`RepaymentController_reject`) | همان `paymentDecisionSchema` (برای رد: `allocatedRial = '0'`، `allocations: []`) | آزمون‌های موجود رد، با هر دو `kind` (برگرداندن ثبت معلق یا نه) | **متوسط**، همان دلیل ردیف ۵ |
| ۷ | `GET /wallet/purses/:id` (`WalletController_purse`) | `{ id, caseId, status: 'approved'\|'funded'\|'closed', approvedAmountRial, fundedAt: instant\|null, scope: purseScopeSchema, balances: { approvedRial, availableRial, reservedRial, consumedPendingRial, borrowerDebtRial }, reservations: [{ authorizationId, doctorNodeId, reservedRial, openRial, pendingRial, finalizedRial, held: boolean }] }` | آزمون موجود کیف: پیش و پس از شارژ، با رزرو باز و نگه‌داشته | **کم.** `purseScopeSchema` باید همان شکل `PurseScope` باشد؛ اگر در contracts نیست، تازه ساخته می‌شود |

**آزمون پذیرش کل:**
- `untyped-responses.json` از ۱۲ به ۵ می‌رسد؛ فقط دریافت فایل‌ها می‌مانند.
- `document.test` سبز، و کلاینت دوباره تولید می‌شود.
- هر فایل integration این سه ماژول سبز.
- جهش: در هر ماژول یک فیلد اسکیما عمداً عوض می‌شود و آزمون باید قرمز شود.

**ریسک کل:** کم. هیچ SQL، ثبت یا سرویسی عوض نمی‌شود. تنها نقطه حساس ردیف‌های ۵ و ۶ است: سنجش پس از commit، که فقط در آزمون روشن است.

---

## ۳. تغییر (جایگزینی) موبایل بیمار (ف۱۲)

### وضع امروز (خوانده از کد)

- **ورود بیمار** با `user_accounts.mobile` است. یکتا در میان بیماران فعال است (`user_accounts_patient_mobile_key`، 0001).
- **شماره‌های شخص** در `person_mobiles` است، یکتا در میان ردیف‌های حذف‌نشده (`person_mobiles_mobile_key`، 0015).
  - وضعیت: `active`، `pending` یا `rejected` (0081).
  - تأیید دونفره کارکنان با `person_mobile_proposals` و `person_mobile_decisions` و مجوز `lead.approve_person_mobile` (0085).
  - برنامه فقط این ستون‌ها را عوض می‌کند: `status` فقط رو به جلو، `proved_at` فقط یک بار، و `deleted_at`.
- **رضایت پیامک تبلیغاتی** فقط‌افزودنی و به ازای خود شماره است (`sms_consents`، 0053)، نه به ازای شخص. منبع فقط `panel`، `keyword` یا `link`.
- **پرونده‌ها، کیف، اقساط و قرارداد** به `person_id` بسته‌اند، نه به شماره.
  - `appointments.mobile` و `case_intakes.mobile` عکس لحظه ثبت‌اند.
  - `sms_dispatches` سابقه ارسال است.
- **اعلان** «شماره شما عوض شد» آماده است: رویداد `patient_mobile_changed` در `FactorNotices` و قید 0081. فقط وصل نشده است.
- **الگو:** همین جریان برای کارکنان ساخته شده است (`account-mobile.service.ts`): OTP به شماره تازه، قفل ردیف، اعلان به شماره قبلی و audit با چهار رقم آخر.

### قاعده‌ها (پیشنهادی)

1. **یکتایی.**
   - شماره تازه نباید فعال یا در انتظار روی شخص یا حساب بیمار دیگری باشد. اگر باشد، خطای 409 `mobile_taken` برمی‌گردد.
   - ادغام خودکار نمی‌شود. اگر دو شخص یک نفرند، کارکنان از ابزار ادغام (`e37387c`) استفاده می‌کنند.
   - همه مقایسه‌ها پس از یکسان‌سازی به `9XXXXXXXXX` (قاعده ۲۴).
2. **اثبات مالکیت.** شماره تازه همیشه با OTP تأیید می‌شود. با همان `OtpChallenge` و محدودیت نرخ ورود، با هدف جدا (`patient_mobile_change`).
3. **شماره قبلی.**
   - روی `person_mobiles`، `deleted_at` می‌خورد. شماره تازه ردیف تازه `active` با `proved_at` می‌گیرد.
   - هیچ حذف یا بازنویسی‌ای نیست، و ردیف قبلی سابقه می‌ماند.
   - `user_accounts.mobile` در همان تراکنش، با `FOR UPDATE`، به شماره تازه می‌رود.
4. **نشست‌ها.** همه نشست‌های بیمار جز نشست جاری بسته می‌شوند. اگر شماره به دست کس دیگری افتاده بود، او بیرون می‌رود.
5. **اعلان.**
   - `patient_mobile_changed` به **شماره قبلی** پیامک می‌شود، با الگوی موجود سند ۹-۳ R2: «شماره حساب شما عوض شد؛ اگر شما نبودید با پشتیبانی تماس بگیرید».
   - این پیامک امنیتی است، نه تبلیغاتی، و به رضایت بسته نیست.
6. **رضایت پیامک.** رضایت تبلیغاتی **منتقل نمی‌شود.**
   - شماره تازه بی رضایت شروع می‌کند و بیمار دوباره رضایت می‌دهد.
   - پیامک‌های عملیاتی (اقساط، نوبت) به رضایت بسته نیستند و به شماره تازه می‌روند.
   - دلیل: رضایت به ازای شماره است، و انتقال آن یعنی منبع تازه `mobile_change`، که تغییر قید (DROP و ADD) است. این محتاطانه‌ترین و برگشت‌پذیرترین راه است.
7. **پرونده‌های باز.**
   - پرونده‌ها با `person_id` همراه شخص می‌مانند. پیامک‌های بعدی، از جمله یادآور اقساط و معوقات، از شماره فعال شخص خوانده می‌شوند.
   - پیش از ساخت باید تأیید شود که هیچ فرستنده‌ای شماره را از `case_intakes` یا `appointments` نمی‌خواند. فهرست جدول‌ها بالاست.
   - انتقال اعتبار در جریان (`credit_transfers.recipient_mobile`) دست نمی‌خورد. انتقال امروز خاموش است (م۲ و م۶).
8. **audit.**
   - `identity.patient_mobile_changed`، با قبل و بعد **فقط چهار رقم آخر** (قاعده ۳۰)، و روش (`self` یا `staff`).
   - برای مسیر کارکنان: پیشنهاددهنده، تأییدکننده، دلیل و نوع مدرک.
9. **فاصله دو تغییر.** کلید پیکربندی `identity.patient_mobile_change_cooldown_days`، با پیش‌فرض ۰ یعنی خاموش. دونفره و قفل‌شده، طبق قاعده عددهای کسب‌وکار؛ عددش پرسیده نمی‌شود.

### گزینه‌ها

| گزینه | جریان | مزیت | عیب |
|---|---|---|---|
| **الف** فقط کارکنان | بیمار تماس می‌گیرد؛ کارشناس با مدرک پیشنهاد می‌دهد؛ نفر دوم (`lead.approve_person_mobile`) تأیید می‌کند؛ OTP به شماره تازه | کنترل کامل | بار پشتیبانی؛ هر تغییر دو نفر |
| **ب (پیشنهادی)** خودِ بیمار، و کارکنان فقط برای شماره گم‌شده | **ب۱:** بیمار وارد حساب است (پس شماره قبلی را دارد)، شماره تازه را می‌دهد و OTP آن را می‌زند؛ اعلان به شماره قبلی. **ب۲:** اگر شماره قبلی در دست نیست، همان مسیر دونفره «الف»، با بازتعریف پیشنهاد 0085 | همان امنیت جریان کارکنان (`account-mobile.service.ts`)؛ دو نفر فقط وقتی اثبات مالکیت شماره قبلی نیست | دو مسیر برای ساخت و آزمون |
| **ج** خودِ بیمار، بی ورود (OTP به هر دو شماره) | — | ساده برای بیمار | بیمار بی شماره قبلی گیر می‌کند؛ دوباره به «الف» نیاز است |

**پیشنهاد: «ب».**
- امنیتش برابر «الف» است. در ب۱ داشتن شماره قبلی (نشست فعال بیمار) و شماره تازه (OTP) هر دو ثابت می‌شود، و اعلان به شماره قبلی ربایش بی‌صدا را آشکار می‌کند.
- دو نفر فقط جایی است که اثبات نیست (ب۲)، همان جایی که 0085 برایش ساخته شد.
- **ترتیب:** ب۱ اول، چون الگویش آماده است. ب۲ پس از آن.

### مهاجرت (فقط خلاصه SQL، اجرانشده)

**ب۱ مهاجرت لازم ندارد، جز** یک ردیف در `person_mobiles.added_via`:
- قید `person_mobiles_added_via_check` امروز `'mobile_change'` را نمی‌پذیرد.
- **راه بی تغییر مخرب:** ردیف تازه با `added_via = 'person_created'` ساخته نمی‌شود، چون نادرست است. پس مهاجرت لازم است.

```sql
-- 0091 (پیشنهادی، اجرانشده). تغییر قید: DROP و ADD، پس طبق CLAUDE.md پرسیده می‌شود.
ALTER TABLE person_mobiles DROP CONSTRAINT person_mobiles_added_via_check;
ALTER TABLE person_mobiles ADD CONSTRAINT person_mobiles_added_via_check
  CHECK (added_via IN ('person_created','intake','import','credit_transfer','merge','mobile_change'));
-- فقط افزودنی:
INSERT INTO permissions (code) VALUES ('identity.change_patient_mobile');  -- مسیر ب۲؛ به هیچ نقشی داده نمی‌شود
INSERT INTO config_keys (code, category, sensitive)
  VALUES ('identity.patient_mobile_change_cooldown_days', 'business', true);
INSERT INTO config_values (...) VALUES ('identity.patient_mobile_change_cooldown_days', 'global', '0', ...);
-- الگوی پیامک identity.factor.patient_mobile_changed از 0080 هست؛ ردیف تازه لازم نیست.
```

**ب۲:**
- از `person_mobile_proposals` و `person_mobile_decisions` موجود استفاده می‌کند. پیشنهاد روی ردیف `pending` شماره تازه است، و تأیید آن را `active` می‌کند.
- ردیف شماره قبلی در همان تراکنش `deleted_at` می‌گیرد، و `user_accounts.mobile` جابه‌جا می‌شود.
- جدول تازه‌ای لازم نیست.

### آزمون (هنگام ساخت)

- **integration:**
  - ب۱ با OTP درست تغییر می‌دهد، و OTP نادرست هیچ چیز را عوض نمی‌کند.
  - `mobile_taken` در دو حالت: روی شخص دیگر و روی حساب دیگر.
  - ردیف قبلی `deleted_at` دارد و ردیف تازه `active` و `proved_at` دارد.
  - نشست‌های دیگر بسته می‌شوند.
  - اعلان به شماره قبلی، و audit با چهار رقم آخر.
  - رضایت تبلیغاتی منتقل نمی‌شود، و پیامک قسط به شماره تازه می‌رود.
  - پرونده باز همان `person_id` را دارد.
  - ب۲: پیشنهاددهنده خودش تأیید نمی‌کند (trigger 0085)؛ بی مجوز 403.
  - ورود با شماره قبلی دیگر حساب را باز نمی‌کند.
- **جهش:** حذف `FOR UPDATE`، حذف بستن نشست‌ها و حذف اعلان؛ هر سه باید قرمز شوند.
- **e2e:** بیمار شماره را عوض می‌کند و با شماره تازه وارد می‌شود.

**تصمیم‌های مالک برای شروع:**
1. گزینه «ب» یا دیگری.
2. انتقال‌ندادن رضایت تبلیغاتی.
3. اجرای 0091 (تغییر قید `added_via`).
