# ۱۰. پیوست: فرمان‌ها، نمونه پیکربندی، تصمیم‌های مالک و نامعلوم‌ها

[فهرست راهنما](../deployment-guide.md)

## ۱۰.۱ فرمان‌ها

همه از ریشه مخزن. هر فرمان `pnpm` پیش از اجرا api را می‌سازد.

| فرمان | کار | متغیرها | وضعیت |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | نصب وابستگی‌ها از lockfile | — | در CI و `Dockerfile` |
| `pnpm build` | ساخت همه بسته‌ها | — | در CI |
| `pnpm db:bootstrap` | سه نقش پایگاه؛ چرخش رمزها | `DB_ADMIN_URL`، `DB_*_PASSWORD` | **آزمایش‌شده** ۱۴۰۵/۰۸/۰۲ |
| `pnpm db:migrate` | مهاجرت‌ها | `MIGRATION_DATABASE_URL` | **آزمایش‌شده** ۱۴۰۵/۰۸/۰۲ (۱۰۵ از ۱۰۵) |
| `pnpm ops:launch-check` | بررسی پیش از راه‌اندازی، فقط خواندنی | `DATABASE_URL`، `MIGRATION_DATABASE_URL` | **آزمایش‌شده** ۱۴۰۵/۰۸/۰۲ |
| `pnpm ops:partitions` | یک اجرای دستی نگهداری پارتیشن | `DATABASE_URL` | **آزمایش‌شده** ۱۴۰۵/۰۸/۰۲ پس از اصلاح `63be36f` (`partitions created: 0, archived: none`) |
| `pnpm ops:outbox-requeue --since <ISO> --dry-run` | بازگرداندن کارهای صف پس از از دست رفتن Redis | `DATABASE_URL`، `REDIS_URL` | آزمایش‌نشده روی سرور |
| `pnpm account:create` | ساخت حساب کارمند یا مرکز | `ACCOUNT_KIND`، `ACCOUNT_USERNAME`، `ACCOUNT_PASSWORD` | آزمایش‌نشده روی سرور |
| `pnpm access:grant` | دادن نقش سراسری | `ACCOUNT_ID`، `ROLE_CODE`، `GRANT_REASON` | آزمایش‌نشده روی سرور |
| `pnpm catalog:rebuild-search` | بازسازی نمایه جست‌وجو (بی `-- --apply` خشک) | `DATABASE_URL` | آزمایش‌نشده روی سرور |
| `pnpm --filter @sepehr/api security:reencrypt` | بازرمزگذاری پس از چرخش کلید فیلد | `docs/security/key-rotation-and-backup.md` §۲ | آزمایش‌نشده روی سرور |
| `pnpm --filter @sepehr/web start` | وب بیمار روی ۳۰۰۱ | محیط وب | آزمایش‌نشده روی سرور |
| `pnpm --filter @sepehr/admin start` | پنل داخلی روی ۳۰۰۲ | محیط پنل | آزمایش‌نشده روی سرور |
| `pnpm docker:build` | چهار ایمیج و آزمون PDF در ایمیج worker | — | **آزمایش‌شده** ۱۴۰۵/۰۸/۰۲ |
| `bash scripts/ci/db-drift.sh` | drift طرح Drizzle و snapshot | — | در CI |

## ۱۰.۲ نمونه پیکربندی

**همه آزمایش‌نشده‌اند.** هر `<...>` جای مقداری است که **پس از تعیین مشخصات سرور** معلوم می‌شود. هیچ راز در این فایل‌ها نمی‌آید.

### `/etc/ssh/sshd_config.d/sepehr.conf`

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers <نام-مدیر-۱> <نام-مدیر-۲>
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowTcpForwarding no
```

### `/etc/fail2ban/jail.local`

```
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 <بازه-VPN> <آدرس-دفتر>
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
```

### واحد systemd: `/etc/systemd/system/sepehr-api.service`

```
[Unit]
Description=Sepehr API
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
User=sepehr
Group=sepehr
WorkingDirectory=/opt/sepehr/app/apps/api
EnvironmentFile=/etc/sepehr/api.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

برای worker همان، با `WorkingDirectory=/opt/sepehr/app/apps/worker`، `EnvironmentFile=/etc/sepehr/worker.env` و `After=sepehr-api.service`. برای وب و پنل:

```
WorkingDirectory=/opt/sepehr/app
EnvironmentFile=/etc/sepehr/web.env
ExecStart=/usr/bin/env pnpm --filter @sepehr/web start
```

(`@sepehr/admin` و `/etc/sepehr/admin.env` برای پنل.)

**فایل‌های محیطی (تصمیم مالک ۱۴۰۵/۰۸/۰۲):** برای هر سرویس فایل جدا (`api.env`، `worker.env`، `web.env`، `admin.env`) و هر سرویس فقط رازهای خودش را دارد. مالک `root`، دسترسی `600` (یا `640` با گروه `sepehr` اگر سرویس با `User=sepehr` آن را نمی‌خواند)، بیرون از مخزن، هرگز در لاگ، و **بیرون از هر پشتیبان رمزنشده**؛ فقط در نسخه رمزشده آفلاین. پس از پایلوت، مدیر رمز (OpenBao) جای آن‌ها را می‌گیرد.

`ProtectSystem=strict` ممکن است نوشتن پوشه‌های لازم را ببندد. اگر سرویسی جایی می‌نویسد، با `ReadWritePaths=` باز شود (روی staging بسنجید).

**با ایمیج‌ها** (`Dockerfile` و `Dockerfile.next`، ساخته‌شده ۱۴۰۵/۰۸/۰۲): همان فایل‌ها با `--env-file` به `docker run` داده می‌شوند و پورت فقط روی `127.0.0.1` منتشر می‌شود (`-p 127.0.0.1:3001:3001`). وب و پنل با `PORT` (۳۰۰۱ و ۳۰۰۲) اجرا می‌شوند؛ worker، Chromium و فونت PDF را در ایمیج خودش دارد (`PDF_BROWSER_PATH` و `PDF_FONT_FILE` از پیش تنظیم است).

### nginx: `/etc/nginx/sites-available/sepehr`

```
server {
    listen 80;
    server_name <دامنه-بیمار> <دامنه-پنل-داخلی>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name <دامنه-بیمار>;
    ssl_certificate     <مسیر-گواهی-بیمار>;
    ssl_certificate_key <مسیر-کلید-گواهی-بیمار>;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 11m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name <دامنه-پنل-داخلی>;
    ssl_certificate     <مسیر-گواهی-پنل>;
    ssl_certificate_key <مسیر-کلید-گواهی-پنل>;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 11m;

    # لایه دوم؛ لایه اول INTERNAL_PANEL_CIDRS در خود api است.
    allow <بازه-VPN>;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

`X-Forwarded-For $remote_addr` (نه `$proxy_add_x_forwarded_for`): پراکسی سرآیند فرستاده‌شده کاربر را دور می‌اندازد، تا کسی نتواند با سرآیند جعلی از فهرست VPN بگذرد.

### نمونه محیط api (بی مقدار)، `/etc/sepehr/api.env`

```
NODE_ENV=production
PORT=3000
DATABASE_URL=<راز>
REPORTING_DATABASE_URL=<راز>
REDIS_URL=<راز>
AUTH_SECRET=<راز>
FIELD_ENCRYPTION_KEY=<راز>
BLIND_INDEX_KEY=<راز>
WEB_ORIGINS=https://<دامنه-بیمار>,https://<دامنه-پنل-داخلی>
TRUST_PROXY=loopback
INTERNAL_PANEL_CIDRS=<بازه-VPN>
API_INTERNAL_URL=http://127.0.0.1:3000
PUBLIC_WEB_ORIGIN=https://<دامنه-بیمار>
PATIENT_WEB_ORIGIN=https://<دامنه-بیمار>
SMS_PROVIDER=kavenegar
KAVENEGAR_API_KEY=<راز>
KAVENEGAR_OTP_TEMPLATE=<نام-الگو>
KAVENEGAR_STEP_UP_TEMPLATE=sepehrappverify1
KAVENEGAR_SENDER=<خط-فرستنده>
ALERT_SMS_MOBILES=<موبایل-نوبت‌کارها>
KAVENEGAR_ALERT_TEMPLATE=<نام-الگو>
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=<منطقه>
S3_ACCESS_KEY=<راز>
S3_SECRET_KEY=<راز>
S3_PRIVATE_BUCKET=<نام-سطل-خصوصی>
S3_PUBLIC_BUCKET=<نام-سطل-عمومی>
S3_PUBLIC_BASE_URL=<نشانی-عمومی-سطل>
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
BACKUP_AGE_RECIPIENT=<کلید-عمومی-age>
LEAD_WEBHOOK_SECRETS_WORDPRESS=<راز>
OTEL_EXPORTER_OTLP_ENDPOINT=<نشانی-collector>
```

`MIGRATION_DATABASE_URL` و `DB_*` **در این فایل نیستند**؛ فقط هنگام مهاجرت یا bootstrap در نشست همان فرمان. فایل worker همین‌ها را به‌اضافه پیامک و هشدار دارد؛ فایل وب و پنل فقط `NODE_ENV`، `PORT` و `API_INTERNAL_URL` (و هیچ راز).

## ۱۰.۳ تصمیم مالک (۱۴۰۵/۰۸/۰۲)

پاسخ مالک به ۱۶ سؤال این بخش. اختلاف هر پاسخ با گزینه‌ای که پیشنهاد شده بود، در ستون آخر.

| # | موضوع | تصمیم مالک | اختلاف با پیشنهاد |
|---|---|---|---|
| ۱ | مشخصات سرور | پذیرفته: Ubuntu Server LTS؛ دیسک جدا برای داده و پشتیبان؛ اندازه پس از آزمون بار k6. **پس از تعیین مشخصات سرور.** | — |
| ۲ | replica و staging روی سرور دوم | بله، **به شرط جدایی کامل**: VM یا شبکه و دیواره آتش جدا؛ **هیچ داده واقعی در staging**؛ **هیچ رمز مشترک** با production؛ آزمون نفوذ فقط روی staging. | شرط‌های جدایی افزوده شد |
| ۳ | گواهی TLS | پذیرفته: گواهی تجاری یک‌ساله، تمدید ۶۰ روز پیش؛ **هشدار در ۳۰، ۱۴ و ۷ روز** به **دو مسئول**. | هشدارهای ۳۰ و ۷ روز و دو مسئول افزوده شد (قاعده‌ها در `ops/alerts/platform.yml`) |
| ۴ | ایمیج وب و پنل | بله. ساخته شد: `Dockerfile.next`. | — |
| ۵ | جای رازها | پذیرفته برای پایلوت: **فایل محیطی systemd جدا برای هر سرویس**، مالک `root`، دسترسی `600` یا `640`، بیرون از مخزن، بی مقدار در لاگ، **بیرون از پشتیبان رمزنشده**؛ پس از پایلوت مدیر رمز. | یک فایل برای همه → فایل جدا برای هر سرویس |
| ۶ | نگهدار کلیدهای آفلاین | **با اصلاح:** کلید پشتیبان آفلاین **۲ از ۳**: مالک، مدیرعامل آرامش ثروت، و نفر سوم (**از مالک پرسیده می‌شود**)؛ نگهداری فیزیکی جدا؛ **آزمون بازیابی با دو نفر**. | دو نگهدار → دو از سه، با آزمون |
| ۷ | رمزگذاری دیسک | پاسخ جدا نیامد؛ پیشنهاد به کار می‌رود: پشتیبان و کپی بیرونی رمزشده، دیسک داده در اتاق قفل‌دار. | — |
| ۸ | — | (همان ۶) | — |
| ۹ | سطل عمومی تصاویر | پاسخ جدا نیامد؛ پیشنهاد به کار می‌رود: مسیر جدا روی دامنه بیمار. | — |
| ۱۰ | UPS و اینترنت | UPS بله؛ **خط اینترنت دوم یا دست‌کم مودم موبایل**. | مودم موبایل به‌عنوان حداقل افزوده شد |
| ۱۱ | نگهداری پشتیبان | **سؤال حقوقی**؛ در فهرست مشاور حقوقی (`pending-client-decisions.md`، ردیف ۲۱)؛ **پیشنهاد موقت ۱۰ سال، نیازمند تأیید**. تا پاسخ، هیچ پشتیبان ماهانه حذف نمی‌شود. | پیشنهاد «نگه داشتن تا پاسخ» → «۱۰ سال موقت» |
| ۱۲ | کانال دوم هشدار | بله. | — |
| ۱۳ | staging جدا | بله (با شرط‌های ۲). | — |
| ۱۴ | کپی بیرونی | **رمزشده، در محل جدا، بی ابر خارجی.** | «ذخیره‌ساز در ساختمان دیگر» → صریحاً بی ابر خارجی |
| ۱۵ | SSH | **فقط با کلید و فقط نفرات نام‌برده.** | — |
| ۱۶ | VPN | برای پنل داخلی **و SSH**. | SSH هم فقط از VPN |

**هنوز باز:**
- نام نفر سوم نگهدار کلید: **در انتظار** (مالک بعداً می‌دهد)؛ تمرین بازیابی تا آن زمان موکول است.
- نام دو مسئول گواهی.
- مشخصات سرور (سؤال ۱).
- ابزار تقسیم دو از سه کلید ([فصل ۴](04-secrets.md#۴۳-دو-نگهدار-آفلاین)).

## ۱۰.۴ نامعلوم‌ها و کمبودها

| مورد | نوع | وضعیت |
|---|---|---|
| ایمیج وب و پنل | ساخته شد (۱۴۰۵/۰۸/۰۲) | `Dockerfile.next`؛ هر دو با کاربر `node` بالا آمدند و `/login` و فایل‌های static پاسخ ۲۰۰ دادند |
| Chromium در ایمیج worker | ساخته شد | نسخه ثابت `155.0.8059.84-r0`، کاربر `node`؛ PDF قرارداد نمونه بی شبکه ساخته شد و Vazirmatn در آن جاسازی بود. در production بسته از mirror داخلی apk |
| `pnpm ops:partitions` | اصلاح شد (`63be36f`) | با آزمون بالا آمدن |
| SeaweedFS بی هویت در `docker-compose.yml` | فقط توسعه | پیکربندی production با هویت لازم است |
| HSTS در کد نیست | پیکربندی | پراکسی می‌گذارد (نمونه nginx بالا) |
| پیکربندی Grafana، Loki، Tempo، collector | «با ۱۰-۱» | پس از تعیین مشخصات سرور |
| قاعده هشدار UPS، دیسک پشتیبان، کپی بیرونی، قطع اینترنت | نیست | پس از تعیین مشخصات سرور |
| `promtool` و `amtool` | آزمایش‌نشده | از ایمیج mirror داخلی |
| ساخت حساب کارمند از پنل | کمبود در کد | فقط `pnpm account:create` روی سرور |
| اسکن trivy ایمیج‌های تازه | آزمایش‌نشده یا جدا گزارش می‌شود | `scripts/ci/image-scan.sh` حالا هر چهار ایمیج را می‌سنجد |
| فرمان‌های فصل ۲ و نمونه‌های ۱۰.۲ | آزمایش‌نشده | روی staging |
