# برگه نصب گام‌به‌گام staging (Ubuntu 26.04)

ثبت ۱۴۰۵/۰۸/۰۴ (۲۰۲۶-۱۰-۲۶). برای کسی که تازه با لینوکس کار می‌کند. هر گام سه بخش دارد: **فرمان**، **خروجی درست**، و **اگر این‌طور شد**. پایه: [راهنمای استقرار](deployment-guide.md)، فصل‌های ۲، ۳، ۵، ۶ و ۷.

> **برچسب همه فرمان‌های سرور: آزمایش‌نشده.** هیچ‌کدام هنوز روی VM اجرا نشده است. فقط چیزهایی که جلویشان «دیده‌شده» آمده روی ماشین توسعه یا ظرف دیده شده‌اند. پیش از production، همین برگه یک بار کامل روی staging اجرا و هر انحراف همین‌جا ثبت شود.

**قواعد:**
- هیچ رمز، کلید یا توکن در این برگه، پیام یا اسکرین‌شات نوشته نمی‌شود. به‌جای هر مقدار `<...>` آمده است.
- هر فرمانی که `sudo` دارد با کاربر مدیر سرور اجرا می‌شود، نه root.
- **پیش از هر گام** که SSH یا دیواره آتش را عوض می‌کند، یک پنجره SSH دیگر **باز نگه دارید**، تا اگر چیزی بسته شد راه برگشت داشته باشید.

**آنچه آماده است (تأیید مالک ۱۴۰۵/۰۸/۰۴):**
- VM با Ubuntu 26.04 و LVM؛
- `/var/lib/postgresql` ۶۰ گیگابایت؛
- `/var/lib/docker` ۵۰ گیگابایت؛
- `/backup` روی **دیسک جدا** ۱۰۰ گیگابایت.

---

## ۰. بررسی دیسک‌ها

```sh
df -h /var/lib/postgresql /var/lib/docker /backup
```

- **خروجی درست:** سه خط با سه «Filesystem» جدا و اندازه‌های نزدیک ۶۰G، ۵۰G و ۱۰۰G.
- **اگر** `/backup` همان Filesystem ریشه (`/`) را نشان داد: دیسک جدا هنوز وصل یا mount نشده است. پیش از گام ۵ درست شود (`lsblk` دیسک را نشان می‌دهد).

## ۱. ورود با کلید SSH، خاموش کردن رمز، fail2ban

**ترتیب ایمنی (هر گام فقط پس از درست بودن گام قبل):**
1. کلید بسازید؛
2. کلید را بفرستید؛
3. ورود با کلید را در یک **نشست تازه** بیازمایید؛
4. **نشست اول را باز نگه دارید** و فقط آن‌وقت رمز را خاموش کنید؛
5. در **نشست سوم** دوباره بیازمایید؛
6. fail2ban؛
7. دیواره آتش، با SSH باز **پیش از** روشن کردنش.

اگر جایی گیر کردید، از نشست باز همان گام را برگردانید. بستن همه نشست‌ها پیش از آزمون یعنی بیرون ماندن از سرور و نیاز به کنسول VM.

**۱.۱ ساخت کلید** (روی رایانه خودتان، ویندوز PowerShell). **آزمایش‌نشده.**

```powershell
ssh-keygen -t ed25519 -C "staging-<نام شما>"
```

- **خروجی درست:** دو فایل در پوشه `.ssh` کاربر ویندوز: `id_ed25519` (خصوصی؛ هرگز به کسی داده یا جایی فرستاده نمی‌شود) و `id_ed25519.pub` (عمومی). یک گذرواژه برای کلید بگذارید.
- **اگر** پرسید «Overwrite?»: کلیدی از قبل هست. «n» بزنید و با `-f` نام دیگری بدهید، مثلاً `id_sepehr_staging`.

**۱.۲ فرستادن کلید عمومی** (یک بار با رمز سرور وارد می‌شوید). **آزمایش‌نشده.**

```powershell
type $env:USERPROFILE/.ssh/id_ed25519.pub | ssh <کاربر>@<نشانی-سرور> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

- **خروجی درست:** رمز سرور را می‌پرسد و بی پیام برمی‌گردد.

**۱.۳ آزمون در نشست تازه** (نشست قبلی را نبندید). **آزمایش‌نشده.**

```powershell
ssh <کاربر>@<نشانی-سرور>
```

- **خروجی درست:** فقط **گذرواژه کلید** را می‌پرسد، نه رمز سرور.
- **اگر** باز رمز سرور را خواست: کلید پذیرفته نشده است. روی سرور `ls -ld ~/.ssh ~/.ssh/authorized_keys` باید `drwx------` و `-rw-------` باشد، و مالکش خود کاربر. **تا این درست نشده، گام ۱.۴ ممنوع.**

**۱.۴ خاموش کردن ورود با رمز** (فقط پس از درست بودن ۱.۳؛ نشست قبلی باز). **آزمایش‌نشده.**

```sh
sudo tee /etc/ssh/sshd_config.d/10-sepehr.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

- **خروجی درست:** `sshd -t` چیزی چاپ نمی‌کند.
- **اگر** `sshd -t` خطا داد: `reload` نکنید. فایل را با `sudo nano /etc/ssh/sshd_config.d/10-sepehr.conf` درست کنید.

**۱.۵ آزمون دوباره در نشست سوم.** **آزمایش‌نشده.**

```powershell
ssh <کاربر>@<نشانی-سرور>
ssh -o PubkeyAuthentication=no <کاربر>@<نشانی-سرور>
```

- **خروجی درست:** اولی با کلید وارد می‌شود. دومی رد می‌شود: «Permission denied (publickey)».
- **اگر** اولی وارد نشد: از نشست باز، `sudo rm /etc/ssh/sshd_config.d/10-sepehr.conf && sudo systemctl reload ssh` و برگشت به ۱.۳.

**۱.۶ fail2ban** (بستن موقت نشانی‌هایی که پیاپی ورود ناموفق دارند). **آزمایش‌نشده.**

```sh
sudo apt-get install -y fail2ban
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
ignoreip = 127.0.0.1/8 <بازه-VPN>
EOF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

- **خروجی درست:** «Status for the jail: sshd» با «Currently banned: 0». (`fail2ban` 1.1.0 در مخزن Ubuntu 26.04 دیده شد.)
- **`ignoreip`:** بازه VPN شرکت (`<بازه-VPN>`) را بگذارید، تا خودتان با چند اشتباه بیرون نمانید.
- **اگر** خودتان بسته شدید: از کنسول VM، `sudo fail2ban-client set sshd unbanip <نشانی-شما>`.

**۱.۷ دیواره آتش** (پیش از روشن کردن، SSH باز شود). **آزمایش‌نشده.**

```sh
sudo ufw allow from <بازه-VPN> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

- **خروجی درست:** «Status: active» با همین سه قاعده.
- **SSH فقط از VPN** (تصمیم مالک: پنل داخلی و SSH پشت VPN). اگر هنوز VPN ندارید، موقتاً `sudo ufw allow 22/tcp`، و پس از آماده شدن VPN آن را بردارید.
- **Docker و ufw:** Docker قاعده‌های خودش را جلوتر از ufw می‌گذارد. برای همین در این برگه هر پورت ظرف فقط روی `127.0.0.1` منتشر می‌شود (`-p 127.0.0.1:…`) و از بیرون دیده نمی‌شود.

سخت‌سازی کامل (به‌روزرسانی خودکار، NTP، کاربرها): [فصل ۲](deployment/02-server-hardening.md).

## ۲. نصب Docker

**تصمیم (۱۴۰۵/۰۸/۰۴):** Docker از **بسته‌های خود Ubuntu** (`docker.io` و `docker-compose-v2`)، نه مخزن جدای `download.docker.com`.
- همان mirror داخلی Ubuntu که بقیه سیستم‌عامل از آن می‌آید آن را می‌دهد، پس در اینترنت ملی هم نصب و به‌روزرسانی می‌شود.
- به‌روزرسانی امنیتی‌اش با Ubuntu می‌آید.
- هیچ مخزن خارجی دیگری روی سرور نمی‌ماند.
- روی ظرف Ubuntu 26.04 دیده شد (۱۴۰۵/۰۸/۰۴): `docker.io` 29.1.3، `docker-compose-v2` 2.40.3.

**آزمایش‌نشده.**

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker run --rm hello-world
docker --version
```

- **خروجی درست:** «Hello from Docker!» و `Docker version 29…`.
- **اگر** `hello-world` دانلود نشد (اینترنت ملی): ایمیج‌ها از ماشین توسعه با `docker save` و `docker load` می‌آیند، مثل گام ۶. این آزمون را رد کنید و `sudo docker info` را ببینید.
- **اگر** «permission denied … docker.sock»: فرمان‌ها با `sudo` اجرا شوند. کاربر را به گروه `docker` **اضافه نکنید**؛ آن گروه یعنی دسترسی root.
- `/var/lib/docker` روی حجم ۵۰ گیگابایتی جداست. `df -h /var/lib/docker` پس از نصب آن را نشان می‌دهد.

## ۳. نصب PostgreSQL 17 مستقیم

Ubuntu 26.04 خودش فقط **۱۸** دارد. خط آزموده ما **۱۷** است، از مخزن رسمی PostgreSQL (PGDG). وجود `postgresql-17` 17.11 در `resolute-pgdg` روی یک ظرف Ubuntu 26.04 دیده‌شده است (۱۴۰۵/۰۸/۰۴)، نه روی سرور.

```sh
sudo apt-get install -y postgresql-common
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt resolute-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update
sudo apt-get install -y postgresql-17 postgresql-client-17 pgbackrest
sudo apt-mark hold postgresql-17 postgresql-client-17
pg_lsclusters
sudo mv /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.list.disabled
sudo apt-get update
```

**نصب یک‌باره از راه VPN، سپس غیرفعال کردن مخزن PGDG (تصمیم مالک ۱۴۰۵/۰۸/۰۴):** تا mirror داخلی PGDG آماده نیست، این گام **یک بار** با VPN اجرا می‌شود. سپس فایل مخزن PGDG غیرفعال می‌شود (`pgdg.list.disabled`)، تا سرور در کار روزانه به مخزن خارجی سر نزند. وقتی mirror داخلی آماده شد، `pgdg.list` با نشانی mirror داخلی دوباره ساخته می‌شود و `apt-mark hold` همچنان نسخه را نگه می‌دارد.

- **خروجی درست:** `pg_lsclusters` یک خط با `17  main  5432 online postgres /var/lib/postgresql/17/main`.
- **هرگز** `apt install postgresql` (بی شماره) یا `postgresql-18` نزنید: نسخه آزموده عوض می‌شود.
- **آزمایش‌نشده** روی سرور. وجود `postgresql-17` 17.11 در `resolute-pgdg` فقط روی ظرف دیده‌شده است.
- **اگر** خوشه `18` هم ساخته شد (کسی بسته ۱۸ نصب کرده): `sudo pg_dropcluster --stop 18 main`. **فقط اگر داده‌ای ندارد**؛ اول با `pg_lsclusters` مطمئن شوید.
- **اگر** دانلود از `apt.postgresql.org` ممکن نیست: mirror داخلی PGDG (پس از تعیین مشخصات سرور).

**گوش دادن و ورود** (Postgres فقط روی `127.0.0.1` و پل Docker):

```sh
ip -4 addr show docker0 | grep inet
```

نشانی پل را بنویسید؛ معمولاً `172.17.0.1/16`.

```sh
sudo tee /etc/postgresql/17/main/conf.d/10-sepehr.conf >/dev/null <<'EOF'
listen_addresses = 'localhost,172.17.0.1'
password_encryption = scram-sha-256
EOF
echo "host  sepehr  sepehr_owner,sepehr_app,sepehr_report,postgres  172.17.0.0/16  scram-sha-256" | sudo tee -a /etc/postgresql/17/main/pg_hba.conf >/dev/null
sudo systemctl restart postgresql@17-main
sudo -u postgres psql -Atc "SHOW listen_addresses"
```

- **خروجی درست:** `localhost,172.17.0.1`.
- **اگر** Postgres بالا نیامد: `sudo journalctl -u postgresql@17-main -n 50`. اغلب نشانی پل اشتباه است.

## ۴. ساخت پایگاه و نقش‌ها، سپس مهاجرت

**پیش‌نیاز:** ایمیج‌های برنامه روی سرور (گام ۶، بخش «آوردن ایمیج‌ها») و فایل‌های محیطی در `/etc/sepehr/` ([فصل ۴](deployment/04-secrets.md) و [فصل ۱۰](deployment/10-appendix.md)). رمزها هر کدام **دست‌کم ۱۶ نویسه**، تصادفی، و فقط در فایل‌های `0600`.

```sh
sudo -u postgres createdb sepehr
sudo -u postgres psql -c "\password postgres"
```

`\password` رمز را دو بار می‌پرسد و **چاپ نمی‌کند**. این رمز فقط برای bootstrap است؛ در `/etc/sepehr/bootstrap.env` (`0600`) به شکل `DB_ADMIN_URL=postgres://postgres:<رمز>@host.docker.internal:5432/sepehr`، همراه `DB_OWNER_PASSWORD`، `DB_APP_PASSWORD` و `DB_REPORT_PASSWORD`.

```sh
sudo docker run --rm --add-host=host.docker.internal:host-gateway --env-file /etc/sepehr/bootstrap.env sepehr-api:<برچسب> node dist/db/cli/bootstrap.js
sudo docker run --rm --add-host=host.docker.internal:host-gateway --env-file /etc/sepehr/migrate.env sepehr-api:<برچسب> node dist/db/cli/migrate.js
```

(`migrate.env` فقط `MIGRATION_DATABASE_URL` با نقش `sepehr_owner` را دارد.)

- **خروجی درست:** `database roles ready`، سپس `migrations applied`.
- **بررسی:** `sudo -u postgres psql -d sepehr -Atc "select count(*) from drizzle.__drizzle_migrations"` برابر شمار مهاجرت‌های نسخه (امروز **۱۰۸**).
- **اگر** «password authentication failed»: خط `pg_hba.conf` گام ۳ یا رمز فایل env را ببینید. رمز را در ترمینال چاپ نکنید.
- **اگر** «could not connect … host.docker.internal»: `--add-host` جا افتاده یا `listen_addresses` نشانی پل را ندارد.
- پس از کار، `bootstrap.env` با `sudo shred -u` پاک شود. رمز `postgres` فقط برای کارهای مدیریتی دستی می‌ماند.

## ۵. pgBackRest و آزمون بازیابی تا یک لحظه (PITR)

پیکربندی و اسکریپت‌ها: `ops/backup/pgbackrest/` و [`encrypted-backup-plan.md`](encrypted-backup-plan.md).

```sh
sudo install -d -o postgres -g postgres -m 0750 /backup/pgbackrest /offsite/pgbackrest /restore
sudo cp ops/backup/pgbackrest/pgbackrest.conf.example /etc/pgbackrest/pgbackrest.conf
sudo install -d -o postgres -g postgres -m 0750 /etc/pgbackrest/conf.d
sudo -u postgres touch /etc/pgbackrest/conf.d/secrets.conf && sudo chmod 0600 /etc/pgbackrest/conf.d/secrets.conf
sudo -u postgres nano /etc/pgbackrest/conf.d/secrets.conf
```

در `secrets.conf` دو خط `repo1-cipher-pass=` و `repo2-cipher-pass=` با دو گذرواژه تصادفی بلند. نسخه آفلاین آن‌ها دو از سه است ([فصل ۴](deployment/04-secrets.md)).

```sh
sudo cp ops/backup/pgbackrest/postgresql.conf.snippet /etc/postgresql/17/main/conf.d/20-archive.conf
sudo systemctl restart postgresql@17-main
sudo -u postgres pgbackrest --stanza=sepehr stanza-create
sudo -u postgres pgbackrest --stanza=sepehr check
sudo -u postgres pgbackrest --stanza=sepehr --type=full --repo=1 backup
sudo -u postgres pgbackrest --stanza=sepehr --type=full --repo=2 backup
sudo -u postgres pgbackrest --stanza=sepehr info
```

- **خروجی درست:** `check` بی خطا؛ `info` برای هر دو مخزن `status: ok` و یک `full backup`.
- **اگر** `check` گفت WAL نرسید: `archive_command` در `20-archive.conf` یا دسترسی `/backup/pgbackrest` را ببینید.

**آزمون PITR** (فقط staging):

```sh
sudo -u postgres env REPO=1 bash ops/backup/pgbackrest/pitr-test.sh
sudo -u postgres env REPO=2 bash ops/backup/pgbackrest/pitr-test.sh
```

- **خروجی درست:** `marker before T: 1 … after T: 0 … unbalanced journals 0` و `PITR test passed`، برای هر دو مخزن. زمان بازیابی را در `docs/ops/restore-drill-<تاریخ>.md` بنویسید.
- **اگر** «PITR TEST FAILED» با `after T: 1`: بازیابی از T گذشته است. `--target` و ساعت سرور (NTP) را ببینید.

## ۶. نصب برنامه

**آوردن ایمیج‌ها** (روی ماشین توسعه، که اینترنت و mirror npm دارد):

```sh
IMAGE_TAG=<برچسب> sh scripts/ci/docker-build.sh
docker save sepehr-api:<برچسب> sepehr-worker:<برچسب> sepehr-web:<برچسب> sepehr-admin:<برچسب> | gzip > sepehr-<برچسب>.tar.gz
scp sepehr-<برچسب>.tar.gz <کاربر>@<نشانی-سرور>:/tmp/
```

روی سرور: `gunzip -c /tmp/sepehr-<برچسب>.tar.gz | sudo docker load`. **خروجی درست:** چهار خط `Loaded image`.

**Redis، ذخیره‌ساز و ClamAV** (همان ایمیج‌های قفل‌شده `docker-compose.yml`؛ فقط `127.0.0.1`):

```sh
sudo docker run -d --name redis --restart unless-stopped -p 127.0.0.1:6379:6379 -v redis-data:/data redis:8-alpine redis-server --appendonly yes --appendfsync everysec
sudo docker run -d --name clamav --restart unless-stopped -p 127.0.0.1:3310:3310 clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
```

ذخیره‌ساز S3 با هویت (کمبود فعلی پیکربندی محلی): [فصل ۵ §۵.۷](deployment/05-application.md). **پس از تعیین مشخصات سرور.**

**چهار سرویس** (فایل محیط هر کدام در `/etc/sepehr/`؛ [فصل ۱۰](deployment/10-appendix.md)):

```sh
for s in api:3000 web:3001 admin:3002; do n=${s%%:*}; p=${s##*:}; sudo docker run -d --name "sepehr-$n" --restart unless-stopped --add-host=host.docker.internal:host-gateway --env-file "/etc/sepehr/$n.env" -p "127.0.0.1:$p:$p" "sepehr-$n:<برچسب>"; done
sudo docker run -d --name sepehr-worker --restart unless-stopped --add-host=host.docker.internal:host-gateway --env-file /etc/sepehr/worker.env sepehr-worker:<برچسب>
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

- **ترتیب:** api اول، سپس وب و پنل، **worker آخر**.
- **خروجی درست:** `health/ready` با کد ۲۰۰.
- **اگر** api بالا نیامد: `sudo docker logs sepehr-api --tail 50`. اغلب متغیری در env جا افتاده است؛ پیام نام متغیر را می‌گوید، نه مقدارش را.
- **اگر** worker با «SMS_PROVIDER» بسته شد: در staging `SMS_PROVIDER=fake` و `DEPLOY_ENV=staging` لازم است.

## ۷. پراکسی معکوس و TLS آزمایشی

```sh
sudo apt-get install -y nginx
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=<دامنه-staging>" -keyout /etc/ssl/private/staging.key -out /etc/ssl/certs/staging.crt
sudo chmod 0600 /etc/ssl/private/staging.key
```

گواهی **خودامضای ۳۰ روزه، فقط برای staging**. production گواهی واقعی می‌گیرد ([فصل ۵ §۵.۶](deployment/05-application.md)).

نمونه nginx: [فصل ۱۰](deployment/10-appendix.md) («nginx: `/etc/nginx/sites-available/sepehr`»)، با `ssl_certificate` و `ssl_certificate_key` بالا. سپس:

```sh
sudo ln -s /etc/nginx/sites-available/sepehr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -kfsS https://<دامنه-staging>/api/v1/health/live
```

- **خروجی درست:** `nginx -t` می‌گوید «syntax is ok» و «test is successful»؛ `curl` پاسخ ۲۰۰.
- **اگر** مرورگر هشدار گواهی داد: برای گواهی خودامضا طبیعی است، فقط در staging.
- **اگر** ۵۰۲: سرویس پشت آن (۳۰۰۱ یا ۳۰۰۲) بالا نیست؛ `sudo docker ps`.

## ۸. launch-check

```sh
sudo docker run --rm --add-host=host.docker.internal:host-gateway --env-file /etc/sepehr/launch-check.env sepehr-api:<برچسب> node dist/infra/ops/cli/launch-check.js
```

(`launch-check.env`: `DATABASE_URL` با `sepehr_app`، `MIGRATION_DATABASE_URL` با `sepehr_owner`، `REPORTING_DATABASE_URL`، و همان `SMS_PROVIDER` و `KAVENEGAR_STEP_UP_TEMPLATE` فایل worker.)

- **خروجی درست روی staging:** بند ۱ (نقش برنامه) و بند ۵ (مهاجرت‌ها، ۱۰۸ از ۱۰۸) PASS.
- بندهای FAIL و WARN دیگر همان فهرست روز راه‌اندازی است ([`pre-launch-checklist.md`](pre-launch-checklist.md)). بند ۲۵ روی staging با `SMS_PROVIDER=fake` WARN است، نه FAIL.
- **اگر** بند ۱ FAIL داد: سرویسی با superuser وصل است؛ `DATABASE_URL` باید `sepehr_app` باشد.

---

**پس از اجرا:** هر جا خروجی با این برگه فرق داشت، همین‌جا ثبت شود (تاریخ، گام، چه دیده شد، چه کردید). سپس برچسب «آزمایش‌نشده» آن گام برداشته شود.
