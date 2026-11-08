# طرح: جدا کردن «پیشنهاد» و «تأیید» تنظیمات فنی (نقش باریک)

ثبت ۱۴۰۵/۰۸/۰۳ (۲۰۲۶-۱۰-۲۵). **فقط طرح؛ هیچ کدی نوشته نشده. منتظر تأیید مالک.** غیرمالی است: به دفتر کل، کیف، اقساط یا تسویه دست نمی‌زند.

## وضع امروز

- هر کلید پیکربندی یک دسته دارد: `business` یا `technical`. از ۱۰۴ کلید، ۲۸ کلید فنی‌اند. از جمله:
  - همه کلیدهای هویت: `identity.reauth`، `identity.factor_change_sms`، `identity.staff_mobile_required`، `identity.financial_step_up`، `identity.otp`، `identity.session` و بقیه؛
  - `access.internal_panel_ip_allowlist`، `audit.*`، `ops.*`، `wallet.credit_transfer_enabled` و چند کلید کاتالوگ و سرنخ.
- یک مجوز برای هر دسته: `config.manage_technical` هم برای پیشنهاد و هم برای تأیید (`config.service.ts`، `MANAGE_PERMISSION`). امروز فقط نقش `system_admin` آن را دارد.
- قاعده دونفره دو لایه است:
  - **سرویس:** تأییدکننده همان پیشنهاددهنده نیست (`second_person_required`)؛
  - **پایگاه:** trigger `config_values_guard`: «a sensitive configuration change needs a second person».
- **شکاف:** دونفره بودن بین دو **نفر** است، نه دو **نقش**. دو مدیر سیستم می‌توانند یکدیگر را تأیید کنند. برای پایلوت این پذیرفته است (دو `system_admin` متمایز، هیچ‌کدام مالک).

## پیشنهاد

1. **دو مجوز تازه:**
   - `config.propose_technical`: پیشنهاد تغییر کلید فنی؛
   - `config.approve_technical`: تأیید یا رد پیشنهاد کلید فنی.
2. **نقش تازه `technical_config_approver`** («تأییدکننده تنظیمات فنی»): فقط `config.approve_technical`. **به هیچ‌کس داده نمی‌شود**؛ مالک از پنل «نقش‌ها» می‌دهد.
3. **grantها:**
   - `system_admin`: `config.propose_technical`. تأیید نمی‌کند.
   - `technical_config_approver`: `config.approve_technical`. پیشنهاد نمی‌دهد.
   - هیچ نقشی هر دو را ندارد (آزمون).
4. **سرویس:**
   - پیشنهاد کلید فنی با `config.propose_technical` یا `config.manage_technical`؛
   - تأیید کلید فنی با `config.approve_technical` یا `config.manage_technical`.
   - گام انتقالی (expand/contract): `config.manage_technical` تا پایان انتقال کار می‌کند، پس هیچ مسیر امروز نمی‌شکند. قاعده «نفر دوم» سرویس و trigger پایگاه بی‌تغییر می‌مانند.
5. **گام دوم، جدا و با تأیید دوباره مالک:** برداشتن `config.manage_technical` از `system_admin`. این حذف منطقی (`deleted_at`) یک grant است، پس طبق CLAUDE.md بند ۴ پرسیده می‌شود. فقط وقتی انجام می‌شود که دست‌کم یک `technical_config_approver` دارنده دارد. پس از آن، مدیر سیستم دیگر تنظیم فنی را تأیید نمی‌کند.
6. **اثر روی کلیدهای هویت:** روشن کردن سه پرچم هویت (`launch-check` بند ۲) و `identity.financial_step_up` (بند ۲۹) را مدیر سیستم پیشنهاد می‌دهد و «تأییدکننده تنظیمات فنی» تأیید می‌کند. دو نقش جدا، نه دو مدیر سیستم.
7. **پنل:**
   - صفحه‌های «تنظیمات هویت…» و «تنظیمات راه‌اندازی» دکمه «پیشنهاد» را به دارنده پیشنهاد نشان می‌دهند و «تأیید» و «رد» را به دارنده تأیید.
   - فهرست ناوبری هر دو مجوز را می‌شناسد.
8. **`launch-check`:** یک بند تازه.
   - WARN تا وقتی نقش `technical_config_approver` دارنده ندارد؛
   - WARN اگر دارنده آن `system_admin` هم باشد؛
   - پس از گام ۵، WARN اگر `system_admin` هنوز `config.manage_technical` دارد.

## مهاجرت (فقط‌افزودنی، 0107)

خلاصه SQL، پیش از اجرا دوباره با آیین کامل:

- `INSERT INTO permissions`: `config.propose_technical` و `config.approve_technical`. `ON CONFLICT DO NOTHING`.
- `INSERT INTO roles`: `technical_config_approver`، `is_system = true`.
- `INSERT INTO role_permissions`:
  - `system_admin` → `config.propose_technical`؛
  - `technical_config_approver` → `config.approve_technical`.
- هیچ ALTER، UPDATE، DELETE یا DROP ندارد. trigger `config_values_guard` و بقیه triggerها دست نمی‌خورند. grant `config.manage_technical` در این مهاجرت می‌ماند.

## آزمون‌ها

- **سرویس، مستقیم و از API:**
  - دارنده فقط «پیشنهاد» تأیید نمی‌کند (`permission_required`)؛
  - دارنده فقط «تأیید» پیشنهاد نمی‌دهد؛
  - یک نفر با هر دو نقش هنوز تأیید خودش را نمی‌زند (سرویس و trigger)؛
  - کلید کسب‌وکار بی‌تغییر با `config.manage_business`.
- **انتقال:** دارنده `config.manage_technical` هنوز هر دو کار را می‌کند (آزمون‌های امروز سبز می‌مانند).
- **نقش‌ها:** هیچ نقشی هر دو مجوز تازه را ندارد؛ `technical_config_approver` فقط یک مجوز دارد.
- **`launch-check`:** بند تازه در سه حالت (بی دارنده، دارنده‌ای که مدیر سیستم هم هست، درست).
- **پنل:** آزمون واحد کلیدهای تنظیمات برای هر دو مجوز؛ e2e روشن کردن یک پرچم هویت با دو نقش.
- **جهش‌ها:** برداشتن هر بررسی مجوز تازه، و برداشتن قاعده نفر دوم، دست‌کم یک آزمون را قرمز کند.

## اندازه کار

**یک دور:** مهاجرت و آیین آن، سرویس، پنل، `launch-check`، آزمون‌ها، HEAVY و e2e. گام ۵ دوری کوتاه و جدا است، فقط پس از تأیید مالک و پس از داشتن دارنده.

## پیشنهاد زمان

پس از پایلوت. برای پایلوت قاعده امروز کافی است: دو `system_admin` متمایز، هیچ‌کدام دارنده `mobile_change_approver`.

## ساخت (تصمیم مالک ۱۴۰۵/۰۸/۰۳: پیش از پایلوت) و خلاصه SQL 0107

**ساخته شد، commit محلی؛ `db:migrate` روی پایگاه اصلی منتظر تأیید مالک.**

> **به‌روز ۱۴۰۵/۰۸/۰۶ (۲۰۲۶-۱۰-۲۸):** مالک «تأیید است» گفت. بررسی نشان داد 0107 **از پیش روی پایگاه اصلی اعمال شده بود**: نقش `technical_config_approver` در ۲۰۲۶-۱۰-۲۵ ساعت ۱۲:۰۸ UTC، دو دقیقه پس از commit `33375ab`، ساخته شده بود و در RESUME و این فایل ثبت نشده بود (اشتباه دور پیش). پشتیبان تازه: `D:\sepehr_app\db-backups\sepehr-before-0107-main-20261028-060207.dump` (۲۹۵۲ سطر TOC). بررسی فقط‌خواندنی روی اصلی: ۱۰۸ مهاجرت؛ `system_admin` → `config.manage_technical` و `config.propose_technical`؛ `technical_config_approver` → `config.approve_technical`؛ نقشی با هر دو مجوز ۰؛ دارنده تأییدکننده ۰؛ دفتر کل ۴۱ ردیف، سند نامتوازن ۰؛ drift «in sync». همه برابر تمرین.

- **کد:**
  - `config.service.ts`: `assertMayManage` حالا مرحله را می‌داند. کلید فنی با `config.manage_technical` یا مجوز باریک همان مرحله؛ کلید کسب‌وکار بی‌تغییر.
  - صفحه‌های «تنظیمات…» و «تنظیمات راه‌اندازی»: دکمه پیشنهاد و دکمه تصمیم جدا.
  - ناوبری هر دو مجوز را می‌شناسد.
  - `launch-check` بند ۳۱.
- **آزمون‌ها:**
  - `test/config/technical-split.int.test.ts`: ۵ آزمون. نقش‌ها؛ پیشنهاد و تصمیم جدا؛ یک نفر با هر دو نقش در سرویس و پایگاه رد؛ کلید کسب‌وکار رد؛ دو مدیر سیستم در دوره انتقال.
  - `launch-check` بند ۳۱.
  - ۴ از ۴ جهش قرمز.

**خلاصه SQL 0107 (فقط‌افزودنی؛ بی ALTER، UPDATE، DELETE یا DROP؛ هیچ trigger یا grant موجودی عوض نمی‌شود):**

1. `INSERT INTO permissions`: `config.propose_technical`، `config.approve_technical`.
2. `INSERT INTO roles`: `technical_config_approver` («تأییدکننده تنظیمات فنی»)، `is_system`، بی دارنده.
3. `INSERT INTO role_permissions`: `system_admin` → `config.propose_technical`؛ `technical_config_approver` → `config.approve_technical`.
4. `config.manage_technical` نزد `system_admin` می‌ماند. برداشتنش مرحله جدا و با تأیید مالک است.

**آیین:**

| گام | نتیجه |
|---|---|
| dump تازه | `D:\sepehr_app\db-backups\sepehr-before-0107-20261025-112708.dump` (`pg_restore --list` بی‌خطا) |
| کپی `sepehr_rehearsal_0107` | `migrations applied`؛ ۱۰۷ → ۱۰۸ |
| checksum پیش و پس روی کپی | همه برابر جز شمار مهاجرت‌ها (دفتر کل، پرونده‌ها، نقش‌ها و grantهای قبلی، پیکربندی، triggerها، توابع، قیدها) |
| نقشی با هر دو مجوز تازه | ۰ |
| دارنده `technical_config_approver` | ۰ |
| `config.manage_technical` | فقط `system_admin`، بی‌تغییر |
| `sepehr_app` | بی DELETE یا TRUNCATE |
| drift | «Schema and migrations are in sync» |
| هم‌سانی با پایگاه از صفر (`sepehr_rehearsal_0107_scratch`) | grantها و نقش برابر؛ فقط تفاوت پذیرفته پارتیشن‌های `2026_09` |

دو تفاوت پیش از مهاجرت میان اصلی و کپی تازه هر دو از ابزار سنجش بود، نه از داده:
- پرانتز چهار قید CHECK پس از dump و restore؛
- ترتیب نامعین توابع هم‌نام در checksum. مقایسه نام و متن هر ۳۸۵ تابع برابر بود.
