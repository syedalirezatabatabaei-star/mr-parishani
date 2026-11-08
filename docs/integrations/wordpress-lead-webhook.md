# راهنمای اتصال فرم وردپرس به سامانه (webhook سرنخ)

این راهنما برای توسعه‌دهنده سایت وردپرس است. نصب و نگهداری افزونه با تیم سایت است، نه با تیم سامانه (تصمیم مالک، تسک ۲-۵ب). مرجع فنی: سند ۰۵ بخش ۷ و ADR-026.

## اصول امنیتی (اجباری)

1. **درخواست فقط از سرور وردپرس (server-to-server).** راز HMAC فقط در سرور وردپرس نگه‌داری می‌شود: در `wp-config.php` یا متغیر محیطی، **هرگز** در JavaScript، HTML یا هر چیزی که به مرورگر می‌رسد. فرم ابتدا به خود وردپرس ارسال می‌شود و افزونه (یا یک hook) آن را به سامانه می‌فرستد.
2. **امضا شامل زمان است.** درخواستی که زمانش بیش از چند دقیقه (فعلاً ۵ دقیقه، از پیکربندی `lead.webhook_policy`) با ساعت سامانه فاصله داشته باشد رد می‌شود؛ ساعت سرور وردپرس باید با NTP همگام باشد.
3. **کلید idempotency.** هر ارسال یک کلید یکتا دارد و در تلاش مجدد **همان کلید** دوباره فرستاده می‌شود؛ سامانه ارسال تکراری را فقط یک بار ثبت می‌کند.
4. **تلاش مجدد.** اگر سامانه در دسترس نبود یا پاسخ `5xx` داد، افزونه باید ارسال را نگه دارد و بعداً (مثلاً با WP-Cron و فاصله رو به افزایش) با همان کلید دوباره بفرستد تا سرنخ گم نشود. به `4xx` (جز `429`) تلاش مجدد نکنید.
5. **بدون کپچای خارجی.** reCAPTCHA و مشابه آن در دوره اینترنت ملی در دسترس نیستند. فعلاً یک فیلد honeypot پنهان (`website`) در فرم بگذارید که انسان نمی‌بیند؛ ربات آن را پر می‌کند و سامانه بی‌صدا کنارش می‌گذارد. کپچای داخلی `TODO(decision)` است.

## درخواست

```
POST https://<دامنه سامانه>/api/v1/leads/intake
Content-Type: application/json
X-Sepehr-Source: wordpress
X-Sepehr-Timestamp: <ثانیه‌های Unix>
X-Sepehr-Signature: v1=<HMAC-SHA256 به hex از "<timestamp>.<body خام>">
Idempotency-Key: <۸ تا ۱۰۰ نویسه: حرف، رقم، . _ : ->
```

بدنه:

| فیلد | اجباری | توضیح |
|---|---|---|
| `mobile` | بله | هر شکلی از شماره موبایل (سامانه یکسان‌سازی می‌کند) |
| `treatmentFieldCode` | بله | کد فیلد درمان (مثل `dental`) |
| `name` | خیر | نام |
| `cityCode` | خیر | کد شهر (مثل `tehran`) |
| `smsConsent` | خیر | رضایت دریافت پیامک (`true`/`false`) |
| `utm` | خیر | `{ "source", "medium", "campaign", "term", "content" }` |
| `pageUrl` | خیر | صفحه مبدأ |
| `website` | — | honeypot؛ همیشه خالی بفرستید |

پاسخ‌ها: `202` پذیرفته شد (یا تکراری بود: `"replayed": true`)؛ `400` بدنه نامعتبر؛ `401` امضا، زمان یا منبع نادرست؛ `429` محدودیت نرخ (بعداً دوباره)؛ `503` سامانه هنوز پیکربندی نشده.

## چرخش راز

سامانه هم‌زمان دو راز را می‌پذیرد. برای چرخش: راز تازه را در سامانه اضافه کنید (`LEAD_WEBHOOK_SECRETS_WORDPRESS=تازه,قدیمی`)، افزونه را به راز تازه ببرید، و پس از اطمینان راز قدیمی را از سامانه بردارید. هر راز حداقل ۳۲ نویسه تصادفی است.

## نمونه‌کد کوتاه (PHP)

```php
<?php
// در wp-config.php:  define('SEPEHR_WEBHOOK_SECRET', '...'); define('SEPEHR_WEBHOOK_URL', 'https://.../api/v1/leads/intake');

function sepehr_send_lead(array $fields, string $idempotency_key): bool {
    $body = wp_json_encode([
        'mobile'             => $fields['mobile'],
        'treatmentFieldCode' => $fields['field'],
        'name'               => $fields['name'] ?? null,
        'cityCode'           => $fields['city'] ?? null,
        'smsConsent'         => !empty($fields['sms_consent']),
        'utm'                => $fields['utm'] ?? null,
        'pageUrl'            => $fields['page_url'] ?? null,
        'website'            => $fields['website'] ?? '', // honeypot
    ]);
    $timestamp = (string) time();
    $signature = hash_hmac('sha256', $timestamp . '.' . $body, SEPEHR_WEBHOOK_SECRET);

    $response = wp_remote_post(SEPEHR_WEBHOOK_URL, [
        'timeout' => 10,
        'headers' => [
            'Content-Type'       => 'application/json',
            'X-Sepehr-Source'    => 'wordpress',
            'X-Sepehr-Timestamp' => $timestamp,
            'X-Sepehr-Signature' => 'v1=' . $signature,
            'Idempotency-Key'    => $idempotency_key,
        ],
        'body' => $body,
    ]);
    $code = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
    // 202: done. 0, 429 or 5xx: keep it and retry later with the same key.
    return $code === 202;
}

// هنگام ارسال فرم: کلید یک بار ساخته و همراه داده ذخیره می‌شود تا تلاش مجدد همان کلید را بفرستد.
// $key = 'wp-' . wp_generate_uuid4();
```

توجه: امضا روی **همان بایت‌هایی** محاسبه می‌شود که ارسال می‌شوند؛ بدنه را پس از امضا تغییر ندهید.
