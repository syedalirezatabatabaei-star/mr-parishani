# ۹. عیب‌یابی

[فهرست راهنما](../deployment-guide.md)

هر پیام زیر از کد یا اجرای آزمایشی خوانده شده است. پیش از هر کار، `pnpm ops:launch-check` (فقط خواندنی) و لاگ api و worker را ببینید.

| نشانه یا پیام | علت | کار |
|---|---|---|
| `Database role passwords must be at least 16 characters` | یکی از رمزهای `db:bootstrap` کوتاه است | رمز دست‌کم ۱۶ نویسه |
| `db:bootstrap` با «permission denied» یا «must be superuser» | `DB_ADMIN_URL` superuser نیست | با نقش superuser پایگاه |
| `db:migrate` با «permission denied for schema public» | `db:bootstrap` اجرا نشده، یا `MIGRATION_DATABASE_URL` با نقشی جز `sepehr_owner` است | اول `pnpm db:bootstrap`؛ نشانی را بسنجید |
| `launch-check` بند ۵ `migrations`: WARN «this role cannot read the applied list» | `MIGRATION_DATABASE_URL` داده نشده | با آن دوباره اجرا کنید |
| `launch-check` بند ۵ `migrations`: FAIL «N applied of M» | مهاجرت‌های نسخه تازه اجرا نشده‌اند | آیین مهاجرت و `pnpm db:migrate` |
| `launch-check` بند ۱: FAIL | برنامه با superuser یا `sepehr_owner` وصل است | `DATABASE_URL` با `sepehr_app` |
| `launch-check` بند ۱۶ `clock_skew`: FAIL | ساعت سرور برنامه و پایگاه بیش از ۱ ثانیه فرق دارد | NTP هر دو؛ `timedatectl` |
| api شروع نمی‌شود: `AUTH_SECRET is not set` (یا `FIELD_ENCRYPTION_KEY`، `BLIND_INDEX_KEY`) | راز تزریق نشده | جای امن رازها و فایل محیطی سرویس |
| api در production شروع نمی‌شود و از `REPORTING_DATABASE_URL` می‌گوید | در production الزامی است | نشانی replica با `sepehr_report` |
| api با پیام نیمه‌کامل بودن S3 شروع نمی‌شود | بعضی `S3_*` هست، بعضی نه | همه یا هیچ |
| `STAGING_FIXED_LOGIN_CODE is allowed only with DEPLOY_ENV=staging` | کد ثابت روی production مانده | آن را از محیط production بردارید |
| `BACKUP_AGE_RECIPIENT is required in production` | پشتیبان منطقی بی کلید عمومی | کلید عمومی `age` |
| بارگذاری فایل ۵۰۳ `scanner_unavailable` | ClamAV بالا نیست یا `CLAMAV_HOST` خالی | سرویس ClamAV؛ پس از شروع حدود یک دقیقه برای بار امضاها |
| بارگذاری فایل ۵۰۳ `storage_unavailable` | `S3_*` خالی | پیکربندی ذخیره‌ساز |
| پنل داخلی برای همه «دسترسی ندارید» یا بسته | `INTERNAL_PANEL_CIDRS` خالی یا بازه اشتباه؛ یا `TRUST_PROXY` خالی و همه درخواست‌ها IP پراکسی را دارند | بازه VPN؛ `TRUST_PROXY=loopback`؛ راه‌اندازی دوباره api |
| همه کاربران با «تلاش زیاد» رد می‌شوند | `TRUST_PROXY` خالی؛ همه یک IP دارند و محدودیت نرخ با هم پر می‌شود | `TRUST_PROXY` |
| درخواست‌های پنل با خطای CSRF یا origin رد می‌شوند | `WEB_ORIGINS` نشانی واقعی دامنه‌ها را ندارد (مثلاً `http` به‌جای `https`) | `WEB_ORIGINS` |
| کارمند وارد نمی‌شود: `mobile_required` | پرچم `identity.staff_mobile_required` روشن است و او موبایل تأییدشده ندارد | موبایل را در «حساب من» تأیید کند؛ اگر نمی‌تواند وارد شود، پرچم دونفره موقتاً خاموش |
| مدیر سیستم در «تعطیلات» درخواست نمی‌دهد یا ۴۰۳ می‌گیرد | **رفتار درست** از 0105: تعطیلات فقط با مدیرعامل است (تصمیم مالک ۱۴۰۵/۰۸/۰۲) | مدیرعامل پیشنهاد می‌دهد؛ قائم‌مقام فقط تعطیلات یا دارنده دیگر تأیید می‌کند |
| کد ورود بیمار نمی‌رسد | `SMS_PROVIDER=fake` در production؛ یا `KAVENEGAR_API_KEY` یا الگو اشتباه؛ یا سقف ارسال ساعتی (۸ در ساعت) | محیط؛ پنل کاوه‌نگار؛ `docs/runbooks/kavenegar-outage.md` |
| پیامک نوبت و یادآوری نمی‌رود ولی کد ورود می‌رود | `KAVENEGAR_SENDER` خالی | خط فرستنده |
| پیامک‌ها و کارهای شبانه انجام نمی‌شوند | worker خاموش است | سرویس worker؛ کارهای روزانه در اجرای بعد جبران می‌شوند |
| `pnpm ops:partitions` با `Nest can't resolve dependencies of the HolidayService … OUTBOX` | نسخه پیش از `63be36f` | نسخه تازه را بسازید؛ تا آن زمان worker کار روزانه ۰۳:۰۰ UTC را انجام می‌دهد |
| `permission denied` روی `DELETE` یا `TRUNCATE` | **رفتار درست**؛ برنامه این اجازه را ندارد | هیچ؛ اصلاح فقط با سند معکوس و از مسیر برنامه |
| تطبیق شبانه مغایرت دارد | — | `docs/runbooks/ledger-mismatch.md`؛ **هرگز اصلاح دستی** |
| صف‌ها رشد می‌کنند | worker کند یا گیر کرده؛ Redis پر | Grafana؛ لاگ worker؛ حافظه Redis |
| پس از از دست رفتن Redis، رویدادها پردازش نشده‌اند | کارهای منتشرشده در Redis بودند | `pnpm ops:outbox-requeue --since <ISO> --dry-run`، سپس بی آن |
| `pnpm install` در اینترنت ملی شکست می‌خورد | mirror npm نیست یا `.npmrc` به آن اشاره ندارد | Verdaccio داخلی |
| صفحه جست‌وجو «جست‌وجو هنوز فعال نشده است» | **رفتار درست در پایلوت**؛ `catalog.search_enabled` خاموش | هیچ |
| پس از روشن کردن جست‌وجو، نتیجه‌ای نیست | نمایه ساخته نشده | `pnpm catalog:rebuild-search` (خشک)، سپس با `-- --apply`، با تأیید |
| PDF قرارداد ساخته نمی‌شود | Chromium نیست یا `PDF_BROWSER_PATH` اشتباه | ایمیج worker Chromium دارد (`/usr/bin/chromium-browser`)؛ روی میزبان بی ایمیج، بسته Chromium نصب و `PDF_BROWSER_PATH` تنظیم شود |
| گواهی منقضی | تمدید نشده | تمدید؛ هشدار ۶۰ روز پیش باید زودتر آمده باشد: مسیر هشدار را بسنجید |
| ClamAV پس از مدتی همه را تمیز می‌داند ولی امضاها کهنه‌اند | mirror `freshclam` نیست | mirror داخلی امضاها |
