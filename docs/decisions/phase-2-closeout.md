# جمع‌بندی و بستن فاز ۲

تاریخ: ۱۴۰۵/۰۷/۱۰ (۲۰۲۶-۱۰-۰۲). روی commit `20cf53b`، شاخه `main`.

در این مرور هیچ قابلیت تازه‌ای ساخته نشد. فقط آزمون‌ها اجرا شد، شواهد گردآوری شد و این سند نوشته شد.

---

## ۱. اجرای کامل آزمون‌ها

| مجموعه | نتیجه | skip / todo |
|---|---|---|
| typecheck و lint، کل مخزن (`turbo --force`، بدون کش) | ۳۰ از ۳۰ کار سبز | — |
| آزمون واحد (Vitest)، ۸ بسته | ۵۷۶ سبز: contracts ۲۳۶، ui ۱۰۹، api ۱۰۸، config ۷۰، worker ۲۴، web ۱۶، api-client ۹، admin ۴ | ۰ |
| یکپارچه API (Postgres، Redis، SeaweedFS و ClamAV واقعی) | ۲۲ فایل؛ ۳۰۲ سبز، ۰ قرمز (حدود ۱۵ دقیقه) | ۱ todo |
| انتهابه‌انتها (Playwright، Chrome نصب‌شده، build تولیدی) | ۲۲ سبز، ۰ قرمز: مسیر کامل، پنل مرکز، پنل داخلی، SEO، فقط شمسی، ۶ بودجه کارایی | ۰ |

**آزمون todo** (`apps/api/test/catalog/centers.int.test.ts`):
`future appointments of a suspended center go to the relocation queue, not deleted`
این همان نیمه دوم آزمون ۵ سند ۰۸ است که ساخته نشده (بخش ۲ پایین).

**پیام‌های ERROR در لاگ** (`queue unavailable`، `person directory unavailable`): از آزمون‌هایی می‌آیند که عمداً از کار افتادن صف یا پورت را شبیه‌سازی می‌کنند. شکست نیستند.

**تست حذف‌شده:** از نخستین commit فاز ۲ (`95d53a5`) تا امروز هیچ فایل آزمونی حذف نشده (`git log --diff-filter=D`). در کد هیچ `skip`، `only` یا `fixme` نیست. تنها todo همان مورد بالاست.

**تست ضعیف‌شده:** هیچ‌کدام. اسناد تصمیم ۲-۶، ۲-۸، ۲-۹ و ۲-۱۱ هر کدام «هیچ آزمونی حذف یا ضعیف نشد» را ثبت کرده‌اند. چند تغییر در آزمون‌ها انجام شد که ادعای آن‌ها را کم نکرد:
- **۲-۶:** آزمون زمان‌بندها که `booking-sweep` را نمی‌شناخت، به‌روز و **سخت‌تر** شد.
- **۲-۸ و ۲-۹:** سه آزمون حساس به زمان‌بندی پایدار شدند (`appointments.int`، `sms-worker.int`). `calendar.int` به گروه سنگین و ترتیبی رفت. ادعاها همان ماند.
- **۲-۱۱:** آزمون جست‌وجوی «تعطیلی و نزدیک‌ترین زمان» به روز هفته وابسته بود و مستقل شد، با همان ادعاها.
- **۲-۱۱:** قاعده «سال میلادی» در بررسی «فقط شمسی» محدود شد. چهار رقم آخر شناسه پوشیده را سال می‌گرفت. تاریخ‌های میلادی و نام ماه‌ها همچنان گرفته می‌شوند و هر دو مورد به خودآزمون آن اضافه شد. این بررسی را خودم در همان تسک نوشته بودم.

---

## ۲. معیارهای پذیرش تسک‌ها (docs/09)

نام آزمون‌ها به شکل `فایل › عنوان` آمده است. «سند ۰۸ آزمون N» یعنی بند N از بخش ۱۵ سند ۰۸.

### ۲-۱ تقویم تعطیلات
- ✅ روشن بودن جابه‌جایی سررسید، سررسید را به نخستین روز کاری بعد می‌برد و مجموع ثابت می‌ماند؛ با خاموش بودن، هیچ برنامه‌ای تغییر نمی‌کند.
  شاهد: `config/holidays.int › off: no schedule changes; on: the due day moves to the next working day, total unchanged`

### ۲-۲ ثبت و فعال‌سازی مرکز
- ✅ **آزمون ۸** (فعال‌سازی و تغییر شبا با یک کاربر رد شود). شاهدها:
  - `catalog/centers.int › the proposer cannot approve an activation, even holding network_manager`
  - `catalog/centers.int › the same user cannot propose and approve a Sheba change, even with both permissions`
  - انتهابه‌انتها: `admin.spec › a center under review: … activation proposed by one, approved by another`
- ✅ **ثبت دوم با همان شناسه ملی رد شود.**
  شاهد: `catalog/centers.int › ACCEPTANCE: a second registration with the same ID is refused; so is the same Sheba`
- ⚠️ **آزمون ۵، نیمه اول** (مرکز `suspended` نوبت جدید نمی‌پذیرد و نوبت‌های قبلی حذف نمی‌شوند) برقرار است. شاهدها:
  - `catalog/centers.int › a suspended center takes no new appointment and publishes catalog.center_suspended`
  - `booking/appointments.int › a suspended center takes no new holds and offers no slots; its appointments stay`
- ❌ **آزمون ۵، نیمه دوم: «صف جابه‌جایی» ساخته نشده** (`it.todo`؛ ADR-027، «مانده»).

### ۲-۳ پزشک، منشی و واگذاری
- ✅ **آزمون ۶** (منشی به پزشک دیگر نمی‌رسد، حتی با دستکاری شناسه). شاهدها:
  - `catalog/doctors.int › ACCEPTANCE (doc 08 §15 test 6): a secretary never reaches another doctor`
  - `booking/calendar.int › manage their own doctor's calendar when delegated, never another doctor's, even with a tampered id`
- ✅ **آزمون ۷.** شاهد: `catalog/doctors.int › ACCEPTANCE (doc 08 §15 test 7): doctor A sees nothing of doctor B; the clinic manager sees both`

### ۲-۴ کاتالوگ و تعرفه
- ✅ **آزمون ۴**، پس از ساخت نوبت دوباره اجرا شد. شاهدها:
  - `catalog/tariffs.int` (doc 08 §15 test 4)
  - `booking/appointments.int › keeps the version and range quoted at booking`

### ۲-۵ تقویم کاری و اسلات
- ✅ **آزمون ۳.** شاهدها:
  - `booking/calendar.int › a holiday gives no slot unless the doctor opened it; the weekly day off does not apply`
  - `contracts/booking/slots.test`
- ✅ **آزمون ۱۳.** شاهدها:
  - `booking/calendar.int › Tehran midnight (doc 08 §15 test 13) › slots belong to the Tehran day, not the UTC one`
  - `contracts/booking/slots.test`
- ✅ **اسلات‌های یک ماه یک پزشک زیر ۲۰۰ میلی‌ثانیه** (p95 حدود ۳۴ میلی‌ثانیه).
  شاهد: `booking/calendar.int › a month of one doctor's slots in under 200 ms`
- ❌ **این سنجش با k6 انجام نشده** (عقب‌افتاده؛ بخش ۳).

### ۲-۵ب ماژول lead
- ✅ **سند ۰۵ آزمون‌های ۱ و ۲.**
  شاهد: `lead/lead.int › 10,000 leads at 50/30/20 deviate less than 2%; a zero share gets nothing`
- ✅ **آزمون ۳.** شاهد: `lead/lead.int › two forms of one mobile make one Person; …`
- ✅ **آزمون ۴.** شاهد: `lead/lead.int › 100 simultaneous leads: no case goes to two agents; …`
- ✅ **آزمون ۵.** شاهد: `lead/lead.int › a new case marked returning, with the full history, …`
- ✅ **آزمون ۶.** شاهد: `lead/lead.int › previews, processes, and a cancel undoes only what nobody touched`
- ✅ **گزارش backfill.** شاهدها:
  - `lead/lead.int › dry run first, then apply; idempotent; audited per link`
  - `identity/person-backfill.int › never links a shared or invalid mobile: those go to manual review with their reason`
  - پایگاه داده محلی، بررسی فقط‌خواندنی امروز: ۱ حساب بیمار، **۰ بدون `person_id`**، ۲ اجرا در `person_backfill_runs`.
- ✅ **`PERSON_DIRECTORY` بدون تغییر امضا وصل است.** شاهدها:
  - `lead/lead.int › a patient login links the account to the real Person of that mobile`
  - تاریخچه `packages/contracts/src/identity/person-directory.ts` فقط commit تسک ۰-۴ را دارد.

### ۲-۶ نوبت و معرفی
- ✅ **آزمون ۱ و ۵۰ درخواست هم‌زمان** (دقیقاً یک موفق).
  شاهد: `booking/appointments.int › 50 patients at once for one slot: exactly one hold, 49 slot_taken, no errors`
- ✅ **آزمون ۲.** شاهد: `booking/appointments.int › doc 08 §15 test 2: a lapsed hold frees its slot`
- ✅ **آزمون ۴.** همان شاهد ۲-۴.
- ✅ **آزمون ۱۱.** شاهد: `booking/appointments.int › a request writes one referral on the person and case; it cannot be edited or deleted`

### ۲-۷ جست‌وجو
- ✅ **آزمون ۱۲.** شاهدها:
  - `catalog/search.int › doc 08 §15 test 12: «علي» and «علی», «۱۴۰۵» and «1405» give the same results`
  - `contracts/catalog/search.test`
- ✅ **EXPLAIN از ایندکس استفاده می‌کند.** شاهد: `catalog/search.int › the main query uses the trigram index` (`search_entries_search_key_trgm`)

### ۲-۸ رسانه و پروفایل عمومی
- ✅ **آزمون ۱۰، نیمه اول.** شاهد: `catalog/profiles.int › doc 08 §15 test 10, first half: nothing unpublished is public; a new slug is a 301`
- ✅ **فایل با پسوند جعلی رد می‌شود.** شاهد: `catalog/profiles.int › refuses a fake extension, a mismatched one and an unknown type, storing nothing`

### ۲-۹ ورود گروهی از اکسل
- ✅ **آزمون ۹.** شاهد: `catalog/bulk-import.int › test 9: committed centers are drafts, never active; their doctors wait`
- ✅ **نمونه ۱۰ مرکز و ۵۰ پزشک با ردیف‌های خطادار.** شاهد: `catalog/bulk-import.int › doc 08 §15 test 9 and the sample of 10 centers and 50 doctors`

### ۲-۱۰ سیستم طراحی و تقویم شمسی
- ✅ **صفحه نمونه را مالک تأیید کرد** (`task-2-10-decisions.md`، ADR-031).
- ✅ **ورود ارقام فارسی و انگلیسی و انتخاب بازه.** شاهدها:
  - `ui/calendar/calendar.test › a range typed with «تا», in either order and any digits`
  - `ui/calendar/calendar.test › a range is shown right to left, …`
- ✅ **نمایش تعطیلی.** شاهد: `ui/calendar/calendar.test › a holiday from the holidays table has its own mark, and says so`
- ✅ **دسترس‌پذیری.** شاهد: `ui/calendar/calendar.test › … have no serious finding` (axe-core)

### ۲-۱۱ صفحات فاز ۲
- ✅ **مسیر کامل «جست‌وجو ← صفحه پزشک ← رزرو ← تأیید مرکز ← پذیرش».**
  شاهد: `e2e/full-path.spec › search → doctor page → booking → center approval → check-in`
- ✅ **آزمون ۱۰، نیمه دوم.** شاهدها:
  - `e2e/seo.spec › a published profile is indexable, canonical, with Physician and MedicalClinic data`
  - `e2e/seo.spec › an unknown or unpublished profile is not found and never indexed`
- ✅ **بودجه کارایی موبایل.** شاهد: `e2e/performance.spec › budget on a phone: …` (شش مسیر؛ LCP بین ۰٫۷۲ و ۰٫۹۶ ثانیه، CLS صفر، JS بین ۱۷۲ و ۱۸۴ کیلوبایت).
- یادداشت: سوییچ میان نمای ماه، هفته و روز تقویم کاری پنل ساخته شده، اما آزمون انتهابه‌انتها فقط نمای پیش‌فرض را باز می‌کند. این جزو معیار پذیرش نیست.

### معیارهای برقرارنشده (فهرست جدا)

1. **سند ۰۸ آزمون ۵، نیمه دوم:** صف جابه‌جایی نوبت‌های آینده مرکز `suspended`. نوبت‌ها حذف نمی‌شوند، اما صفی هم ساخته نشده که آن‌ها را برای جابه‌جایی جمع کند (`it.todo`). **پیش از اولین تعلیق مرکز واقعی** باید ساخته شود.
2. **k6 برای ۲-۵** (و آزمون بار نوبت در ۲-۶): زیرساخت k6 در مخزن نیست. معیار عددی با آزمون یکپارچه سنجیده و برقرار است، اما با k6 نه (تصمیم مالک ۱۴۰۵/۰۷/۰۷: عقب افتاد).

---

## ۳. فهرست یکجا: کارهای مانده و موارد باز

### کارهای فنی پیش از داده واقعی یا استقرار

| مورد | وضعیت | کی |
|---|---|---|
| **k6** (معیار ۲-۵ و آزمون بار رزرو) | زیرساختی در مخزن نیست؛ فقط در جدول پشته CLAUDE.md آمده | پیش از استقرار؛ پیشنهاد: هم‌زمان با آماده شدن محیط staging |
| **`VALIDATE CONSTRAINT`** برای `center_treatment_fields_field_code_fk` و `doctor_treatment_fields_field_code_fk` (مهاجرت ۰۰۱۲، `NOT VALID`) | انجام نشده؛ نیازمند یک مهاجرت جدا و اجازه مالک | **پیش از فاز ۵ و پیش از ورود داده واقعی** (docs/09، یادداشت فنی ۱) |
| **`BLIND_INDEX_KEY`** راز جدا از `FIELD_ENCRYPTION_KEY`، در API و worker | در `docs/local-environment.md` آمده؛ سند استقرار هنوز نیست | پیش‌نیاز استقرار؛ چرخش فقط با برنامه بازسازی ایندکس‌ها (یادداشت‌های ۳ و ۱۱) |
| **`pg_trgm` و `btree_gist`** (و `ltree` از ۰۰۰۲) | مهاجرت‌ها با `CREATE EXTENSION IF NOT EXISTS` می‌سازند؛ روی سرور واقعی شاید نقش `sepehr_owner` اجازه نداشته باشد | پیش‌نیاز استقرار: مدیر پایگاه داده پیش از مهاجرت‌ها بسازد (یادداشت ۲) |
| **سند استقرار** | **وجود ندارد**؛ یادداشت‌های ۱ تا ۱۲ در docs/09 منتظر انتقال به آن‌اند | پیش از نخستین استقرار |

سایر پیش‌نیازهای استقرار در یادداشت‌های فنی docs/09 آمده‌اند: `KAVENEGAR_SENDER`، بازسازی ایندکس جست‌وجو، `TRUST_PROXY`، آینه داخلی ClamAV و `StreamMaxLength`، دسترسی‌های S3، ffmpeg برای ویدئوی self، آینه رجیستری داکر، کلیدهای worker، و `PUBLIC_WEB_ORIGIN`، `WEB_ORIGINS` و `MEDIA_ORIGIN`.

### `TODO(decision)`های باز برای کارفرما

پیش‌فرض اعمال‌شده داخل پرانتز است. ستون «کی» یعنی جواب کارفرما پیش از کدام مرحله لازم است.

**الف. پیش از فاز ۳** (پیش‌فاکتور و پرونده اعتباری؛ این‌ها مستقیم به آن گره خورده‌اند):

| # | پرسش | پیش‌فرض |
|---|---|---|
| ۰۹/۱۲ | «مشتری فعلی» کیست؟ | پرونده `contracted`، `funded` یا `in_treatment`، یا قسط پرداخت‌نشده؛ `isExistingCustomer` |
| ۰۹/۲۰ | سطح «امکان استفاده از اعتبار»: مرکز، پزشک یا خدمت؟ از قرارداد مشتق شود؟ | پرچم روی محل کار، خاموش |
| ۰۹/۲۴ | مرکز موبایل کامل و نام بیمار را ببیند؟ | پوشیده و بی‌نام |
| ۰۰۰۲ | دسترسی نقش‌ها به اطلاعات مالی و درمانی بیمار (مدیر مرکز، پزشک، حسابرس…) | داده نمی‌شود |

**ب. پیش از فاز ۵** (کارمزد و تسویه؛ مالی):

| # | پرسش | پیش‌فرض |
|---|---|---|
| ۰۹/۵ | پنجره انتساب معرفی برای کارمزد خدمت نقدی | **ندارد؛ باید پیش از فاز ۵ پاسخ داده شود** |
| repayment | کارمزد طرح یکجا شناسایی شود یا میان اقساط پخش شود؟ | یکجا هنگام ساخت برنامه (تصمیم تسک ۱-۳) |
| repayment | مبلغ پرداختی ردشده بعداً چه شود (بازپرداخت، تخصیص دوباره)؟ سند ۰۲ ساکت است | در `suspense.unallocated` می‌ماند |
| wallet | شارژ جزئی یا مرحله‌ای کیف اعتبار | ندارد |
| wallet | برگشت تأیید، شارژ یا انصراف روی کیف چه اثری دارد | پشتیبانی نمی‌شود |
| 0003/keys | `repayment.shift_due_to_next_working_day`، تأیید کارفرما (سند ۰۲ §۵) | خاموش |
| config/identity | کاربر تأییدکننده (دونفره، بازنشانی TOTP) باید تازه وارد شده باشد؟ تا چه حد تازه؟ (سند ۰۴ §۶) | اجرا نمی‌شود |

**ج. پیش از راه‌اندازی پایلوت** (عملیاتی؛ همه در پیکربندی و قابل تغییر بدون کد):

| # | پرسش | پیش‌فرض |
|---|---|---|
| ۰۹/۱ | تأیید نوبت، پیش‌فرض خودکار یا دستی | دستی |
| ۰۹/۲ | مدت نگه‌داشت اسلات | ۱۰ دقیقه |
| ۰۹/۳ | زمان یادآوری‌ها | ۲۴ و ۲ ساعت پیش |
| ۰۹/۹ | لغو بیمار تا چه زمانی | ۲ ساعت پیش |
| ۰۹/۱۰ | افق رزرو | ۶۰ روز |
| ۰۹/۱۱ | تغییر حالت تأیید روی نوبت‌های در انتظار | فقط نوبت‌های جدید، با هشدار |
| ۰۹/۱۷ | مهلت تأیید مرکز | ۱۵ دقیقه ساعت دیواری |
| ۰۹/۱۸ | مهلت اعتراض عدم حضور و وزن آن | بی‌مهلت، یک‌بار؛ بدون امتیاز |
| ۰۹/۱۹ | مرز تماس و پیامک خدماتی برای `do_not_contact` | پیامک معاملاتی نوبت می‌رود، تبلیغاتی نه |
| ۰۹/۸ | قواعد نظام پزشکی برای محتوای پروفایل | هیچ انتشاری بدون تأیید کارشناس |
| ۰۹/۲۳ | شهرهای فعال پایلوت | فقط اصفهان |
| 0012 | فیلدهای درمان پایلوت (دست‌کم پنج) | از پنل وارد می‌شوند |
| 0010 | چک‌لیست مدارک هر نوع مرکز | فهرست آغازین مهاجرت ۰۰۱۰ |
| 0002 | شبکه دفتر و VPN برای فهرست مجاز IP | غیرفعال |
| ۲-۱۱/۶ | تقویم زمان‌های آزاد در صفحه پزشک بدون ورود | فقط پس از ورود |
| ۲-۱۱/۱۰ | دعوت کارکنان تازه از پنل | فعلاً CLI |
| ۲-۱۱/۱۱ | مدیر شبکه همه دسته‌های اکسل را ببیند؟ | فقط بارگذارکننده |

**د. بی‌فوریت** (پیش‌فرض محافظه‌کارانه، بدون اثر مالی):

| # | پرسش | پیش‌فرض |
|---|---|---|
| ۰۹/۴ | کد تخفیف ویزیت | ندارد |
| ۰۹/۶ | تعداد بیماران معرفی‌شده روی پروفایل | خاموش |
| ۰۹/۷ | فرمول رتبه پزشک | بیماران تکمیل‌شده در ۹۰ روز، در همان فیلد |
| ۰۹/۱۳ | دوره شمارنده تخصیص درصدی | از اعتبار نسخه فعلی؛ بی‌جبران |
| ۰۹/۱۴ | سرنخِ پرونده باز و قدیمی‌تر از ۷ روز | باز هم «تکراری» روی همان پرونده |
| ۰۹/۱۵ | کپچای داخلی برای فرم وردپرس | honeypot و محدودیت نرخ |
| ۰۹/۱۶ | سرنخ دستیِ مشاور به خودش برسد؟ | طبق درصدها |
| ۰۹/۲۱ | قاعده «پیشنهاد سپهر» در جست‌وجو | خالی، پرچم خاموش |
| ۰۹/۲۲ | میزبانی ویدئو | آپارات |
| contracts | پیشوند حرفی شماره نظام سایر حرفه‌ها («پ»، «ط») | پذیرفته نمی‌شود |
| 0020 | شهرهای بعدی | غیرفعال تا آغاز کار شبکه |

همه این موارد در کد با `TODO(decision)` علامت خورده‌اند (۴۸ مورد در `apps` و `packages`).

---

## ۴. فازهای باقی‌مانده

**سند برنامه‌ای برای فاز ۳ به بعد وجود ندارد.** فقط `07` (فاز ۰ و ۱) و `09` (فاز ۲) نوشته شده‌اند، و نقشه کلی فازها هم در `docs/` نیست. آنچه از اشاره‌های پراکنده پیداست:

| فاز (طبق اشاره اسناد) | محتوا | سند مرجع موجود | ماژول‌های ساخته‌نشده |
|---|---|---|---|
| ۳ | پیش‌فاکتور، پرونده اعتباری (سند ۰۸ §۱) | ۰۳ امتیازدهی (۱۲۴ خط) | `proforma`، `credit` |
| ۴؟ | قرارداد، شارژ کیف، خدمت | ۰۲ (۱۷۰ خط؛ دفتر کل و کیف و اقساط در فاز ۱ ساخته شده‌اند) | `contract`، `service` |
| ۵ | کارمزد خدمت نقدی و تسویه پزشک (سند ۰۸ §۸، سند ۰۶ §۴) | ۰۶ تسویه (۹۷ خط) | `settlement` |
| ؟ | وصول، چک و اسناد تضمین | ندارد | `collection`، `instrument` |
| ۷ | شکایات کامل (سند ۰۸ §۱) | ندارد | `ticket` |
| ؟ | اعلان‌ها و گزارش‌گیری (replica) | ADR-016 و ADR بخش replica | `notification`، `reporting` |
| ۹ یا ۱۰ | استقرار، replica واقعی، کشیک | یادداشت‌های ADR | — |
| «فاز بعد» | اپ موبایل (Expo)، سایت عمومی و جایگزینی وردپرس (ADR-014) | ندارد | `apps/mobile` |

**اندازه نسبی:** از روی اسناد برنامه قابل سنجش نیست، چون سند برنامه‌ای نیست. معیار تقریبی، اندازه اسناد مرجع موجود است:
- فاز ۲ با ۲۳۹ خط مرجع (سند ۰۸) و ۲۸۲ خط برنامه (سند ۰۹)، ۱۲ تسک شد.
- فاز ۳ با سند ۰۳ (۱۲۴ خط) احتمالاً کوچک‌تر است، اما کد مالی دارد و توقف اجباری‌اش بیشتر است.
- فاز ۵ با سند ۰۶ (۹۷ خط) کوچک است، ولی تماماً مالی است.
- وصول و چک (`collection`، `instrument`) سند مرجع ندارند.

**برای شروع فاز ۳ چه باید نوشته شود** (`docs/10-build-plan-phase-3.md`، هم‌شکل docs/09):
1. **نقشه کلی فازها:** شماره هر فاز، محتوا، ترتیب و وابستگی‌ها. بند «فاز ۴؟» بالا را مالک باید روشن کند.
2. **سند مرجع پیش‌فاکتور:** ساختار، اقلام از تعرفه‌های نسخه‌دار، اعتبار زمانی، چرخه وضعیت، ارتباط با نوبت و Referral. این سند، هم‌تراز سند ۰۸، **هنوز وجود ندارد**.
3. **رفع ایرادهای فایل اکسل امتیازدهی** که سند ۰۳ §۷ می‌گوید «پیش از پیاده‌سازی رفع شود».
4. **سند مرجع پرونده اعتباری و چرخه آن:** درخواست، مدارک، امتیاز، ضامن، تصمیم و مرجع تصمیم. ارتباطش با `Case` سند ۰۵ هم روشن شود.
5. **تسک‌ها با معیار پذیرش**، به همراه آزمون‌های طلایی سند ۰۳ §۹.
6. **پاسخ موارد «الف» بخش ۳.**

---

## ۵. فهرست ۵۰ commit محلی (`origin/main..main`)

ستون «مالی» یعنی commit به ledger، wallet، اقساط (repayment) یا settlement دست زده است. این را از مسیر فایل‌ها تشخیص دادم. هیچ commitی به settlement دست نزده، چون آن ماژول هنوز وجود ندارد.

**نکته مهم:** چهار commit فاز ۱ (۱-۱ تا ۱-۴) هم هنوز push نشده‌اند و جزو همین ۵۰ تا هستند. یعنی کل دفتر کل، کیف اعتبار و اقساط هنوز از CI و بازبینی PR نگذشته‌اند.

| # | commit | تاریخ | مالی | پیام |
|---|---|---|---|---|
| 1 | `298b302` | 2026-09-27 | **💰 ledger** | feat(ledger): append-only double-entry ledger skeleton (task 1-1) |
| 2 | `59efa83` | 2026-09-27 | 📄 سند مالی | docs(ledger): correct the event table of doc 02 from the company's side |
| 3 | `fec64d4` | 2026-09-27 | 📄 سند مالی | docs(ledger): make the pending-receipt row a full double entry |
| 4 | `b783e7b` | 2026-09-27 | **💰 wallet** | feat(wallet): credit purse on the ledger (task 1-2) |
| 5 | `86238ce` | 2026-09-27 | **💰 installment + wallet** | feat(repayment): installment schedules and payment allocation (task 1-3) |
| 6 | `0c1668f` | 2026-09-27 | **💰 ledger** | feat(ledger): nightly reconciliation and financial health report (task 1-4) |
| 7 | `07a7836` | 2026-09-27 | — | docs: move the phase 1 changelog entries back under Unreleased |
| 8 | `95d53a5` | 2026-09-28 | — | docs: add phase 2 reference and build plan (docs 08 and 09) |
| 9 | `3c68262` | 2026-09-28 | **💰 installment** | feat(config): holiday calendar and working-day due dates (task 2-1). `repayment.service.ts`: جابه‌جایی تاریخ سررسید، بدون تغییر مبلغ |
| 10 | `7b3c138` | 2026-09-28 | — (شبا رمزشده) | feat(catalog): center registration and activation (task 2-2) |
| 11 | `189dda4` | 2026-09-28 | — | feat(catalog): doctors, secretaries and delegation (task 2-3) |
| 12 | `6d88d6d` | 2026-09-28 | — (تعرفه ریالی، نه دفتر کل) | feat(catalog): treatment fields, services and tariffs (task 2-4) |
| 13 | `d892c9d` | 2026-09-28 | — | feat(catalog): branch managers and the network for private practices set tariffs (task 2-4) |
| 14 | `f0596be` | 2026-09-29 | — | docs(09): add task 2-5b lead module |
| 15 | `c22ce86` | 2026-09-29 | — | feat(booking): doctors' calendars and computed slots (task 2-5) |
| 16 | `cccec3a` | 2026-09-29 | — | test(booking): own-calendar alone reaches no calendar; docs synced (task 2-5) |
| 17 | `098584d` | 2026-09-29 | — | docs(09): notes before real data and deployment (task 2-5) |
| 18 | `ef50612` | 2026-09-29 | **💰 installment (فقط‌خواندنی)** | feat(lead): persons, cases, intake and weighted assignment (task 2-5b). `repayment.service.ts`: تابع خواندنی `casesWithOutstanding` برای «مشتری فعلی» |
| 19 | `9d496ee` | 2026-09-29 | — | docs: local environment guide; BLIND_INDEX_KEY before deployment (task 2-5b) |
| 20 | `39893e2` | 2026-09-29 | — | fix(identity): lead:backfill-persons accepts the -- pnpm passes through (task 2-5b) |
| 21 | `186b455` | 2026-09-29 | — (پرداخت ویزیت در محل، بدون ثبت دفتر کل) | feat(booking): task 2-6 booking module, migration 0016 not applied |
| 22 | `35fa9f6` | 2026-09-30 | — | docs(09): migration 0016 applied locally, full test run green (task 2-6) |
| 23 | `15f9e87` | 2026-09-30 | — | docs(09): list the task 2-6 open decisions; 0016 also needs btree_gist |
| 24 | `d02f153` | 2026-09-30 | — | feat(catalog): public doctor search with an event-fed index (task 2-7), migration 0017 not applied |
| 25 | `14f2c30` | 2026-09-30 | — | docs(09): migration 0017 applied locally; rebuild dry run found nothing to index (task 2-7) |
| 26 | `e8200f0` | 2026-09-30 | — | docs(claude): autonomous continuation procedure and «ادامه قبل را برو» |
| 27 | `9826031` | 2026-09-30 | — | test: 10,000-lead test logs in again after its loop; heavy files run last, one at a time (task 2-7) |
| 28 | `680120e` | 2026-09-30 | — | feat(catalog): doctors' public profiles and media (task 2-8), migration 0018 not applied |
| 29 | `2b7ad9b` | 2026-09-30 | — | docs(09): migration 0018 applied locally (task 2-8) |
| 30 | `17a7aa9` | 2026-09-30 | — | feat(catalog): bulk import of centers and doctors from Excel (task 2-9), migration 0019 not applied |
| 31 | `c727b2b` | 2026-09-30 | — | docs(09): migration 0019 applied locally (task 2-9) |
| 32 | `3bc3ac4` | 2026-09-30 | — | feat(ui): design tokens, self-hosted fonts and a style guide for approval (task 2-10, part 1) |
| 33 | `fffbed1` | 2026-09-30 | — | fix(ui): patient headings in Estedad; summary tiles fit the panel column (task 2-10) |
| 34 | `5640442` | 2026-09-30 | — | feat(ui): the one Jalali calendar and date picker (task 2-10, part 2) |
| 35 | `f927634` | 2026-10-01 | — | fix(ui): only Jalali dates are shown, never Gregorian or Hijri (ADR-011) |
| 36 | `9edee39` | 2026-10-01 | — | feat(lint): dates reach the screen only through the Jalali wrapper; Persian digits in the holiday notice |
| 37 | `60e8332` | 2026-10-01 | — | feat(ui): enterprise date picker — month and year lists, year filter, swapped arrows, sized popup |
| 38 | `e1f4d3d` | 2026-10-01 | — | feat(web,admin): shared foundation for the phase 2 pages (task 2-11, part 1) |
| 39 | `4405a29` | 2026-10-01 | — | fix(ui): date picker arrows — right goes back (>), left forward (<), drawn so bidi cannot mirror them |
| 40 | `0528304` | 2026-10-01 | — (دسترسی) | fix(access): the internal panel's IP limit follows internal roles, never center staff |
| 41 | `ab6eff1` | 2026-10-01 | — | feat(api,api-client): OpenAPI from the NestJS routes; the client generated from it (ADR-032) |
| 42 | `32334ba` | 2026-10-01 | — | feat(web,api): patient pages and the public doctor page (task 2-11, part 2) |
| 43 | `8ad91b7` | 2026-10-01 | — | test(e2e): only Jalali dates on every page, typed dates in any digits; 308 recorded in ADR-029 |
| 44 | `5aa2796` | 2026-10-01 | — | feat(config): the cities table (migration 0020) and GET /config/cities; pages name cities from it |
| 45 | `edf73f6` | 2026-10-01 | — | feat(web,api): the center panel's appointments; the whole e2e path to check-in (task 2-11, part 3) |
| 46 | `70989a8` | 2026-10-01 | — | feat(web,api): the center panel's calendar, services and prices, staff and center pages (task 2-11, part 3) |
| 47 | `75bc99c` | 2026-10-01 | — | fix(config): the pilot city is Isfahan only (migration 0020 corrected before any local run) |
| 48 | `0c201e9` | 2026-10-02 | — | docs(decisions): 0020_cities applied to the local database and checked read-only |
| 49 | `cada3f8` | 2026-10-02 | — | feat(admin,api): the internal panel — center review, profiles, Excel import, holidays (task 2-11, part 4) |
| 50 | `20cf53b` | 2026-10-02 | — | perf(web,contracts): the patient pages' performance budget on a phone (task 2-11, part 5) |

**خلاصه برای بازبینی هنگام دستور گیت:**
- **کد مالی (۶ commit):** `298b302`، `b783e7b`، `86238ce`، `0c1668f` (فاز ۱)، و `3c68262`، `ef50612` (فاز ۲، فقط `repayment.service.ts`).
- **اسناد مالی (۲ commit):** `59efa83` و `fec64d4` (سند ۰۲).
- **پیشنهاد:** کد مالی در PR جدا یا با بازبینی جدا دیده شود.
- **مهاجرت‌ها:** ۰۰۰۹ تا ۰۰۲۰ همه در این commitها هستند و روی پایگاه داده محلی اجرا شده‌اند.
