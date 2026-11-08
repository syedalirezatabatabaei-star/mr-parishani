# تسک ۹-۳، حفره «افزودن موبایل به Person موجود»: نقشه

**وضعیت:** نقشه تأیید شد (۱۴۰۵/۰۷/۱۹، بخش ۸). مالک 0081 را با چهار اصلاح (بخش ۱۶) و سپس با سه پاسخ دیگر (بخش ۱۷) تأیید کرد. **0081 روی پایگاه محلی اجرا شد** و بررسی‌ها پاک بودند. commit محلی شد. تأیید بصری pm-01 تا pm-06 با مالک است.

**دستور مالک (۱۴۰۵/۰۷/۱۹ = ۲۰۲۶-۱۰-۱۱):** این مورد پرسش پ۲ نیست. حفره امنیتی و **مسدودکننده go-live** است. دلیل: کد ملی محرمانه نیست، و این مسیر به اقساط و پرونده‌های اعتباری Person دیگری دسترسی می‌دهد.

## ۱. حفره، دقیق

- `PersonService.findOrCreate` موبایل تازه‌ای را که Person ندارد، با تطبیق blind index کد ملی، به Person موجود اضافه می‌کند و `lead.person_mobile_added` ثبت می‌شود.
- این مسیر سه ورودی دارد:
  1. **ثبت دستی سرنخ به‌دست مشاور:** کارمند وارد می‌کند.
  2. **import اکسل:** کارمند وارد می‌کند.
  3. **گیرنده انتقال اعتبار** (`recipientPerson`): خود بیمارِ فرستنده موبایل و کد ملی گیرنده را وارد می‌کند. **بدترین مسیر است:** هر کس با کد ملی دیگری می‌تواند موبایل خودش را به Person او بچسباند. پرچم `wallet.credit_transfer_enabled` اکنون `false` است.
- **چطور دسترسی می‌دهد:**
  - ورود OTP بیمار `linkPerson` را صدا می‌زند، که از `PERSON_DIRECTORY.findOrCreateByMobile` همان Person را برمی‌گرداند و `user_accounts.person_id` را پر می‌کند.
  - همه صفحه‌های بیمار با `samePersonIds(canonicalPersonId(account.personId))` کار می‌کنند: نوبت، پیش‌فاکتور، پرونده اعتباری، قرارداد، تکمیل پرونده، فیش، چک، تیکت و کیف.
- **مسیر چهارم، مرتبط ولی خارج از این سه:** ادغام Person (`lead.merge_persons`). موبایل‌های Person ادغام‌شده هم رکوردهای Person مانده را می‌بینند. این کار کارمند دارای مجوز است، audit می‌شود و برگشت‌پذیر است. پیشنهاد در بخش ۶ آمده است.

## ۲. داده فعلی (فقط‌خواندنی، ۱۴۰۵/۰۷/۱۹، هیچ داده‌ای تغییر نکرد)

| پرسش | نتیجه |
|---|---|
| رخداد `lead.person_mobile_added` در `audit_events` | **۰** |
| Person با بیش از یک موبایل زنده | **۰** (۱۰ Person، ۱۰ موبایل زنده) |
| Person ادغام‌شده | ۰ |
| موبایل حذف منطقی‌شده | ۰ |
| حساب بیمار | ۱۰ |

**نتیجه:** هیچ رکوردی از این راه اضافه نشده است، پس داده موجود اصلاح لازم ندارد. پیش‌فرض اگر پایگاه داده عملیاتی چنین ردیفی داشت: مهاجرت آن ردیف‌ها را `pending` نمی‌کند، چون کسی ممکن است همین حالا با آن‌ها وارد شده باشد. یک گزارش فقط‌خواندنی (CLI) فهرستشان را با شماره پایانی می‌دهد تا کارمند دارای مجوز یکی‌یکی تأیید یا رد کند. ردِ کارمند حساب وصل‌شده را هم از Person جدا می‌کند (بخش ۵).

## ۳. رفتار تازه

### ۳.۱ وضعیت موبایل

- ستون تازه `person_mobiles.status` با دو مقدار `active` و `pending`. همه ردیف‌های فعلی `active` می‌شوند.
- **`pending`:** هر موبایلی که با کد ملی به Person **موجود** اضافه شود، از هر سه ورودی.
- **`active`:** موبایل نخستِ Personی که همین حالا ساخته می‌شود. تغییری نمی‌کند، چون Person تازه داده‌ای ندارد که لو برود.
- ستون `proved_at` = نخستین ورود OTP موفق با همان موبایل. این ستون «موبایل تأییدشده» را تعریف می‌کند. موبایلی که کارمند وارد کرده، تا صاحبش یک بار OTP نداده باشد، تأییدشده نیست.

### ۳.۲ موبایل pending به هیچ داده‌ای از آن Person دسترسی نمی‌دهد

- **`findOrCreateByMobile`:** برای موبایل pending، `personId: null` و `pending: true` برمی‌گرداند. Person تازه نمی‌سازد (یکتایی موبایل همچنان برقرار است). در نتیجه:
  - **ورود OTP** موفق است، ولی حساب به Person وصل نمی‌شود و همه فهرست‌ها خالی است، همان رفتار فعلی `personId` خالی. پنل یک پیام بی‌داده نشان می‌دهد: «این شماره در انتظار تأیید است». نام، شماره پایانی و تعداد پرونده نمی‌آید.
  - **انتخاب وام‌گیرنده یا ضامن با موبایل** (`credit-application.borrowerOf` و `credit-scoring`): `409 person_mobile_pending`. کارمند شماره را نمی‌تواند به‌جای Person دیگر به کار ببرد.
- **`mobileOf` و هر فهرست گیرنده پیامک:** موبایل pending را برنمی‌گرداند. پیامک قسط، یادآور و فیش به شماره تأییدنشده نمی‌رود.
- **دید کارمند:** نمای Person موبایل pending را با برچسب «در انتظار تأیید» نشان می‌دهد. کار سرنخ و پرونده سمت کارمند مثل قبل ادامه دارد. فقط دسترسی **بیمار** بسته است.
- **گیرنده انتقال اعتبار:** اگر کد ملی به Person موجود بخورد و موبایل از آنِ او نباشد، انتقال با `409 recipient_mobile_mismatch` **رد می‌شود** و موبایلی هم ساخته نمی‌شود. pending ماندن پول در انتقال مالی پیچیده و پرسیدنی است. این گزینه محتاط‌تر است. پرچم تا بسته شدن این مورد خاموش می‌ماند (بخش ۷).

### ۳.۳ راه‌های تأیید

**(الف) صاحب یک موبایل تأییدشده قبلی همان Person.**

- پیشنهاد: تأیید **داخل پنل خود صاحب قبلی** انجام شود، پس از ورود OTP با همان موبایل تأییدشده. خود این ورود همان OTP به موبایل قبلی است.
- صفحه به‌روشنی می‌گوید: «شماره ‎۰۹…۵۶۷۸ می‌خواهد به نوبت‌ها، اقساط و پرونده‌های شما دسترسی داشته باشد» و دو دکمه دارد: «تأیید» و «رد».
- **دلیل:** اگر کد OTP در پیامک برای «تأیید» فرستاده شود، صاحب موبایل تازه می‌تواند با یک تماس تلفنی کد را از قربانی بگیرد (مهندسی اجتماعی). تأیید داخل پنل این راه را می‌بندد.
- اگر مالک «کد در پیامک» را ترجیح دهد: کد ۶ رقمی یک‌بارمصرف با همان محدودیت نرخ OTP، که فقط در پنل صاحب قبلی وارد می‌شود، نه در پنل صاحب تازه.

**(ب) کارمند دارای مجوز تازه `lead.approve_person_mobile`.**

- دلیل اجباری می‌خواهد، با مرجع مدرک (مثلاً «کارت ملی حضوری، ۱۴۰۵/۰۷/۲۰»).
- **چهارچشمی:** کسی که موبایل را افزوده نمی‌تواند تأییدش کند.
- بازاحراز R1 (`assertFreshMfa`) می‌خواهد.
- ثبت `lead.person_mobile_approved` یا `lead.person_mobile_rejected` در audit، با شماره پایانی، نه کامل.
- مجوز به هیچ نقش پیش‌ساخته‌ای داده نمی‌شود. مدیر دسترسی آن را جدا می‌دهد.

**هر دو راه:**

- تأیید: `status` به `active`. سپس در ورود بعدی، یا با رویداد outbox `lead.person_mobile_approved` که identity مصرف می‌کند، حساب به Person وصل می‌شود.
- رد: حذف منطقی ردیف (`deleted_at`)، که موبایل را آزاد می‌کند تا Person خودش را داشته باشد.
- هر تصمیم یک ردیف در جدول فقط‌افزودنی `person_mobile_decisions` می‌گذارد.
- **مهلت:** کلید پیکربندی `lead.person_mobile_pending_days` با مقدار اولیه **۰ = بی‌مهلت** (قاعده عددهای کسب‌وکار). اگر مقدار گذاشته شود، زمان‌بند پس از مهلت ردیف را «منقضی» ثبت و حذف منطقی می‌کند.

### ۳.۴ اعلان R2

- **همان لحظه افزودن**، در همان تراکنش و از outbox، به **همه موبایل‌های تأییدشده** (`proved_at` پر) و `active` همان Person فرستاده می‌شود.
- مسیر همان `FactorNotices` و `identity.factor_changed` است: رویداد تازه `patient_mobile_added` با قالب تازه و audience `patient`.
- متن بدون داده حساس است: بدون شماره تازه، نام، کد ملی و مبلغ. مثلاً: «درخواست افزودن یک شماره تازه به حساب شما در سپهر سلامتی ثبت شد. تا تأیید شما دسترسی ندارد. اگر شما نبودید، کاری نکنید یا با پشتیبانی تماس بگیرید.»
- **پس از تصمیم** دو قالب دیگر هم هست: `patient_mobile_approved` و `patient_mobile_rejected`، به همان گیرندگان.
- **پرچم:** همان `identity.factor_change_sms` (م۴). اگر خاموش باشد، اعلان ثبت و «skipped_flag_off» audit می‌شود، همان رفتار R2.
- **خود دروازه pending پرچم ندارد و از روز اول روشن است.** حفره امنیتی پشت پرچم خاموش نمی‌ماند. این تصمیم برگشت‌پذیر است و ثبت شد.

### ۳.۵ Person بی موبایل تأییدشده قبلی

- این Person را مشاور یا import ساخته و هیچ‌کس با موبایل‌هایش وارد نشده است.
- **(الف) ممکن نیست.** فقط **(ب)** می‌ماند: کارمند دارای مجوز، با مدرک هویتی و چهارچشمی.
- اعلانی فرستاده نمی‌شود، چون موبایل تأییدشده‌ای نیست. `identity.factor_notice_skipped` با دلیل `no_proved_mobile` ثبت می‌شود.
- **موبایل‌های active ولی تأییدنشده** (ورودی کارمند) هم اعلان نمی‌گیرند. صاحبشان ثابت نشده است.
- پنل کارمند این مورد را جدا نشان می‌دهد: «بدون موبایل تأییدشده؛ فقط با مدرک».

## ۴. مهاجرت لازم: فقط خلاصه SQL، **اجرا نشده**

شماره: نخستین شماره آزاد هنگام اجرا (اکنون 0081). نقشه R4 شماره ثابت ندارد.

```sql
-- person_mobiles: وضعیت، اثبات، منشأ (افزودنی)
ALTER TABLE person_mobiles
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CONSTRAINT person_mobiles_status_check CHECK (status IN ('active','pending')),
  ADD COLUMN proved_at timestamptz,
  ADD COLUMN added_via text
    CONSTRAINT person_mobiles_added_via_check
    CHECK (added_via IN ('person_created','advisor_intake','import','credit_transfer','merge')),
  ADD COLUMN added_by uuid;
CREATE INDEX person_mobiles_pending_idx ON person_mobiles (person_id)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- پر کردن proved_at برای موبایل‌هایی که با آن OTP داده شده (حساب بیمار با همان موبایل)
UPDATE person_mobiles pm SET proved_at = u.created_at
  FROM user_accounts u
 WHERE u.kind = 'patient' AND u.mobile = pm.mobile AND pm.deleted_at IS NULL;

-- تصمیم‌ها، فقط‌افزودنی
CREATE TABLE person_mobile_decisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  person_mobile_id uuid NOT NULL REFERENCES person_mobiles(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected','expired')),
  method text NOT NULL CHECK (method IN ('owner_panel','staff','schedule')),
  decided_by uuid,
  reason text NOT NULL,
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- + trigger reject_append_only_change، REVOKE UPDATE, DELETE، GRANT SELECT, INSERT به sepehr_app

-- مجوز تازه lead.approve_person_mobile (بدون نقش پیش‌فرض)
-- کلید پیکربندی lead.person_mobile_pending_days = 0 (بی‌مهلت)
-- سه قالب پیامک فوری، audience patient: identity.factor.patient_mobile_{added,approved,rejected}

-- ** پرسیدنی (تغییر قید موجود، بند ۴ CLAUDE.md) **
ALTER TABLE factor_change_notices DROP CONSTRAINT factor_change_notices_event_check;
ALTER TABLE factor_change_notices ADD CONSTRAINT factor_change_notices_event_check
  CHECK (event IN ('password_changed','totp_reset','totp_enrolled','mobile_changed',
                   'patient_mobile_changed','patient_mobile_added',
                   'patient_mobile_approved','patient_mobile_rejected'));
```

- **دو نکته برای تأیید:**
  1. `UPDATE` برای پر کردن ستون **تازه** است و داده موجود را عوض نمی‌کند.
  2. `DROP/ADD CONSTRAINT` قید را **گسترده‌تر** می‌کند: هر ردیف فعلی معتبر می‌ماند و چیزی پاک نمی‌شود. ولی تغییر قید موجود است، پس صریحاً پرسیده می‌شود.
- **پیش‌فرض اگر پاسخ منفی باشد:** جدول جدای `person_mobile_notices` با همان سازوکار فقط‌افزودنی ساخته می‌شود. قید فعلی دست نمی‌خورد.
- **یک فرض که پیش از اجرا بررسی می‌شود:** حساب بیمار فقط با OTP ساخته می‌شود (`otp-login.service` خط ۲۰۴)، پس `created_at` حساب تاریخ نخستین اثبات است. `person-backfill` هم حساب نمی‌سازد، فقط وصل می‌کند.

## ۵. آزمون‌ها (پیش از commit)

- **یکپارچه، برای هر سه ورودی:** موبایل تازه با کد ملی Person دیگر `pending` می‌شود. ورود OTP با آن: `personId` خالی و همه فهرست‌های بیمار (نوبت، پیش‌فاکتور، پرونده اعتباری، قرارداد، فیش، کیف، تیکت) **خالی**.
- **اعلان:** فقط به موبایل‌های `active` و `proved_at` پر. هیچ متغیر حساسی ندارد. با پرچم خاموش، audit «skipped».
- **تأیید (الف):** فقط صاحب موبایل تأییدشده همان Person. بیمار Person دیگر `404` می‌گیرد (IDOR).
- **تأیید (ب):** بی مجوز `403`. کسی که افزوده نمی‌تواند تأیید کند. بازاحراز لازم است.
- **رد:** ردیف حذف منطقی می‌شود و موبایل آزاد است. ورود بعدی Person تازه می‌سازد.
- **وام‌گیرنده یا ضامن با موبایل pending:** `409 person_mobile_pending`.
- **انتقال اعتبار با کد ملی Person دیگر:** `409 recipient_mobile_mismatch` و هیچ موبایلی ساخته نمی‌شود.
- **پیامک قسط و یادآور** به موبایل pending نمی‌رود.
- **e2e:** پیام بی‌داده «در انتظار تأیید» در پنل بیمار. یک تصویر برای تأیید بصری مالک.

## ۶. ادغام Person (مسیر چهارم)

- پیش‌فرض محتاط: ادغام دروازه pending نمی‌گیرد. کار کارمند دارای مجوز است، audit می‌شود و برگشت‌پذیر است.
- ولی ادغام **اعلان R2** (`patient_mobile_added`) را به موبایل‌های تأییدشده Person مانده می‌فرستد. کار آن کوچک است و در همین تسک انجام می‌شود.
- اگر مالک بخواهد ادغام هم تأیید صاحب بخواهد، تسک جدا می‌شود.

## ۷. go-live

- **م۵ (مسدودکننده):** این حفره. بسته نمی‌شود تا بخش‌های ۳ تا ۵ ساخته و سبز شوند.
- **م۶:** `wallet.credit_transfer_enabled` تا بسته شدن م۵ **خاموش** می‌ماند. روشن کردنش وابسته به م۵ است.

## ۸. تأیید مالک و اجرا (۱۴۰۵/۰۷/۱۹، دور دوم)

**نقشه تأیید شد**، با این تصمیم‌ها و اصلاح‌ها:

- **CHECK روی `factor_change_notices`:** در همان یک تراکنش مهاجرت گسترده می‌شود: `DROP` و سپس `ADD CHECK` با اعتبارسنجی کامل، بدون `NOT VALID`. trigger فقط‌افزودنی دست‌نخورده می‌ماند و آزمون UPDATE/DELETE پس از اجرا دوباره گرفته می‌شود.
  - اجراکننده مهاجرت Drizzle همه مهاجرت‌های منتظر را در یک تراکنش اجرا می‌کند، پس `DROP` و `ADD` جدا از هم دیده نمی‌شوند.
- **راه تأیید (الف):** داخل پنل صاحب موبایل تأییدشده قبلی، پس از ورود OTP. **کد پیامکی ساخته نشد.**
- **اصلاح ۱:** همه خواندن‌ها از یک ماژول واحد (بخش ۹).
- **اصلاح ۲:** `proved_at` فقط با شاهد واقعی ورود OTP پر می‌شود (بخش ۱۰).
- **اصلاح ۳:** ادغام Person بازاحراز R1 می‌خواهد. ادغام دو کد ملی متفاوت رد می‌شود. اعلان R2 و audit مثل نقشه است (بخش ۱۲).
- **اصلاح ۴:** مهلت pending پیش‌فرض **۳۰ روز** است. پس از مهلت خودکار رد، در `person_mobile_decisions` ثبت و اعلان می‌شود (بخش ۱۳).

## ۹. خواندن‌های `person_mobiles`: یک در، و آزمون هر مسیر

**در واحد:** `apps/api/src/modules/lead/person-mobiles.ts` (شیء `PersonMobiles`).

- هیچ فایل دیگری در `apps/api/src` نام جدول را نمی‌برد، نه به Drizzle (`personMobiles`) و نه به SQL (`person_mobiles`). فقط `lead.schema.ts` تعریفش را دارد.
- فقط ماژول lead این در را import می‌کند. ماژول‌های دیگر از `LEAD_CASES` یا `PERSON_DIRECTORY` می‌پرسند.
- آزمون ایستای `test/lead/person-mobiles-reads.test.ts` این دو را قفل می‌کند و نیز اینکه هر تابع خواندنیِ در، جز چند تابع نام‌برده، شرط `active` (زنده و نه pending) دارد.

**خواندن‌هایی که pending را حذف می‌کنند** (دسترسی یا پیامک می‌دهند):

| تابع در | مسیرهای بیرونی | آزمون (`test/lead/person-mobile-approval.int.test.ts`) |
|---|---|---|
| `personOfActive` | `PersonService.byActiveMobile` و `LEAD_CASES.personByMobile` (باز کردن تیکت از طرف تماس‌گیرنده در `ticket.service`) | `LEAD_CASES: no Person by it…`: برای موبایل pending، `null`. |
| `firstActive` | `LEAD_CASES.mobileOf`، تنها مسیر همه پیامک‌ها به یک شخص: یادآور و اعلان معوق قسط (`repayment`)، وصول (`collection`)، اعتبار و ضامن (`credit-notifier`)، چک (`instrument`)، شارژ (`funding-notifier`)، مجوز خدمت (`service-authorization`)، انتقال اعتبار (`credit-transfer`)، پیامک تکی و گروهی (`campaign`)، و موبایل پوشیده در قرارداد (`contract`) | `installment reminder and overdue notice…`: یادآور ۳ روز پیش و اعلان معوق روز ۱ فقط به موبایل تأییدشده می‌رود، **حتی وقتی ردیف pending عمداً قدیمی‌تر شده است**، و موبایل pending هیچ پیامکی ندارد. نیز `staff person view…`: `mobileOf` موبایل تأییدشده را می‌دهد. |
| `activeOf` | `PersonService.view`، فهرست `mobiles` در نمای شخص برای کارکنان | `staff person view…`: در `mobiles` فقط موبایل تأییدشده است و موبایل pending جدا در `pendingMobiles` می‌آید. |
| `provedOf` | گیرندگان اعلان R2 (`PersonService.tellProved`)، و `hasProvedMobile` در صف کارکنان | `advisor intake…`: اعلان فقط به موبایل تأییدشده رفت و موبایل pending پیامکی نگرفت. `a Person with no proved mobile…`: بدون گیرنده، بدون رویداد و با audit. |
| `activeByIds` | `PERSON_DIRECTORY.mobilesByIds`: مصرف‌کننده identity گیرنده‌ها و موبایلِ تأییدشده را با آن می‌خواند | مسیر تحویل اعلان در هر آزمون R2 (`deliver`). |

**خواندن‌هایی که pending را می‌بینند،** فقط برای رد یا محدود کردن، هرگز برای دسترسی:

| تابع در | چرا pending را می‌بیند | رفتار با pending | آزمون |
|---|---|---|---|
| `holder` در `findOrCreate` | یکتایی: هر موبایل یک Person. بی آن، Person دوم ساخته می‌شد. | `findOrCreateByMobile` و `linkLogin`: `personId: null`. ورود OTP موفق است ولی حساب به هیچ Personی وصل نمی‌شود. وام‌گیرنده یا ضامن با آن: `409 person_mobile_pending`. گیرنده انتقال اعتبار: `409 recipient_mobile_pending`. | `OTP login…`: `person_id` خالی، و ۹ مسیر بیمار (فهرست‌ها و پرونده قربانی با شناسه‌اش) یا رد می‌شوند یا چیزی از قربانی ندارند. پنل «در انتظار تأیید». `credit: a pending mobile borrows for nobody`. `a credit transfer recipient…`. |
| `holder` در `openForBooking` | نوبت خود بیمار با موبایل pending روی Person دیگری پرونده باز می‌کرد. | کانال `app`: `refused`. نوبت کارمند برای تماس‌گیرنده ادامه دارد. | `LEAD_CASES…`: `{ kind: 'refused' }`. |
| `holder` در `standingOf` | مسدودسازی محدودکننده است و باید به موبایل pending هم برسد. | Person مسدود: نوبت رد می‌شود. | `LEAD_CASES…`: `abuse`. |
| `countKnown` | پیش‌نمایش import: شماره‌های «تازه» و «موجود». | فقط یک عدد، بدون شخص. | آزمون‌های موجود import در `lead.int.test.ts`. |
| `pendingOf`، `pendingAll`، `lockPending`، `lockOverdue` | تصمیم‌گیری روی خود موبایل pending. | فقط شماره پایانی برای بیمار، و شماره کامل برای کارکنان دارای مجوز. | بخش‌های (الف)، (ب) و مهلت. |

- **جست‌وجو و گزارش‌ها:** هیچ‌کدام `person_mobiles` را نمی‌خوانند. هیچ view یا نمای مادی‌شده‌ای در مهاجرت‌ها آن را ندارد؛ grep روی همه `drizzle/*.sql` فقط `0015` و `0081` را نشان داد. جست‌وجوی سرنخ با موبایل وجود ندارد. آزمون ایستا هر خواندن تازه را می‌گیرد.
- **seed محیط e2e** (`apps/e2e/.stack/dev/seed-4-8.ts`) یک بار برای یافتن Person داده آزمون SQL خام دارد. کد برنامه نیست.

## ۱۰. `proved_at`: فقط با شاهد ورود OTP

- **شاهد:** یک ردیف `sessions` برای حساب بیمار با همان موبایل. نشست بیمار را فقط `otp-login.service` می‌سازد، پس از تأیید کد OTP (`sessions.create` در خط ۱۷۲). جای دیگری از کد، seed یا اسکریپتی در `sessions` درج نمی‌کند (grep شد). نخستین نشست، زمان اثبات است.
- **شماره‌هایی که کارمند وارد کرده** و کسی با آن‌ها وارد نشده، `null` می‌مانند.
- **از این پس:** نخستین ورود OTP با یک موبایل، `proved_at` را پر می‌کند (`PERSON_DIRECTORY.linkLogin`)، حتی اگر موبایل pending باشد. «تأییدشده بودن» و «فعال بودن» جدا هستند؛ اعلان و تأیید (الف) هر دو را می‌خواهند.

**شمارش روی پایگاه محلی** (فقط‌خواندنی، ۱۴۰۵/۰۷/۱۹):

| دسته | تعداد |
|---|---|
| با نشست OTP (پر می‌شود) | **۱۰** |
| حساب بیمار بدون نشست | ۰ |
| بدون حساب (ورودی کارمند) | ۰ |
| همه موبایل‌های زنده | ۱۰ |

## ۱۱. مهاجرت 0081: خلاصه SQL نهایی (**اجرا نشده**؛ منتظر تأیید مالک)

- **فایل:** `apps/api/drizzle/0081_person_mobile_approval.sql`. با `drizzle-kit generate` و snapshot ساخته شد و بخش داده دستی افزوده شد. drift پاک است (`db-drift.sh` در lint).
- **pg_dump پیش از اجرا:** `D:\sepehr_app\db-backups\sepehr-before-0081-20261011-054746.dump`، حدود ۱٫۳ مگابایت، سالم (`pg_restore -l` با ۲۷۴۲ مدخل). مهاجرت‌های اعمال‌شده اکنون ۸۱ تاست.

```sql
-- جدول تازه، فقط‌افزودنی
CREATE TABLE person_mobile_decisions (
  id uuid PK DEFAULT uuidv7(), person_mobile_id uuid NOT NULL REFERENCES person_mobiles(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  method   text NOT NULL CHECK (method IN ('owner_panel','staff','expiry','import_cancelled')),
  decided_by uuid, reason text NOT NULL, evidence text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX person_mobile_decisions_mobile_idx ON person_mobile_decisions (person_mobile_id);
CREATE TRIGGER person_mobile_decisions_append_only BEFORE UPDATE OR DELETE … reject_append_only_change();
REVOKE UPDATE, DELETE ON person_mobile_decisions FROM sepehr_app;
GRANT SELECT, INSERT ON person_mobile_decisions TO sepehr_app;

-- ستون‌های تازه person_mobiles (بخش ۱۶: status بی پیش‌فرض)
ALTER TABLE person_mobiles ADD COLUMN status text;
UPDATE person_mobiles SET status = 'active';            -- ردیف‌های فعلی، صریح
ALTER TABLE person_mobiles ALTER COLUMN status SET NOT NULL;  -- بدون DEFAULT
--   CHECK IN ('active','pending','rejected'); CHECK: rejected ⇒ deleted_at NOT NULL
ALTER TABLE person_mobiles
  ADD COLUMN proved_at timestamptz,
  ADD COLUMN added_via text,                          -- CHECK IN ('person_created','intake','import','credit_transfer','merge'); قدیمی‌ها NULL
  ADD COLUMN added_by uuid,
  ADD COLUMN pending_expires_at timestamptz,          -- CHECK: pending ⇒ NOT NULL (مهلت قفل‌شده روی ردیف)
  ADD COLUMN import_batch_id uuid;                    -- دسته import که آن را pending افزود
CREATE INDEX person_mobiles_pending_idx ON person_mobiles (pending_expires_at)
  WHERE status = 'pending' AND deleted_at IS NULL;
-- برنامه از person_mobiles فقط deleted_at را می‌توانست تغییر دهد (0015)؛ اکنون status و proved_at هم:
GRANT UPDATE (status, proved_at) ON person_mobiles TO sepehr_app;
-- trigger برای همه نقش‌ها، مالک هم: status فقط pending→active یا pending→rejected؛ proved_at یک‌بار
CREATE FUNCTION public.person_mobiles_guard() … ; CREATE TRIGGER person_mobiles_guard BEFORE UPDATE ON person_mobiles …;

-- پر کردن proved_at با شاهد OTP (۱۰ ردیف محلی؛ ۰ ردیف null)
UPDATE person_mobiles pm SET proved_at = s.first_login_at
  FROM (SELECT u.mobile, min(se.created_at) first_login_at FROM user_accounts u
          JOIN sessions se ON se.account_id = u.id
         WHERE u.kind = 'patient' AND u.deleted_at IS NULL GROUP BY u.mobile) s
 WHERE s.mobile = pm.mobile AND pm.deleted_at IS NULL;

-- گسترش قید (تأیید مالک)، در همین تراکنش، با اعتبارسنجی کامل
ALTER TABLE factor_change_notices DROP CONSTRAINT factor_change_notices_event_check;
ALTER TABLE factor_change_notices ADD CONSTRAINT factor_change_notices_event_check CHECK (event IN
  ('password_changed','totp_reset','totp_enrolled','mobile_changed','patient_mobile_changed',
   'patient_mobile_added','patient_mobile_approved','patient_mobile_rejected'));

-- مجوز، کلید پیکربندی و قالب‌ها
INSERT INTO permissions (code) VALUES ('lead.approve_person_mobile');   -- هیچ نقشی آن را ندارد
INSERT INTO config_keys / config_values: lead.person_mobile_pending_days = 30 (business، حساس، global)
INSERT INTO sms_templates: identity.factor.patient_mobile_{added,approved,rejected} (patient، urgent، بدون متغیر)
```

**اثر روی داده محلی:**

- ۱۰ ردیف `person_mobiles` صریحاً `active` می‌شوند و ۱۰ ردیف `proved_at` می‌گیرند. backfill پیش از ساخت trigger اجرا می‌شود.
- هیچ ردیفی حذف یا وضعیت‌شان عوض نمی‌شود.
- `factor_change_notices` اکنون ۰ ردیف دارد، پس قید تازه روی هیچ ردیفی شکست نمی‌خورد.

**پس از اجرا:**

1. بررسی فقط‌خواندنی.
2. drift.
3. آزمون UPDATE/DELETE روی هر دو جدول فقط‌افزودنی (`factor_change_notices` و `person_mobile_decisions`)، با `sepehr_app` و با نقش مالک، در تراکنش برگشت‌خورده.
4. commit.

## ۱۲. ادغام Person

- **R1:** `assertFreshMfa` پیش از هر کار، هم برای ادغام و هم برای **بازگردانی ادغام**. بازگردانی دسترسی را عوض می‌کند و محتاطانه شامل شد.
- **کد ملی متفاوت:** از تسک ۲-۵b رد می‌شد (`409 national_id_conflict`) و بی‌تغییر ماند. در آزمون تازه دوباره بررسی شد.
  - اگر فقط یکی از دو طرف کد ملی داشته باشد، «متفاوت» نیست و ادغام مثل قبل مجاز است.
- **R2:** با کد ملی یکسان، موبایل‌های تأییدشده هر دو طرف اعلان `patient_mobile_added` با `personMobileId: null` می‌گیرند. در غیر این صورت موبایل‌های طرف ادغام‌شونده pending می‌شوند (بخش ۱۶) و موبایل‌های تأییدشده survivor برای هر کدام اعلان می‌گیرند. audit `lead.persons_merged` مثل قبل است.

## ۱۳. مهلت و رد خودکار

- **کلید:** `lead.person_mobile_pending_days` با مقدار ۳۰، دسته business، تغییر دونفره مثل هر کلید دیگر. هنگام افزودن روی ردیف قفل می‌شود (`pending_expires_at`)، پس تغییر بعدی فقط روی ردیف‌های تازه اثر دارد.
- **کار worker:** `person-mobile-expiry` هر ۱۵ دقیقه اجرا می‌شود، در دسته‌های ۱۰۰تایی با `FOR UPDATE SKIP LOCKED`.
  - هر ردیف رد و حذف منطقی می‌شود.
  - در `person_mobile_decisions` با `rejected` و روش `expiry` و `decided_by` خالی ثبت می‌شود.
  - audit `lead.person_mobile_rejected` می‌گیرد و اعلان `patient_mobile_rejected` می‌رود.
- **تصمیم صاحب پس از مهلت:** `409 person_mobile_expired`، حتی پیش از اجرای کار.

## ۱۴. تصمیم‌های اجرایی (برگشت‌پذیر، ثبت‌شده)

1. **ستون مهلت** `pending_expires_at` نام گرفت، چون قرارداد نام‌گذاری می‌خواهد ستون زمانی به `_at` ختم شود. مهلت پس از تأیید هم برای سابقه روی ردیف می‌ماند.
2. **رد** = `status = 'rejected'` و حذف منطقی ردیف (قاعده ۷)، تا موبایل آزاد شود و در ورود بعدی Person خودش را بسازد (بخش ۱۶ این را از «pending با deleted_at» عوض کرد).
3. **وصل شدن حساب پس از تأیید:** مصرف‌کننده identity، `person_id` حسابِ همان موبایل را فوراً پر می‌کند و منتظر ورود بعدی نمی‌ماند.
4. **پرسش از دفتر شخص** در ورود OTP فقط تا وصل شدن حساب انجام می‌شود (رفتار قبلی، آزمون «once» بی‌تغییر). همان ورودی که حساب را وصل کرد موبایل را اثبات کرد، و حساب‌های قبلی را مهاجرت اثبات کرد.
5. **نوبت خود بیمار با موبایل pending** رد می‌شود (`refused`، همان پیام عمومی «در دسترس نیست»). نوبت کارمند برای تماس‌گیرنده ادامه دارد.
6. **گیرنده انتقال اعتبار** هرگز pending ساخته نمی‌شود: `recipient_mobile_mismatch` یا `recipient_mobile_pending`. پرچمش خاموش است (م۶).
7. **پنل بیمار:**
   - **برای صاحب:** فقط چهار رقم پایانی شماره تازه و مهلت را می‌بیند. تأیید یک گام دوم دارد («با تأیید، صاحب آن شماره همه نوبت‌ها، پرونده‌ها و اقساط شما را می‌بیند»).
   - **برای صاحب موبایل pending:** پیام «این شماره در انتظار تأیید است»، بدون هیچ داده.
8. **پنل کارکنان:** بخش تازه «موبایل‌های در انتظار تأیید» (`/person-mobiles`) با مجوز `lead.approve_person_mobile`. تأیید دلیل و مدرک می‌خواهد و رد فقط دلیل. پنجره بازاحراز R1 خودش باز می‌شود.
9. **import لغوشده:** با دستور مالک جایگزین شد (بخش ۱۶): با لغو دسته رد می‌شود.

10. نام audit برای «بی گیرنده» `lead.person_mobile_notice_skipped` شد (رخداد از ماژول lead است)، نه `identity.factor_notice_skipped` که در نقشه آمده بود. خلاصه SQL بخش ۴ نقشه جای خود را به بخش ۱۱ داده است.

## ۱۵. آزمون‌ها

- **یکپارچه تازه** `test/lead/person-mobile-approval.int.test.ts`: **۱۵ از ۱۵ سبز.** شامل هر سه ورودی، همه مسیرهای بخش ۹، (الف) با IDOR، (ب) با چهارچشمی و مدرک و R1، Person بی موبایل تأییدشده، مهلت، ادغام، و فقط‌افزودنی بودن `person_mobile_decisions` برای `sepehr_app`.
- **ایستا** `test/lead/person-mobiles-reads.test.ts`: **۳ از ۳.**
- **turbo** `lint typecheck test build`: **۳۴ از ۳۴**، با drift پاک.
- **یکپارچه کامل:** ۷۷ فایل، **۹۴۶ سبز و ۱ todo** (پیش از این تسک ۹۲۵).
- **آزمونی ضعیف یا حذف نشد.** تغییر در آزمون‌های موجود:
  - `test/outbox/outbox.int.test.ts`: کار تازه `person-mobile-expiry` به فهرست کامل زمان‌بندها افزوده و بازه ۱۵ دقیقه‌اش قفل شد. افزودنی است و چیزی کم نشد.
  - `FakePersonDirectory` در `test/identity/harness.ts` دو متد تازه درگاه را گرفت.
  - هیچ ادعایی عوض نشد.
- **خطای خودم که آزمون گرفت:** `PersonMobileApprovalService` اول در ماژول هسته lead بود، ولی worker درگاه `ACCOUNT_DIRECTORY` را محلی می‌دهد و هسته آن را نمی‌دید؛ worker بالا نمی‌آمد. سرویس به ماژول API و providerهای worker منتقل شد.
- **باگ واقعی پیداشده در حین کار:** برنامه روی `person_mobiles` فقط اجازه `UPDATE (deleted_at)` داشت (0015). بی `GRANT UPDATE (status, proved_at)`، ورود OTP بی‌صدا شکست می‌خورد و حساب به Person وصل نمی‌شد. آزمون‌های یادآور قسط این را گرفتند و grant به 0081 افزوده شد.


## ۱۶. تأیید 0081 با چهار اصلاح (مالک، ۱۴۰۵/۰۷/۱۹، دور سوم)

**دستور:** پیش از اجرا SQL عوض شود، فقط diff آن نشان داده شود و منتظر تأیید ماند.

1. **`status` بی پیش‌فرض.**
   - ستون خالی افزوده می‌شود، ردیف‌های فعلی صریحاً `active` می‌شوند، سپس `NOT NULL` بدون `DEFAULT`.
   - `PersonMobiles.add` اکنون `status` را صریح می‌گیرد (نوع TypeScript: `active`، یا `pending` همراه مهلت).
   - **برداشت از «ورود OTP بیمار تازه = active، بقیه = pending»:** `active` فقط برای تنها موبایل Personی است که همان لحظه با آن ساخته می‌شود؛ `pending` برای هر موبایلی که به Person موجود می‌رسد (intake، import، ادغام). Person تازه‌ای که کارمند با موبایل تازه می‌سازد هم `active` است، چون آن Person جز همین موبایل کسی را ندارد و داده کس دیگری در آن نیست. اگر منظور مالک pending شدن این‌ها هم بوده، باید گفته شود: آن‌گاه هر سرنخ تازه پیامک نمی‌گیرد تا کارمند دیگری تأییدش کند.
   - **آزمون:** درج بدون `status` با `sepehr_app` رد می‌شود (`23502`).
2. **trigger `person_mobiles_guard`** (`BEFORE UPDATE`، برای همه نقش‌ها):
   - `status` فقط `pending→active` یا `pending→rejected`. هر تغییر دیگر `check_violation` می‌دهد.
   - `proved_at` پس از پر شدن تغییر نمی‌کند، نه به مقدار دیگر و نه به null.
   - برای همین، «رد» اکنون `status = 'rejected'` است، با قید تازه `rejected ⇒ deleted_at NOT NULL`.
   - **آزمون‌ها با `sepehr_app`:** active→pending، active→rejected، rejected→active و rejected→pending رد می‌شوند. pending→active و pending→rejected (با deleted_at) پذیرفته می‌شوند. پر کردن `proved_at` یک‌بار پذیرفته و تغییر یا null کردنش رد می‌شود. ورود بعدی اولین زمان را نگه می‌دارد.
3. **ادغام و بازگردانی.**
   - موبایل‌های تأییدشده طرف ادغام‌شونده دوباره pending صادر می‌شوند، با مهلت ۳۰ روزه: ردیف قبلی حذف منطقی می‌شود و ردیف تازه با `added_via = 'merge'` و همان `proved_at` درج می‌شود. trigger اجازه بازگشت به pending نمی‌دهد و سابقه هم می‌ماند.
   - بازگردانی، موبایل‌های تأییدشده Personی را که دوباره تنها می‌شود همین‌طور pending می‌کند.
   - **استثنا:** کد ملی یکسان در دو طرف. **در عمل رخ نمی‌دهد**، چون `persons_national_id_index_key` کد ملی را میان اشخاص زنده یکتا نگه می‌دارد و شخص ادغام‌شده هم زنده است. پس اکنون هر ادغام و بازگردانی‌ای pending می‌کند. شاخه استثنا برای قاعده مالک نگه داشته شد و آزمونی ندارد، چون fixture نمی‌تواند آن را بسازد.
   - **پیدا شده در حین کار (حفره واقعی):** حساب بیماری که پیش‌تر به Person ادغام‌شونده وصل بوده، از راه زنجیره ادغام به داده survivor می‌رسید، چه موبایلش pending بود چه نه. همه مسیرهای بیمار `personId` را از `ACCOUNT_DIRECTORY.find` می‌گیرند.
     - **اصلاح:** `find` برای حساب بیمار `personId` را فقط وقتی می‌دهد که موبایل حساب، تأییدشده و زنده، روی همان Person یا یکی از ادغام‌شده‌هایش باشد (`PersonDirectory.standsFor`، متد تازه درگاه). خود وصل بودن حساب دست نمی‌خورد.
     - **آزمون:** پس از ادغام، حساب وصل‌شده هیچ داده‌ای از survivor نمی‌بیند. پس از تأیید می‌بیند. پس از رد، و حتی وقتی intake بعدی برای همان موبایل Person تازه می‌سازد، باز نمی‌بیند.
   - **آزمون‌ها:** ادغام، تأیید صاحب survivor، بازگردانی که دوباره pending می‌کند (و صف کارکنان `hasProvedMobile: false` نشان می‌دهد)، و رد موبایل جابه‌جاشده.
4. **لغو import.** تغییر کوچک بود و در همین تسک انجام شد، نه تسک جدا.
   - ستون `import_batch_id` ردیف pending را به دسته‌اش وصل می‌کند.
   - `cancel` در همان تراکنش همه ردیف‌های pending دسته را رد می‌کند (`method = 'import_cancelled'`، `decided_by` همان کارمند و `reason` همان دلیل لغو)، audit و اعلان R2 می‌فرستد. شمارش در audit `lead.import_cancelled` (`rejectedMobiles`) می‌آید.
   - **آزمون:** ردیف دسته رد و ثبت می‌شود. موبایل pending همان Person که از intake آمده دست نمی‌خورد.

**تغییر در آزمون‌های موجود (این دور):**

- آزمون ادغام بخش ۱۲: رویداد اکنون روی Person ادغام‌شونده و با شناسه ردیف تازه pending است، نه `personMobileId: null` روی survivor. علتش رفتار تازه است. ادعای «صاحب survivor پیامک می‌گیرد» بی‌تغییر ماند.
- آزمون رد (الف): ادعای `status = 'rejected'` افزوده شد.
- `FakePersonDirectory`: متد `standsFor` را گرفت.
- `test/lead/lead.int.test.ts` («merging persons»): دو ادعا که می‌گفتند موبایل ادغام‌شونده پس از ادغام به survivor و پس از بازگردانی به خودش می‌رسد، اکنون `null` می‌خواهند. این دقیقاً همان رفتاری است که اصلاح ۳ می‌خواهد (pending تا تأیید). بقیه ادعاهای آزمون (جابه‌جایی پرونده، بازگردانی دقیق، audit، رد کد ملی متفاوت) بی‌تغییرند.
- `test/lead/person-mobiles-reads.test.ts`: دو تابع تازه در فهرست‌ها: `lockPendingOfBatch` (خواندنی که pending را می‌بیند، فقط برای رد) و `reissuePending` (نوشتن).
- **یکپارچه کامل:** ۹۴۶ سبز. دو فایل ناسبز بودند: همین `lead.int` و `credit-queues` که آماده‌سازی‌اش زیر بار از ۱۲۰ ثانیه گذشت. هر دو پس از اصلاح جدا اجرا شدند و ۲۴ از ۲۴ سبز شدند.

**باگ‌هایی که آزمون گرفت:**

- قرارداد پاسخ صف کارکنان (`addedVia`) مقدار `merge` را نمی‌شناخت و ۵۰۰ می‌داد. به قرارداد و برچسب صفحه ادمین افزوده شد.
- خطای ابزار خودم: `$$` بدنه تابع در ویرایش به `$` تبدیل شده بود. مهاجرت در آزمون شکست خورد و درست شد.

## ۱۷. پاسخ مالک، اصلاح نهایی trigger، و اجرا (۱۴۰۵/۰۷/۱۹، دور چهارم)

**پاسخ‌ها:**

1. **Person تازه‌ای که کارمند می‌سازد:** تنها موبایلش `active` است (تأیید شد).
   - **شرط مالک:** تأییدکننده راه (الف) و گیرنده اعلان R2 فقط موبایلی است که `status = 'active'`، `proved_at IS NOT NULL` و `deleted_at IS NULL` دارد.
   - R2 از پیش همین بود (`provedOf`). در `ownerOf` (راه الف) هر سه شرط اکنون صریح نوشته شده‌اند.
   - **آزمون‌ها:**
     - موبایل `active` بی `proved_at` نه اعلان می‌گیرد (audit «بی گیرنده») و نه می‌تواند تأیید یا رد کند (۴۰۴، بی ثبت تصمیم).
     - ردیف pending با `proved_at` کپی‌شده از ادغام نه اعلان افزودن موبایل دیگر را می‌گیرد و نه می‌تواند آن را تأیید کند.
2. **استثنای کد ملی یکسان** از کد حذف شد. هر ادغام و هر بازگردانی موبایل‌ها را pending می‌کند.

**تنها تغییر SQL** (مالک خواست فقط diff همین نشان داده شود): در `person_mobiles_guard`، برگشت `deleted_at` از مقدار به NULL رد می‌شود (`a deleted row stays deleted`). آزمون با `sepehr_app`، چه تنها و چه همراه تغییر status.

**اجرا (پایگاه محلی):**

- **pg_dump تازه پیش از اجرا:** `D:\sepehr_app\db-backups\sepehr-before-0081-final-20261011-135618.dump`، حدود ۱٫۳ مگابایت، با `pg_restore -l` سالم (۲۷۴۲ مدخل).
- **`db:migrate`:** `migrations applied`؛ اکنون ۸۲ مهاجرت.
- **بررسی فقط‌خواندنی:**
  - ۱۰ ردیف `person_mobiles`، همه `active`، همه با `proved_at`، همه زنده.
  - `status` NOT NULL و بدون DEFAULT. شش ستون تازه درست‌اند.
  - قیدها سر جایشان‌اند. `factor_change_notices_event_check` با `convalidated = t`.
  - triggerها: `person_mobiles_guard`، `person_mobile_decisions_append_only` و `factor_change_notices_append_only`، و بدنه تابع قاعده `deleted_at` را دارد.
  - grantها: `sepehr_app` روی `person_mobile_decisions` فقط SELECT و INSERT دارد، و روی `person_mobiles` فقط UPDATE ستون‌های `deleted_at`، `proved_at` و `status`.
  - مجوز تازه هست و هیچ نقشی آن را ندارد. پیکربندی ۳۰ تأییدشده است. سه قالب تازه هستند.
  - `person_mobile_decisions` و `factor_change_notices` ۰ ردیف دارند.
- **drift:** `Schema and migrations are in sync`.
- **آزمون UPDATE/DELETE و trigger روی پایگاه محلی:** با `sepehr_app` و `sepehr_owner`. هر دستور در زیرتراکنش برگشت‌خورده و کل کار در یک تراکنش با ROLLBACK اجرا شد. پس از آن ۰، ۰ و ۱۰ ردیف `active`، بی هیچ تغییر.

  | دستور | `sepehr_app` | `sepehr_owner` |
  |---|---|---|
  | UPDATE و DELETE روی `factor_change_notices` | `42501 permission denied` | `42501 … is append-only` |
  | UPDATE و DELETE روی `person_mobile_decisions` | `42501 permission denied` | `42501 … is append-only` |
  | active→pending، active→rejected | `23514` trigger | `23514` trigger |
  | تغییر `proved_at` یا NULL کردنش | `23514 proved_at is set once` | همان |
  | `deleted_at` به NULL | `23514 a deleted row stays deleted` | همان |
  | rejected→active | `23514` | `23514` |
  | DELETE روی `person_mobiles` | `42501 permission denied` | `42501 … is append-only` |
  | درج بی status | `23502` | `23502` |
  | pending→active، و pending→rejected با deleted_at | پذیرفته | پذیرفته |

**جانبی:**

- **پروسه `node src/stack.ts` (PID 24592) بسته شد.** پیش از آن، فهرست کانتینرهای session `4a060433c1d9` نشان داده شد: یک postgres، یک redis، دو کانتینر بی‌نام (فضای فایل و اسکنر stack) و ryuk. ryuk هر پنج را پاک کرد. چهار سرویس پروژه (`sepehr-postgres-1`، `sepehr-redis-1`، `sepehr-seaweedfs-1` و `sepehr-clamav-1`) برچسب testcontainers ندارند و بالا ماندند.
- **بدهی فنی:** «ناپایداری آزمون‌ها زیر بار کامل» در RESUME ثبت شد (ب‌ف۱).

**آزمون‌ها (این دور):**

- یکپارچه person-mobile: ۲۴ از ۲۴، همراه با `lead.int`، ۴۳ از ۴۳ در کل.
- turbo `lint typecheck test build`: ۳۴ از ۳۴، drift پاک.
