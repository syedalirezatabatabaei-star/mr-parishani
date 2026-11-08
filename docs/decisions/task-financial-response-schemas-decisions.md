# شمای پاسخ هفت مسیر مالی (تصمیم مالک ۱۴۰۵/۰۷/۲۶)

**دستور مالک:** «۷ مسیر مالی بدون schema: فقط افزودن schema پاسخ، با آزمون ریال‌به‌ریال برای هر مسیر؛ مسیر تطبیق شبانه آخر و با آزمون جهش؛ ثابت کن خطای schema هرگز تراکنش ثبت‌شده را برنمی‌گرداند. کد مالی است؛ پیش از commit خلاصه تغییرات هر مسیر را در گزارش بیاور.»

**وضعیت:**
- ساخته و آزموده شد. با تأیید مالک (۱۴۰۵/۰۷/۲۶) commit شد.
- هیچ منطق، SQL، سرویس، ثبت دفتر کل، مهاجرت یا مجوزی عوض نشد.
- در هر controller فقط یک خط `@ZodResponse(...)` افزوده شد، به‌علاوه import آن.
- نقشه: `task-plans-1405-07-25.md` §۲.

## ۱. هر مسیر

| # | مسیر | تغییر در کد | شما (`packages/contracts`) | آزمون ریال‌به‌ریال |
|---|---|---|---|---|
| ۱ | `GET /ledger/accounts/:id/balance` | `@ZodResponse(accountBalanceSchema)` | `ledger/views.ts`: `accountId`، `debitRial`، `creditRial`، و `netDebitRial` (علامت‌دار، `^-?\d+$`) | دو سند با مبلغ ۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ (بیش از 2^53) و ۷. بانک و درآمد دقیقاً `۹۰۰۷۱۹۹۲۵۴۷۴۱۰۰۰`، و net درآمد منفی همان. برابر `SUM` ستون `ledger_entries` در پایگاه |
| ۲ | `GET /ledger/journals/:id` | `@ZodResponse(journalViewSchema)` | `eventType` باز (`string`)؛ `caseId`، `creditApplicationId`، `reversesJournalEntryId`، `reason` و `createdBy` می‌توانند تهی باشند؛ سطر: `direction` با `debit` یا `credit` و `amountRial` | هر سطر پاسخ برابر ردیف `ledger_entries` همان سند (شناسه، حساب، جهت، مبلغ متنی)؛ مبلغ بیش از 2^53 دقیق |
| ۳ | `GET /wallet/purses/:id` | `@ZodResponse(purseViewSchema)` | `wallet/purse.ts`: `status` با `approved`، `funded` یا `closed`؛ `scope`؛ پنج مانده؛ رزروها | هر مانده برابر `WalletService.summary` به ریال؛ `approvedAmountRial` و `availableRial` پس از شارژ، دقیقاً ۹٬۶۰۰٬۰۰۰ |
| ۴ | `GET /repayment/schedules/:id` | `@ZodResponse(installmentScheduleViewSchema)` | `repayment/views.ts`: `status` از `INSTALLMENT_STATES` موجود؛ `dueOn` به شکل `YYYY-MM-DD`. نام `scheduleViewSchema` در booking گرفته بود | اصل ۱۰٬۰۰۰٬۰۰۱ و کارمزد ۳۰٬۰۰۰، جمع ۱۰٬۰۳۰٬۰۰۱. هر قسط برابر ردیف `installments` (شناسه، شماره، روز، مبلغ)، و جمع اقساط برابر جمع کل |
| ۵ | `POST /repayment/payments/:id/approve` | `@ZodResponse(paymentDecisionSchema)` | `paymentId`، `status`، `allocatedRial`، `surplusRial` و `allocations` | فیش ۱٬۵۰۰٬۰۰۰ روی سه قسط ۱٬۰۰۰٬۰۰۰: تخصیص ۱٬۰۰۰٬۰۰۰ و ۵۰۰٬۰۰۰، برابر `payment_allocations`. فیش ۲٬۰۰۰٬۰۰۱ پس از آن: تخصیص ۱٬۵۰۰٬۰۰۰ و مازاد ۵۰۰٬۰۰۱ |
| ۶ | `POST /repayment/payments/:id/reject` | `@ZodResponse(paymentDecisionSchema)` | همان شما | `allocatedRial = '0'`، تخصیص خالی، بی هیچ ردیف تخصیص، و وضعیت `rejected` در پایگاه |
| ۷ (آخر) | `GET /ledger/reconciliation/runs` | `@ZodResponse(z.array(reconciliationRunSchema))` | شمارش‌ها `int ≥ 0`؛ `kind` با `balance_mismatch` یا `negative_balance` (قید 0008)؛ `accountId` غیرتهی (همه ستون‌ها `NOT NULL` در 0008)؛ مبلغ‌ها؛ `reportDate` | هر اجرا (شناسه، شمار حساب، شمار اختلاف)، هر اختلاف و هر گزارش روزانه، برابر سه جدول پایگاه. جمع کل بدهکار و بستانکار آخرین گزارش برابر |

- **فایل‌ها:**
  - آزمون تازه: `apps/api/test/ledger/financial-responses.int.test.ts` (۷ آزمون).
  - آزمون افزوده: `apps/api/test/ledger/reconciliation.int.test.ts` «owner 1405/07/26: every run, discrepancy and report rial by rial».
- **فهرست بی‌شما:** `untyped-responses.json` از ۱۲ به ۵ رسید (فقط دریافت فایل). `openapi.json` و کلاینت دوباره ساخته شدند.

## ۲. خطای شما هرگز تراکنش ثبت‌شده را برنمی‌گرداند

- **ساختار:**
  - `ResponseSchemaInterceptor` روی **مقدار برگشتی** handler کار می‌کند (`next.handle().pipe(map(...))`).
  - تراکنش سرویس پیش از آن commit شده است.
  - این interceptor فقط با `SEPEHR_CHECK_RESPONSES=1` روشن است، یعنی در آزمون. در production نیست.
- **آزمون** «a response schema that fails after the commit never takes back the approval»:
  1. شمای `approve` در حین آزمون با `z.never()` جایگزین می‌شود و سپس برگردانده می‌شود.
  2. پاسخ ۵۰۰ است.
  3. با این حال فیش `approved` است، `allocation_journal_entry_id` دارد، و سند دفتر کل آن ردیف دارد.
  4. تخصیص ۱٬۰۰۰٬۰۰۰ ثبت است. جدول اقساط `paidRial = 1000000` نشان می‌دهد. audit یک بار ثبت شده است.
  5. تأیید دوباره ۵۰۰ نمی‌دهد و چیزی نمی‌افزاید.
- **تصمیم:** سنجش پاسخ در production روشن نشود. اگر روزی بخواهند، ۵۰۰ پس از commit پول جابه‌جاشده را پنهان می‌کند. ثبت در این فایل.

## ۳. جهش‌ها (همه قرمز، فایل‌ها با `cp` برگردانده شدند)

| جهش | نتیجه |
|---|---|
| تطبیق شبانه: `expectedDebitRial` از ستون actual | ۱ قرمز (آزمون ریال‌به‌ریال) |
| تطبیق شبانه: `startedAt` بی `T` و `Z` | ۲ قرمز (شما) |
| مانده: `netDebitRial` از `creditRial` | ۱ قرمز |
| تصمیم فیش: `surplusRial` از `allocatedRial` | ۱ قرمز |
| شمای کیف: `availableRial` عدد | ۱ قرمز |

**جهش آزمون §۲ (۱۴۰۵/۰۷/۲۶، به دستور مالک):**
- همان شمای مسیر، به‌طور موقت درون تراکنش `approvePayment` سنجیده شد، پیش از commit. این همان حالتی است که آزمون باید بگیرد.
- نتیجه: «a response schema that fails after the commit never takes back the approval» **قرمز** با `expected 'pending_approval' to be 'approved'`. یعنی تأیید برگشت.
- فایل با `cp` برگردانده شد (`cmp` برابر)، و آزمون دوباره ۷ از ۷.
