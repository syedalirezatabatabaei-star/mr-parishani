# پایش (تسک ۱۰-۳)

همه اجزا **خودمیزبان**اند (قاعده ۱۷ تا ۱۹). ایمیج‌ها از mirror داخلی رجیستری (۱۰-۱) می‌آیند و با digest قفل می‌شوند، مثل `scripts/ci/lib.sh`.

## اجزا

| جزء                                                                 | کار                                                              | پیکربندی در مخزن                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenTelemetry Collector                                             | دریافت OTLP از API و worker؛ سنجه برای Prometheus، رد برای Tempo | با ۱۰-۱                                                                                  |
| Prometheus + Alertmanager                                           | سنجه‌ها و قاعده‌های هشدار                                        | `prometheus.yml`، `alertmanager.yml`، `ops/alerts/queues.yml`، `ops/alerts/platform.yml` |
| Grafana                                                             | داشبورد؛ منبع‌ها Prometheus، Loki و Tempo                        | با ۱۰-۱                                                                                  |
| Loki                                                                | لاگ‌ها (بی داده شخصی، قاعده ۳۰)                                  | با ۱۰-۱                                                                                  |
| Tempo                                                               | ردگیری درخواست‌ها                                                | با ۱۰-۱                                                                                  |
| GlitchTip                                                           | خطاهای برنامه (جایگزین Sentry.io، قاعده ۱۸)                      | با ۱۰-۱                                                                                  |
| Matomo                                                              | آمار بازدید صفحه‌های عمومی (بی کوکی شخص ثالث)                    | با ۱۰-۱                                                                                  |
| node_exporter، postgres_exporter، redis_exporter، blackbox_exporter | میزبان، پایگاه، Redis و HTTPS                                    | `prometheus.yml`                                                                         |

## هشدارهای حیاتی سند ۱۹ §۱۰-۳ و جای هر کدام

| هشدار                                     | قاعده                                                                           | کانال اول                                      | کانال دوم                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| مغایرت تطبیق (دفتر کل، تسویه، پیش‌پرداخت) | `ReconciliationMismatch`                                                        | پیامک worker به نوبت‌کار (`ALERT_SMS_MOBILES`) | Prometheus از `sepehr_alerts_raised_total` (`CountingAlertSink`) |
| رشد صف                                    | `OutboxBacklog`، `QueueBacklog`، `QueueFailedJobs` (`queues.yml`)               | پیامک worker                                   | Prometheus                                                       |
| خطای پیامک                                | `SmsJobsFailing`، `SmsBacklog`                                                  | Prometheus                                     | — (اگر خود پیامک خراب است، پیامک کانال نیست؛ پایین)              |
| پر شدن دیسک                               | `DiskFilling`، `DiskAlmostFull`                                                 | Prometheus                                     | —                                                                |
| تأخیر replica                             | `ReplicaLag`، `ReplicaLagSevere`                                                | Prometheus                                     | —                                                                |
| خطای پشتیبان                              | `WalArchiveStale`، `BaseBackupStale`، `SecondCopyStale`، `BackupMetricsMissing` | Prometheus                                     | —                                                                |
| انقضای گواهی (تصمیم ۱۰.۳: ۶۰ روز پیش)     | `CertificateExpiresSoon`، `CertificateExpiresVerySoon`                          | Prometheus                                     | —                                                                |

## پیامک هشدارهای Prometheus به نوبت‌کار

Alertmanager هشدار را با webhook به یک گیرنده داخلی می‌فرستد که با همان کاوه‌نگار پیامک می‌دهد. هیچ اعلان وابسته به سرویس خارجی نیست (سند ۱۹).

- **ساخته شد (۱۴۰۵/۰۷/۲۴):** `apps/worker/src/alertmanager.ts`، پیکربندی `ops/monitoring/alertmanager.yml`.
  - فقط با `ALERTMANAGER_WEBHOOK_PORT` و `ALERTMANAGER_WEBHOOK_TOKEN` (دست‌کم ۳۲ نویسه) روشن می‌شود؛ پیش‌فرض گوش دادن روی `127.0.0.1`، در شبکه کانتینر `ALERTMANAGER_WEBHOOK_HOST=0.0.0.0` و فقط از شبکه داخلی.
  - فقط `POST /alertmanager` با `Authorization: Bearer`؛ بدنه حداکثر ۶۴ کیلوبایت و ۲۰۰ هشدار.
  - فقط هشدار `firing` با `severity="critical"` پیامک می‌شود؛ هشدار هشداری (warning) و `resolved` فقط در Grafana.
  - رفتار مثل `SmsAlertSink`: همان شماره‌ها، همان مهلت تکرار ۳۰ دقیقه برای هر نام، و فقط **نام قاعده** (`alertname`) در پیامک، بی برچسب‌ها.
  - توکن در Alertmanager از فایل (`credentials_file`) و از مخزن راز (۱۰-۱)، هرگز در مخزن کد.
- **کانال جایگزین برای خطای پیامک:** اگر کاوه‌نگار خراب باشد، هشدار پیامکی نمی‌رسد. پس هشدار `SmsJobsFailing` باید از کانال دوم برود: تماس تلفنی خودکار یا پیام‌رسان داخلی. تصمیم آن با مالک است (فهرست «با مالک» در RESUME).

## پشتیبان: سنجه‌های فایل متنی

کار پشتیبان (WAL-G، `docs/decisions/task-10-2-plan.md`) پس از هر موفقیت در پوشه textfile collector در node_exporter می‌نویسد:

```
sepehr_backup_last_success_timestamp_seconds{kind="wal"} <unix time>
sepehr_backup_last_success_timestamp_seconds{kind="base"} <unix time>
sepehr_backup_last_success_timestamp_seconds{kind="second_copy"} <unix time>
```

اگر کار پشتیبان شکست بخورد، چیزی نمی‌نویسد. پس هشدار از کهنه شدن زمان می‌آید، نه از گزارش خطا.

## بررسی پیش از اتکا

- `promtool check rules ops/alerts/*.yml`، `promtool check config ops/monitoring/prometheus.yml` و `amtool check-config ops/monitoring/alertmanager.yml`، از ایمیج mirror داخلی. **اینجا اجرا نشد:** promtool و amtool محلی نیستند و اینترنت بین‌الملل برای pull نیست.
- **آنچه بی promtool آزموده می‌شود (۱۴۰۵/۰۷/۲۴):** `apps/api/test/ops/alert-rules.test.ts` هر `sepehr_*`، صف و کد هشدار در قاعده‌ها را با کد واقعی (`queue-monitor.ts`، `ALERT_CODES`) می‌سنجد؛ هر کد تطبیق شبانه باید قاعده داشته باشد؛ هر قاعده `severity` و `summary` دارد. `apps/worker/src/alertmanager.test.ts` پیکربندی Alertmanager را با گیرنده worker می‌سنجد.
- نام هر سنجه با `/metrics` هر exporter تطبیق داده شود. نسخه‌های exporter نام‌ها را عوض می‌کنند، مثل `pg_replication_lag_seconds`.
- یک هشدار آزمایشی از هر گروه روی staging آتش شود و پیامکش رسیده باشد.
