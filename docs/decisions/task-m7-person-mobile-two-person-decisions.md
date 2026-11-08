# م۷: تأیید دونفره موبایل افزوده و ماسک شماره در صف (تصمیم مالک ۱۴۰۵/۰۷/۲۳)

نقشه پایه: `owner-open-items-1405-07-22.md` §۵.۱. غیرمالی؛ فقط ماژول lead.

## ۱. دستور مالک

- **ماسک در سرور:** فهرست و API صف فقط چهار رقم پایانی را برمی‌گردانند.
- **شماره کامل:** فقط در endpoint و صفحه تصمیم، و **هر دیدن** ثبت می‌شود.
- **دونفره:** نفر اول پیشنهاد می‌دهد و نفر دوم تأیید می‌کند. «نفر اول ≠ نفر دوم» در سرور اجبار می‌شود.
- **داده موجود:**
  - تأییدهای pending فعلی با روند تازه از اول حساب می‌شوند.
  - تأییدهای انجام‌شده معتبر می‌مانند.
- **چک‌لیست راه‌اندازی:** نقش حداقل ۲ و بهتر ۳ دارنده داشته باشد.
- **مهاجرت:** فایلش ساخته شود ولی اجرا نشود.

## ۲. ساخته‌شده

### API (`lead.controller.ts`، `person-mobile-approval.service.ts`)

| endpoint | کار |
|---|---|
| `GET /lead/person-mobiles/pending` | صف. `mobileLast4` به‌جای `mobile`، و `proposal` (`proposedBy`، `proposedAt` یا `null`). ماسک در `forStaff` سرور انجام می‌شود. قرارداد Zod هم فقط `mobileLast4` را می‌شناسد. |
| `GET /lead/person-mobiles/{id}` | صفحه تصمیم: شماره کامل و جزئیات پیشنهاد. هر دیدن یک ردیف `access_logs` با `entity_type = 'person_mobile'` می‌نویسد (`audit.recordView`، همان الگوی `instrument_number`). بی مجوز ۴۰۳ و بی ثبت. شناسه ناشناخته یا موبایلِ تصمیم‌گرفته‌شده ۴۰۴. |
| `POST /lead/person-mobiles/{id}/propose` | نفر اول، با `{ reason, evidence }`، بازاحراز R1. افزاینده نمی‌تواند (`added_by_same_account`). برای هر موبایل فقط یک پیشنهاد ثبت می‌شود (`person_mobile_already_proposed`، ۴۰۹، و ایندکس یکتا). audit: `lead.person_mobile_proposed`. |
| `POST /lead/person-mobiles/{id}/approve` | نفر دوم، با `{ reason }` و R1. بی پیشنهاد ۴۰۹ `person_mobile_not_proposed`. پیشنهاددهنده ۴۰۳ `proposed_by_same_account`. افزاینده ۴۰۳ مثل قبل. ردیف تصمیم `proposal_id` و مدرک پیشنهاد را می‌گیرد. |
| `POST /lead/person-mobiles/{id}/reject` | یک‌نفره می‌ماند (رد امن است). |

- راه (الف)، یعنی صاحب موبایل تأییدشده در پنل خودش، بی‌تغییر است.
- رد خودکار با مهلت و لغو دسته ورود هم بی‌تغییرند.

### پنل (`apps/admin/app/(app)/person-mobiles/`)

- **صف:** شماره به شکل `…۱۲۳۴` نشان داده می‌شود، با ستون «دونفره» (پیشنهادشده / بی پیشنهاد) و پیوند «بررسی و تصمیم».
- **صفحه تازه `[id]`:**
  - شماره کامل، پیشنهاد نفر اول و تصمیم.
  - دکمه «پیشنهاد تأیید با مدرک» یا «تأیید نفر دوم»، و «رد».
- این صفحه هنوز تأیید بصری مالک را می‌خواهد.

## ۳. مهاجرت `0085_person_mobile_proposals.sql` (ساخته‌شده، **اجرانشده**)

فقط‌افزودنی:

```sql
CREATE TABLE person_mobile_proposals (id uuid PK uuidv7(), person_mobile_id uuid NOT NULL FK person_mobiles,
  proposed_by uuid NOT NULL, reason text NOT NULL, evidence text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX person_mobile_proposals_mobile_key ON person_mobile_proposals (person_mobile_id);
ALTER TABLE person_mobile_decisions ADD COLUMN proposal_id uuid;          -- nullable، FK به person_mobile_proposals
ALTER TABLE person_mobile_decisions ADD CONSTRAINT person_mobile_decisions_staff_proposal_check
  CHECK (method <> 'staff' OR decision <> 'approved' OR proposal_id IS NOT NULL) NOT VALID;
-- trigger BEFORE INSERT روی person_mobile_decisions: proposal_id از همان موبایل، و decided_by ≠ proposed_by
-- trigger فقط‌افزودنی روی person_mobile_proposals (reject_append_only_change)؛ REVOKE UPDATE, DELETE؛ GRANT SELECT, INSERT به sepehr_app
```

- **`NOT VALID`:** تأییدهای کارمندی یک‌نفره پیش از 0085 معتبر می‌مانند. هر ردیف تازه بررسی می‌شود.
- **داده:** pendingهای موجود پیشنهادی ندارند، پس خودبه‌خود از اول روند تازه را می‌گذرانند. هیچ `UPDATE` یا `DELETE` روی داده موجود انجام نمی‌شود.
- **اجرا روی پایگاه محلی:** **انجام نشد**، به دستور مالک. Testcontainers آن را در هر اجرای آزمون می‌سازد.

## ۴. آزمون‌ها (`test/lead/person-mobile-approval.int.test.ts`: ۳۱ از ۳۱ سبز)

### آزمون‌های تازه (۷)

- ماسک صف (هیچ فیلد و هیچ جای JSON شماره کامل را ندارد).
- شماره کامل در صفحه تصمیم، با یک ردیف دیدن برای هر بار.
- بی مجوز ۴۰۳ و بی ثبت. ناشناخته یا تصمیم‌گرفته‌شده ۴۰۴ (IDOR).
- یک نفر نمی‌تواند:
  - بی پیشنهاد ۴۰۹؛
  - پیشنهاددهنده ۴۰۳؛
  - پیشنهاد دوم ۴۰۹؛
  - نفر دوم تأیید می‌کند؛
  - دو ردیف audit با دو بازیگر ثبت می‌شود.
- رد یک‌نفره.
- پایگاه داده هم رد می‌کند (sepehr_app):
  - تأیید کارمندی بی پیشنهاد (CHECK)؛
  - تأیید به‌دست پیشنهاددهنده (trigger)؛
  - تغییر پیشنهاد (فقط‌افزودنی).
- قید `NOT VALID` است (`convalidated = false`).

### آزمون تغییرکرده (گزارش)

- «(ب) staff … four eyes, evidence and R1» به روند دونفره درآمد.
- افزاینده هنوز ۴۰۳ می‌گیرد. مدرک حالا در `propose` اجباری است (همان ۴۰۰). R1 برای `propose` و `approve` هر دو بررسی می‌شود.
- تأیید نهایی به‌دست نفر سوم انجام می‌شود و ردیف تصمیم نام پیشنهاد را دارد.
- هیچ ادعایی حذف یا ضعیف نشد. فقط ادعا افزوده شد.

### جهش‌ها (هر پنج قرمز شدند)

| جهش | نتیجه |
|---|---|
| صف شماره کامل را در `mobileLast4` بدهد | ۲ قرمز |
| صف فیلد اضافه `mobile` بدهد | ۱ قرمز |
| شرط «پیشنهاددهنده ≠ تأییدکننده» در سرویس برداشته شود | ۱ قرمز (trigger پایگاه داده آن را ۵۰۰ کرد، نه ۴۰۳) |
| شرط «بی پیشنهاد، بی تأیید» برداشته شود | ۱ قرمز |
| ثبت دیدن برداشته شود | ۱ قرمز |

## ۵. چک‌لیست راه‌اندازی (RESUME، بند ۵، به‌روز)

- نقش «تأیید شماره بیمار» **حداقل ۲ و بهتر ۳ دارنده** دارد، چون تأیید دونفره است و با یک دارنده هیچ تأیید کارمندی ممکن نیست.
- هرگز به مشاور، پشتیبانی یا مدیر سیستم داده نمی‌شود.
- **پیش از آن:** مهاجرت 0085 با دستور مالک اجرا شود.
