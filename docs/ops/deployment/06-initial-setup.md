# ۶. راه‌اندازی اولیه و launch-check

[فهرست راهنما](../deployment-guide.md)

## ۶.۱ اولین مدیر سیستم

پیش از این گام، پنل داخلی کسی را ندارد که بتواند حساب بسازد. پس دو حساب اول از خط فرمان سرور ساخته می‌شوند. هر کار دونفره (تنظیمات فنی، پرچم‌های هویت، بازنشانی TOTP) دست‌کم **دو** مدیر سیستم می‌خواهد.

برای هر یک از دو مدیر (**آزمایش‌نشده روی سرور**؛ همان فرمان‌های `apps/api/src/modules/identity/cli/create-account.ts` و `access/cli/grant-role.ts`):

1. رمز موقت را خود مدیر روی سرور در متغیر بگذارد، **نه در خط فرمان** (در فهرست پردازش‌ها دیده می‌شود). مثلاً با `read -s ACCOUNT_PASSWORD` و `export`. رمز دست‌کم ۱۲ نویسه (`identity.staff_login`).
2. ```sh
   ACCOUNT_KIND=staff ACCOUNT_USERNAME=<نام-کاربری> pnpm account:create
   ```
   خروجی: `account created: <شناسه>`. شناسه را یادداشت کنید (راز نیست).
3. ```sh
   ACCOUNT_ID=<شناسه> ROLE_CODE=system_admin GRANT_REASON="مدیر سیستم اول، روز راه‌اندازی" pnpm access:grant
   ```
   خروجی: `role assigned: <شناسه انتساب>`. در سابقه با بازیگر `cli` ثبت می‌شود.
4. `unset ACCOUNT_PASSWORD`.
5. مدیر از **VPN** وارد پنل داخلی می‌شود. در اولین ورود، برنامه احراز هویت (TOTP) را با QR ثبت می‌کند. رمز موقت را همان‌جا عوض می‌کند.

بقیه کارکنان از پنل («نقش‌ها و دسترسی‌ها») نقش می‌گیرند. **کمبود در کد:** ساخت حساب تازه هنوز صفحه پنل ندارد؛ هر حساب با همان `pnpm account:create` روی سرور ساخته می‌شود (`docs/guides/roles/system-admin.md`). قالب فهرست افراد: `docs/ops/staff-accounts-template.md`.

## ۶.۲ تنظیمات دونفره

**قاعده:** هر کدام را یک نفر پیشنهاد می‌دهد و **نفر دیگری** تأیید می‌کند. سامانه یک نفر را برای هر دو امضا رد می‌کند. عددها از `docs/pending-client-decisions.md` و ADRها؛ اینجا فقط برای وارد کردن تکرار شده‌اند.

| # | چه | کلید | مقدار | از کجا |
|---|---|---|---|---|
| ۱ | سقف مانده فعال هر وام‌گیرنده | `credit.borrower_exposure_cap` | `{"capRial": "1500000000", "basis": "obligation", "includeApprovedUnfunded": true}` یعنی ۱٬۵۰۰٬۰۰۰٬۰۰۰ ریال (یک میلیارد و پانصد میلیون ریال) روی آنچه هنوز بدهکار است | پنل: «پرونده‌های اعتباری» ← «طرح‌ها و قواعد» (JSON)؛ ADR-051 |
| ۲ | قاعده چک: کمینه چک وام‌گیرنده | `instrument.borrower_cheque_min_count` | `1` | «تنظیمات راه‌اندازی»؛ ج۵ |
| ۳ | قاعده چک: ضمانت هر ضامن | `instrument.guarantee_cheque_min_bps` | `11000` (۱۱۰٪ مبلغ پیش‌فاکتور) | «تنظیمات راه‌اندازی»؛ ج۵ |
| ۴ | بیعانه تشکیل | `credit.formation_deposit_rial` | `"990000"` (۹۹۰٬۰۰۰ ریال؛ رشته) | «تنظیمات راه‌اندازی»؛ تصمیم مالک ۱۴۰۵/۰۷/۲۹. در پایلوت فقط مشخصات ثبت می‌شود، بی ردیف دفتر کل |
| ۵ | پرچم تعرفه ویزیت فقط از پنل داخلی | `catalog.visit_tariff_internal_only` | `true` یا `false`، به تصمیم مالک | «تنظیمات راه‌اندازی» |
| ۶ | جست‌وجوی عمومی | `catalog.search_enabled` | `false` در پایلوت (پاسخ مالک ۱۴۰۵/۰۸/۰۱) | پیش‌فرض خاموش است؛ کاری لازم نیست |
| ۷ | سه پرچم هویت | `identity.reauth`، `identity.factor_change_sms`، `identity.staff_mobile_required` | روشن | پنل: «تنظیمات هویت، سرنخ، نوبت و پیامک» (`/settings`) |
| ۸ | طرح‌های وام، کارمزد تشکیل، بخشودگی، تخفیف کارشناس، طرح فقط دستمزد | `credit.plans` و کاتالوگ | `docs/ops/pre-launch-checklist.md` §۲ | پنل: «طرح‌ها و قواعد» |

**هشدار درباره پرچم ۷ (`identity.staff_mobile_required`):** پس از روشن شدن، کارمندی که موبایل تأییدشده ندارد **وارد نمی‌شود** (`mobile_required`). اول همه کارکنان موبایلشان را در «حساب من» تأیید کنند، بعد پرچم روشن شود. در آزمون‌های خودکار همین ترتیب اشتباه چند آزمون را پشت‌سرهم قرمز کرد.

**از ۱۴۰۵/۰۸/۰۲:** ۱ تا ۶ در صفحه «تنظیمات راه‌اندازی» (`/launch-settings`) با فیلد ساده (ریال، تعداد، درصد، روشن یا خاموش)؛ پیشنهاد یک نفر و تأیید نفر دیگر در همان صفحه. روش API پایین فقط برای کلیدهایی است که هنوز صفحه ندارند (مثلاً `identity.patient_mobile_change`).

### روش API برای کلیدهای بی صفحه

**سازوکار آزمایش‌شده** است: `apps/e2e/tests/admin.spec.ts` بیعانه را دقیقاً همین‌طور دونفره تنظیم می‌کند. **روش دستی زیر آزمایش‌نشده** است.

1. **نفر اول** (مدیر استراتژی برای کلیدهای کسب‌وکار، با `config.manage_business`؛ مدیر سیستم برای کلیدهای فنی) از VPN وارد پنل داخلی می‌شود.
2. در همان زبانه، کنسول مرورگر (F12):
   ```js
   const me = await (await fetch('/api/v1/auth/me')).json();
   const r = await fetch('/api/v1/config/proposals', {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
     body: JSON.stringify({
       key: 'instrument.borrower_cheque_min_count',
       scope: { level: 'global' },
       value: 1,
       reason: 'قاعده چک طبق الحاقیه مهر ۱۴۰۵',
     }),
   });
   console.log(r.status, (await r.json()).id);
   ```
   `201` یعنی پیشنهاد ثبت شد. شناسه را به نفر دوم بدهید. اگر پرچم بازاحراز روشن است، ممکن است کد شش‌رقمی بخواهد؛ آن را در پنل وارد کنید و دوباره بفرستید.
3. **نفر دوم** در مرورگر و حساب خودش:
   ```js
   const me = await (await fetch('/api/v1/auth/me')).json();
   const r = await fetch('/api/v1/config/proposals/<شناسه>/approve', {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
     body: '{}',
   });
   console.log(r.status);
   ```
4. پس از تأیید، `pnpm ops:launch-check` بند مربوط باید PASS شود.

## ۶.۳ نقش‌ها و افراد روز راه‌اندازی

| نیاز | حداقل | launch-check |
|---|---|---|
| دارندگان «تأیید شماره بیمار» (`lead.approve_person_mobile`) | ۲، بهتر ۳ | بند ۵ |
| دارندگان «تغییر شماره بیمار» (`identity.change_patient_mobile`) | ۲ تا ۳، نه مشاور یا پشتیبانی | بند ۱۳ |
| تعطیلات: مدیرعامل (`config.manage_holidays`، پیشنهاد و تأیید) و **قائم‌مقام مدیرعامل (فقط تعطیلات)** با `config.approve_holidays` (فقط تأیید). مدیر سیستم از مهاجرت 0105 این مجوز را ندارد. نقش قائم‌مقام (`holiday_deputy`) را مهاجرت 0105 ساخته است؛ مدیر سیستم روز راه‌اندازی آن را در «نقش‌ها و دسترسی‌ها» به یک نفر می‌دهد. | یک پیشنهاددهنده و دو نفر جدا برای تصمیم | بند ۱۰ |
| بازبین تفکیک دستمزد و مواد (`credit.review_cost_split`) | ۲ (کارشناس اعتبار یا تکمیل پرونده)؛ صادرکننده پیش‌فاکتور بازبین همان پیش‌فاکتور نیست | بند ۱۹ |
| خروج کارمند | یک درخواست‌دهنده و یک تأییدکننده، دو نفر جدا | بند ۸ |
| نوبت‌کار عملیات و جانشین | ۲ | go/no-go بند ۱۳ |

دو نقش اول سفارشی‌اند و مدیر سیستم در «نقش‌ها و دسترسی‌ها» می‌سازد (`docs/guides/roles/patient-mobile-approver.md` و `patient-mobile-changer.md`).

## ۶.۴ داده پایه

`docs/ops/base-data-checklist.md` (تسک ۱۰-۶): ساختار، مراکز پایلوت، پزشکان، کاتالوگ، تعرفه‌ها، مدت قرارداد مراکز و پزشکان، تعطیلات، قالب‌های پیامک. اول روی staging، سپس production. هر مرکز و محل کار باید مدت قرارداد تأییدشده داشته باشد (بند ۱۵).

## ۶.۵ `pnpm ops:launch-check`

**آزمایش‌شده** (۱۴۰۵/۰۸/۰۲) روی پایگاه تازه محلی. فقط می‌خواند؛ چیزی را عوض نمی‌کند. با `DATABASE_URL`، و برای بند ۵ با `MIGRATION_DATABASE_URL`.

**شرط go: هیچ FAIL.** هر WARN یا بسته شود، یا مالک آگاهانه بپذیرد.

| بند | کد | PASS یعنی | WARN یعنی | FAIL یعنی | کار |
|---|---|---|---|---|---|
| ۱ | `app_role` | `sepehr_app` superuser نیست، RLS را دور نمی‌زند، مالک جدولی نیست | — | برنامه با نقش اشتباه وصل است | `DATABASE_URL` را درست کنید ([فصل ۳](03-database.md)) |
| ۲ | `identity.reauth`، `identity.factor_change_sms`، `identity.staff_mobile_required` | روشن | — | خاموش | دونفره از `/settings` (هشدار بالا درباره موبایل) |
| ۴ | `blind_index_keys` | همه ستون‌ها زیر یک کلید | ستون‌هایی با کلید قبلی | — | بازسازی نمایه پس از چرخش (`security:reencrypt`) |
| ۵ | `lead.approve_person_mobile` | ۳ دارنده یا بیشتر | ۲ دارنده | کمتر از ۲ | نقش سفارشی و دارندگان |
| ۵ | `migrations` | همه مهاجرت‌های نسخه اجرا شده | `MIGRATION_DATABASE_URL` داده نشده | کمتر اجرا شده | `pnpm db:migrate` با آیین کامل |
| ۶ | `ops.queue_alert_thresholds` | — | **همیشه WARN** تا مسیر هشدار `queue_failed` در Grafana به یک نفر نام‌دار وصل شود | — | وصل در Grafana و پذیرش آگاهانه |
| ۸ | `identity.staff_offboarding` | دو نفر جدا برای درخواست و تأیید خروج | کمتر | — | نقش‌ها |
| ۱۰ | `config.manage_holidays` | دست‌کم ۱ نفر که پیشنهاد می‌دهد و ۲ نفر جدا که تصمیم می‌گیرند (مدیرعامل و قائم‌مقام) | — | کمتر | نقش مدیرعامل و نقش قائم‌مقام |
| ۱۳ | `identity.change_patient_mobile` | ۲ تا ۳ دارنده که مشاور یا پشتیبانی نیستند | تعداد یا ترکیب نادرست، یا پرچم خاموش | — | نقش سفارشی؛ پرچم در پایلوت خاموش است، پس WARN آگاهانه |
| ۱۴ | `legal_texts` | متن قرارداد و رضایت تأیید حقوقی دارد | «before the first real contract»: هنوز نمونه یا پیش‌نویس (تصمیم مالک ۱۴۰۵/۰۸/۰۲: پس از راه‌اندازی، پیش از اولین قرارداد واقعی) | — | `docs/ops/launch-day-settings.md` |
| ۱۵ | `settlement.provider_contract` | هر مرکز و محل کار فعال مدت قرارداد تأییدشده دارد | — | بعضی ندارند | داده واقعی مراکز |
| ۱۶ | `clock_skew` | ساعت برنامه و پایگاه حداکثر ۱ ثانیه فرق دارند | — | بیشتر | NTP هر دو سرور |
| ۱۷ | `instrument.borrower_cheque_min_count`، `instrument.guarantee_cheque_min_bps` | بیش از ۰ | ۰ (خاموش) | — | ۱ و ۱۱۰۰۰ دونفره |
| ۱۹ | `credit.review_cost_split` | ۲ دارنده یا بیشتر | کمتر | — | نقش‌ها |
| ۲۰ | `credit.borrower_exposure_cap` | روشن | ۰ (خاموش) | — | ۱٬۵۰۰٬۰۰۰٬۰۰۰ دونفره |
| ۲۱ | `pentest_risk_accepted` | — | **همیشه WARN**: ریسک پذیرفته‌شده مالک (۱۴۰۵/۰۸/۰۲)، با جبران‌ها | — | پاک نمی‌شود |
| ۲۲ | `scoring_rules` | — | **همیشه WARN**: پیش از اولین تصمیم اعتباری واقعی | — | `launch-day-settings.md` |
| ۲۳ | `lunar_holidays` | — | **همیشه WARN**: تا ۱ بهمن ۱۴۰۵ | — | `launch-day-settings.md` |
| ۲۴ | `financial_step_up_sms` | — | **همیشه WARN**: کد پیامکی به‌جای TOTP، ریسک SIM swap پذیرفته‌شده مالک | — | TOTP پس از پایلوت |
| ۲۵ | `sms_provider` | `SMS_PROVIDER=kavenegar` | `fake` روی staging | `fake` یا هر مقدار دیگر بیرون از staging | با فایل محیط worker اجرا کنید؛ `SMS_PROVIDER=kavenegar` |

**نتیجه امروز روی پایگاه تازه** (پیش از هر تنظیم): PASS بندهای ۱، ۴، ۵ (مهاجرت‌ها ۱۰۵ از ۱۰۵)، ۱۵ (هنوز مرکزی نیست) و ۱۶. FAIL بندهای ۲، ۵ (دارندگان)، ۱۰ و ۱۴. بقیه WARN. یعنی سامانه تازه‌نصب **عمداً** آماده راه‌اندازی نیست تا افراد و تنظیمات وارد شوند.
