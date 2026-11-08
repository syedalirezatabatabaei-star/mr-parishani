# بسته بازبینی کد مالی (۱۰-۰، ۱۴۰۵/۰۸/۰۱ = ۲۰۲۶-۱۰-۲۲)

سند ۱۹ §۱۰-۰: «commitهای مالی فقط پس از بازبینی یک انسان ادغام شوند: فهرست فایل‌ها و تغییرات مالی را برای بازبین آماده کن (خلاصه، ریسک، آزمون‌ها).»

**وضعیت:** همه کد در `main` روی GitLab است (`origin/main` = `eb11237`). پس این بازبینی **پسینی** است: بازبین کل کد مالی موجود را یک‌بار می‌خواند، نه یک MR. go/no-go بند ۱ تا ثبت نتیجه این بازبینی «نه» است.

## ۱. دامنه

| بخش | فایل منبع | commit | آزمون‌ها (`apps/api/test/…`) |
|---|---|---|---|
| ledger (دفتر کل) | ۶ | ۹ | `ledger/ledger`، `ledger/reconciliation`، `ledger/financial-responses` |
| wallet (کیف اعتبار، شارژ، عملیات ویژه، انتقال) | ۱۲ | ۱۹ | `wallet/wallet`، `wallet/funding`، `wallet/special-operations`، `wallet/credit-transfer`، `credit/borrower-cap*` |
| repayment (اقساط، فیش، صورت‌حساب بانک) | ۹ | ۱۹ | `repayment/*` (۱۰ فایل) |
| settlement (تسویه پزشک، صورت‌وضعیت، پرداخت، اختلاف) | ۲۳ | ۱۴ | `settlement/*` (۸ فایل) |
| instrument (چک و سفته) | ۹ | ۷ | `instrument/instruments`، `instrument/executions` |
| collection (معوقات) | ۴ | ۳ | `collection/collection` |
| `packages/contracts/src/credit/plans.ts` (فرمول وام، کارمزد، پیش‌پرداخت) | ۱ | ۵ | `plans.test.ts` (unit) |
| `docs/02-ledger-and-wallet.md` (مرجع قواعد) | ۱ | ۱۲ | — |

جمع: ۶۴ commit از ۳۴۸. فهرست کامل با این فرمان ساخته می‌شود:

```
git log --format='%h %ad %s' --date=short -- apps/api/src/modules/{ledger,wallet,repayment,settlement,instrument,collection} packages/contracts/src/credit/plans.ts docs/02-ledger-and-wallet.md
```

مهاجرت‌هایی که جدول مالی می‌سازند یا تغییر می‌دهند در `docs/ops/RESUME.md` §«مهاجرت‌ها» آمده‌اند. هر کدام trigger فقط‌افزودنی و grant خود را دارد.

## ۲. ترتیب پیشنهادی خواندن

1. `docs/02-ledger-and-wallet.md` و ADRهای مالی در `docs/00-architecture-decisions.md`.
2. `ledger/ledger.service.ts` و `balance-applier.ts`: هر سند متوازن، فقط‌افزودنی، کلید عدم تکرار.
3. `wallet/funding.service.ts`، `wallet.service.ts` و `special-operations.service.ts`: قفل `FOR UPDATE`، دونفره، سقف وام‌گیرنده (ADR-051).
4. `repayment/repayment.service.ts`: ساخت برنامه با نسخه قفل‌شده (ADR-039)، تخصیص فیش.
5. `settlement/settlement.service.ts`، `payout.service.ts` و `statement.service.ts`.
6. `instrument` و `collection`.
7. `plans.ts`: هر فرمول با مثال عددی `plans.test.ts`.

## ۳. ریسک‌هایی که بازبین باید جدا تأیید کند

| # | ریسک | کجا دیده شود |
|---|---|---|
| ر۱ | سند نامتوازن یا UPDATE/DELETE روی ثبت مالی | trigger `reject_append_only_change` در مهاجرت‌ها؛ `ledger.int.test.ts` |
| ر۲ | دو عملیات هم‌زمان روی یک کیف یا یک وام‌گیرنده | `FOR UPDATE` در شارژ و تصمیم؛ آزمون‌های مسابقه `borrower-cap-race` |
| ر۳ | تکرار درخواست (دو شارژ با یک کلید) | idempotency در `funding` و `special-operations` |
| ر۴ | نرخ یا کارمزد خوانده‌شده از پیکربندی امروز به‌جای نسخه قفل‌شده پرونده | ADR-039؛ `schedule-versions.int.test.ts` |
| ر۵ | گرد کردن ریال و جمع اقساط برابر کل بدهی | `plans.test.ts`، `repayment.int.test.ts` |
| ر۶ | تأیید دونفره‌ای که یک نفر بتواند هر دو طرفش باشد | سرویس‌های دونفره؛ بازبین برای هر مسیر دونفره آزمون «رد همان شخص» را پیدا کند و نبودش را یافته ثبت کند |
| ر۷ | **باز (م۳):** بازاحراز TOTP روی تأییدهای دونفره مالی ساخته نشده است | `RESUME` موانع راه‌اندازی |

## ۴. شواهد آزمون (آخرین اجرا)

- HEAVY `heavy-real-40` روی `8a7b967`: api integration ۱۱۷۳، api-unit ۱۳۶، contracts ۳۶۷، lint و typecheck ۲۲ از ۲۲؛ e2e `credit-path` و `completion-path` سبز.
- جهش‌آزمایی ج۱، ج۳، ج۵ و ج۶: همه جهش‌ها قرمز (جزئیات در `RESUME` دورهای ۳۳ و ۳۸ تا ۴۰).

## ۵. ثبت نتیجه

بازبین برای هر بخش جدول §۱ یکی از «پذیرفته»، «پذیرفته با یافته» یا «رد» را با نام، تاریخ و شماره commit بازبینی‌شده ثبت می‌کند، در یک issue در GitLab با برچسب `financial-review`. یافته‌ها تسک [مالی] جدا می‌شوند.

**تنظیم GitLab (با مالک، در وب‌سایت؛ نه از این مخزن):**
- `main` محافظت‌شده: push مستقیم فقط برای مالک، force ممنوع.
- «Pipelines must succeed» برای ادغام MR روشن.
- قاعده تأیید اجباری MR در طرح رایگان GitLab نیست. تا آن زمان، هر MR مالی با تأیید ثبت‌شده بازبین در خود MR ادغام می‌شود.
