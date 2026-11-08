# ۳. پایگاه داده

[فهرست راهنما](../deployment-guide.md)

## ۳.۱ نصب Postgres 17

**تصمیم مالک ۱۴۰۵/۰۸/۰۴:** در staging و production، PostgreSQL **مستقیم از بسته‌های سیستم‌عامل** نصب می‌شود، نه کانتینر.

- **نسخه: ۱۷**، همان خطی که آزمون‌ها با آن سبزند (`postgres:17-alpine`، 17.11). نسخه آزموده عوض نمی‌شود.
- **Ubuntu 26.04 (resolute) فقط PostgreSQL 18 دارد** (بسته `postgresql-18` 18.6). این روی یک ظرف Ubuntu 26.04 در ماشین توسعه دیده شد، ۱۴۰۵/۰۸/۰۴، نه روی سرور. پس `postgresql` بی شماره یا `postgresql-18` نصب **نشود**.
- **منبع ۱۷: مخزن رسمی PostgreSQL (PGDG)**، `resolute-pgdg`، که `postgresql-17` 17.11 دارد (همان روز دیده شد).
  - بهتر از **mirror داخلی PGDG** خوانده شود، تا نصب و به‌روزرسانی در اینترنت ملی هم کار کند.
  - تا mirror آماده نیست، **نصب یک‌باره از `apt.postgresql.org` با VPN**. بلافاصله پس از آن، فایل مخزن PGDG روی سرور **غیرفعال** می‌شود (`pgdg.list.disabled`)، تا سرور در کار روزانه به مخزن خارجی سر نزند. با آماده شدن mirror داخلی، مخزن به نشانی mirror برمی‌گردد.
  - برنامه در زمان اجرا به آن وابسته نیست.
- **مصوب مالک ۱۴۰۵/۰۸/۰۴:** ۱۷ از PGDG، نصب مستقیم، pgBackRest از همان منبع، `apt-mark hold`، بی `postgresql` و `postgresql-18`.
- **قفل نسخه:** پس از نصب `apt-mark hold postgresql-17 postgresql-client-17`، تا `apt upgrade` خط اصلی را عوض نکند. به‌روزرسانی جزئی ۱۷ (17.x) فقط با آزمون روی staging.
- **pgBackRest** هم از همان PGDG، هم‌خوان با ۱۷ ([فصل ۷](07-backup-restore.md)).
- **چیدمان دیسک** (staging، تأیید مالک ۱۴۰۵/۰۸/۰۴):
  - `/var/lib/postgresql`: حجم منطقی ۶۰ گیگابایت، داده Postgres (`/var/lib/postgresql/17/main`)؛
  - `/var/lib/docker`: ۵۰ گیگابایت، ایمیج‌ها و داده Redis، ذخیره‌ساز و ClamAV؛
  - `/backup`: **دیسک جدا** ۱۰۰ گیگابایت، مخزن pgBackRest (`repo1`) و dump شبانه `age`.
- گام‌به‌گام برای staging: [`docs/ops/staging-install-sheet.md`](../staging-install-sheet.md).
- فقط روی `127.0.0.1` یا شبکه خصوصی گوش دهد (`listen_addresses`). هرگز روی آی‌پی عمومی.
- `pg_hba.conf`: فقط `scram-sha-256`، فقط از میزبان برنامه و replica.
- پارامترهای پشتیبان پیوسته و replica در [فصل ۷](07-backup-restore.md#۷۲-postgres-پشتیبان-پیوسته).

**replica جریانی** (برای گزارش‌ها و جانشینی): `REPORTING_DATABASE_URL` در production الزامی است. بی آن، برنامه در `NODE_ENV=production` شروع نمی‌شود (`docs/local-environment.md`). **تصمیم مالک ۱۴۰۵/۰۸/۰۲:** replica و staging روی سرور دوم، با VM یا شبکه و دیواره آتش جدا، بی رمز مشترک ([فصل ۱۰](10-appendix.md#۱۰۳-تصمیم-مالک-۱۴۰۵۰۸۰۲)).

## ۳.۲ نقش‌های پایگاه

`pnpm db:bootstrap` سه نقش می‌سازد (`apps/api/src/db/bootstrap.ts`):

| نقش | کار | کجا وصل می‌شود |
|---|---|---|
| `sepehr_owner` | مالک schema؛ **فقط** مهاجرت | `MIGRATION_DATABASE_URL`؛ فقط هنگام `pnpm db:migrate` |
| `sepehr_app` | خود برنامه (api، worker، فرمان‌های عملیاتی) | `DATABASE_URL` |
| `sepehr_report` | فقط خواندن، برای گزارش و تطبیق | `REPORTING_DATABASE_URL`، روی replica |

- هر سه `LOGIN NOINHERIT NOCREATEDB NOCREATEROLE`.
- رمز هر کدام **دست‌کم ۱۶ نویسه**؛ کوتاه‌تر رد می‌شود.
- `REVOKE ALL ON DATABASE … FROM PUBLIC`: هیچ کس دیگری وصل نمی‌شود.
- **هیچ سرویسی با superuser وصل نمی‌شود.** `ops:launch-check` بند ۱ این را می‌سنجد.
- superuser (نقش `postgres` یا نقشی که هنگام نصب ساختید) فقط برای `db:bootstrap` و کارهای مدیریتی دستی.

## ۳.۳ ترتیب `db:bootstrap` و `db:migrate`

**آزمایش‌شده** (۱۴۰۵/۰۸/۰۲، روی Postgres 17 دورریختنی محلی، با رمزهای تصادفی چاپ‌نشده):

| گام | فرمان | متغیرهای لازم | خروجی درست |
|---|---|---|---|
| ۱ | `pnpm db:bootstrap` | `DB_ADMIN_URL` (superuser)، `DB_OWNER_PASSWORD`، `DB_APP_PASSWORD`، `DB_REPORT_PASSWORD` | `database roles ready` |
| ۲ | `pnpm db:migrate` | `MIGRATION_DATABASE_URL` (با `sepehr_owner`) | `migrations applied` |
| ۳ | `pnpm ops:launch-check` | `DATABASE_URL`، `MIGRATION_DATABASE_URL`، `REPORTING_DATABASE_URL` | بند ۵ `migrations: 108 applied of 108`؛ بند ۱ PASS |

نکته‌ها:

1. هر دو فرمان پیش از اجرا خود api را می‌سازند (`turbo run build`). پس روی سرور، مخزن با `pnpm install --frozen-lockfile` آماده باشد.
2. `db:bootstrap` تکرارپذیر است. اجرای دوباره با رمزهای تازه، رمزها را **عوض** می‌کند (روش چرخش رمز نقش‌ها؛ [فصل ۴](04-secrets.md)).
3. فرمان‌ها `.env` ریشه مخزن را اگر باشد می‌خوانند (`--env-file-if-exists`). متغیری که در محیط فرمان است بر `.env` مقدم است. روی سرور، `.env` در مخزن **نباشد**؛ متغیرها از جای امن رازها می‌آیند.
4. شمار مهاجرت‌ها امروز **۱۰۸** است (`0000` تا `0107`، ۱۴۰۵/۰۸/۰۴). هر انتشار تازه ممکن است بیشتر کند. شمار درست همیشه همان است که `launch-check` بند ۵ می‌گوید («applied of expected»).
5. **پیش از هر `db:migrate` روی production:** پشتیبان تازه ([فصل ۷](07-backup-restore.md)) و آیین مهاجرت (پایین).

## ۳.۴ چرا DELETE و TRUNCATE نیست

**آزمایش‌شده:** روی همان پایگاه دورریختنی، `DELETE FROM ledger_entries …` و `TRUNCATE audit_events` با `sepehr_app` هر دو `permission denied` گرفتند.

- مهاجرت `0000` به `sepehr_app` فقط `SELECT, INSERT, UPDATE` می‌دهد. نه `DELETE`، نه `TRUNCATE`، نه DDL.
- **دلیل:** سامانه مالی است. دفتر کل فقط افزودنی است؛ اصلاح فقط با سند معکوس. حذف فیزیکی ممنوع است و حذف منطقی با `deleted_at` و ثبت در audit (قاعده ۳ و ۷ CLAUDE.md). اگر کسی رمز برنامه را بدزدد یا باگی پیش بیاید، پایگاه خودش جلوی پاک شدن سابقه را می‌گیرد.
- روی جدول‌های افزودنی (دفتر کل، audit، outbox و چند جدول دیگر) trigger هم هست که `UPDATE` و `DELETE` را رد می‌کند (`reject_append_only_change`)، حتی برای نقش‌های دیگر.
- **پارتیشن‌ها:** جدول‌های بزرگ (`audit_events`، `access_logs`، `outbox_events`، `processed_events`، `ledger_entries`) ماهانه پارتیشن دارند. ساختن ماه‌های بعد و بایگانی ماه‌های قدیمی با تابع `maintain_monthly_partitions` (`SECURITY DEFINER`، مهاجرت 0004) است که worker هر روز ساعت ۰۳:۰۰ UTC صدا می‌زند. بایگانی یعنی **جدا کردن** (detach)، هرگز حذف. دفتر کل هرگز بایگانی نمی‌شود، چون موجودی جمع همه ثبت‌هاست.
- فرمان دستی `pnpm ops:partitions` برای جبران پس از خاموشی طولانی worker است (یک اجرای همان کار روزانه، با نقش `sepehr_app`). تا ۱۴۰۵/۰۸/۰۲ شروع نمی‌شد (وابستگی OUTBOX)؛ اصلاح شد (`63be36f`) و با آزمون بالا آمدن سنجیده می‌شود. ۱۲ ماه جلوتر ساخته می‌شود، پس چند روز خاموشی worker مشکلی نمی‌سازد.

## ۳.۵ آیین مهاجرت

هر مهاجرت روی production این گام‌ها را دارد (دستور مالک ۱۴۰۵/۰۷/۱۶ و ۱۴۰۵/۰۷/۱۸؛ همان روند 0102 تا 0104):

1. **خلاصه SQL** پیش از اجرا در فایل تصمیم همان تسک (`docs/decisions/`).
2. **پشتیبان تازه:** `pg_dump -Fc` رمزشده با `age`، روی دیسک پشتیبان، با زمان در نام فایل. شمار ردیف جدول‌های اصلی و شمار مهاجرت ثبت شود.
3. **تمرین روی کپی:** همان dump روی پایگاه جدا بازیابی و مهاجرت روی آن اجرا شود.
4. **journal، snapshot و drift:** `bash scripts/ci/db-drift.sh` باید «بدون drift» بگوید (روی مخزن، پیش از انتشار).
5. **مقایسه پیش و پس** روی کپی: شمار ردیف‌ها، نقش‌ها، grantها و هر چیزی که مهاجرت عوض می‌کند.
6. **هم‌سانی با پایگاه ساخته‌شده از صفر:** طرح کپی مهاجرت‌شده با پایگاهی که فقط با `db:bootstrap` و `db:migrate` از صفر ساخته شده یکی باشد (`pg_dump --schema-only` هر دو و مقایسه).
7. **اجرا روی production** با `MIGRATION_DATABASE_URL`، در ساعت کم‌بار، بیرون از پنجره کارهای شبانه.
8. **پس از اجرا:** `pnpm ops:launch-check` (بند ۵ و ۱) و همان شمارش‌ها.

**مهاجرت مخرب** (`DROP`، `RENAME`، `ALTER COLUMN`، `DELETE`، `TRUNCATE`): فقط در انتشار جدا، با تأیید صریح مالک. مهاجرت‌ها **سازگار با نسخه قبل** نوشته می‌شوند (expand/contract)، پس برگشت برنامه بی برگشت مهاجرت ممکن است.

## ۳.۶ پس از نصب: بررسی‌های فقط‌خواندنی

- `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'sepehr_%';`: همه `false`.
- `SELECT count(*) FROM drizzle.__drizzle_migrations;` (با `sepehr_owner`): برابر شمار مهاجرت‌های نسخه.
- `SHOW timezone;` اهمیتی ندارد (زمان‌ها `timestamptz` و UTC)، ولی ساعت سرور پایگاه با NTP همگام باشد (`launch-check` بند ۱۶).
