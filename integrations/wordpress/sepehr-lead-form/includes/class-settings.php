<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The plugin's settings (Settings → فرم سرنخ سپهر): the system's address, the HMAC secret,
 * the default city and the consent text. The secret is never shown back: a constant
 * SEPEHR_WEBHOOK_SECRET in wp-config.php wins; otherwise the stored option, written only when
 * a new value is typed. It is never in the plugin's code (doc 19 8-2).
 */
final class Sepehr_Lead_Settings
{
    public const OPTION = 'sepehr_lead_form';

    /** @return array{api_url: string, secret: string, default_city: string, consent_text: string} */
    public static function all(): array
    {
        $stored = get_option(self::OPTION, []);
        $stored = is_array($stored) ? $stored : [];
        return [
            'api_url' => defined('SEPEHR_API_URL')
                ? (string) constant('SEPEHR_API_URL')
                : (string) ($stored['api_url'] ?? ''),
            'secret' => defined('SEPEHR_WEBHOOK_SECRET')
                ? (string) constant('SEPEHR_WEBHOOK_SECRET')
                : (string) ($stored['secret'] ?? ''),
            'default_city' => (string) ($stored['default_city'] ?? ''),
            'consent_text' => (string) ($stored['consent_text'] ?? 'با دریافت پیامک‌های اطلاع‌رسانی و پیشنهادهای سپهر سلامتی موافقم.'),
        ];
    }

    /** The system's base address without a trailing slash, e.g. https://app.example.ir. */
    public static function base_url(): string
    {
        return rtrim(self::all()['api_url'], '/');
    }

    public static function configured(): bool
    {
        $s = self::all();
        return $s['api_url'] !== '' && strlen($s['secret']) >= 32;
    }

    public static function register(): void
    {
        add_action('admin_init', static function (): void {
            register_setting('sepehr_lead_form_group', self::OPTION, [
                'type' => 'array',
                'sanitize_callback' => [self::class, 'sanitize'],
            ]);
        });
        add_action('admin_menu', static function (): void {
            add_options_page(
                'فرم سرنخ سپهر',
                'فرم سرنخ سپهر',
                'manage_options',
                'sepehr-lead-form',
                [self::class, 'render'],
            );
        });
    }

    /**
     * @param mixed $input
     * @return array<string, string>
     */
    public static function sanitize($input): array
    {
        $input = is_array($input) ? $input : [];
        $old = get_option(self::OPTION, []);
        $old = is_array($old) ? $old : [];
        $url = esc_url_raw(trim((string) ($input['api_url'] ?? '')), ['https', 'http']);
        $secret = trim((string) ($input['secret'] ?? ''));
        return [
            'api_url' => $url,
            // Blank keeps the stored secret: it is never printed in the form.
            'secret' => $secret !== '' ? $secret : (string) ($old['secret'] ?? ''),
            'default_city' => preg_match('/^[a-z][a-z0-9_]{1,39}$/', (string) ($input['default_city'] ?? '')) === 1
                ? (string) $input['default_city']
                : '',
            'consent_text' => sanitize_text_field((string) ($input['consent_text'] ?? '')),
        ];
    }

    public static function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $s = self::all();
        $from_constant = defined('SEPEHR_WEBHOOK_SECRET');
        ?>
        <div class="wrap" dir="rtl">
            <h1>فرم سرنخ سپهر سلامتی</h1>
            <p>فرم را با شورت‌کد <code>[sepehr_lead_form]</code> در هر برگه بگذارید. وضعیت ارسال‌ها در «ابزارها ← ارسال‌های سرنخ سپهر» است.</p>
            <form method="post" action="options.php">
                <?php settings_fields('sepehr_lead_form_group'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="sepehr-api-url">نشانی سامانه</label></th>
                        <td>
                            <input id="sepehr-api-url" name="<?php echo esc_attr(self::OPTION); ?>[api_url]" type="url" dir="ltr" class="regular-text" value="<?php echo esc_attr($s['api_url']); ?>" <?php disabled(defined('SEPEHR_API_URL')); ?> />
                            <p class="description">مثلاً <code dir="ltr">https://app.sepehr.ir</code>، بی <code>/api</code>.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="sepehr-secret">راز امضا (HMAC)</label></th>
                        <td>
                            <?php if ($from_constant) : ?>
                                <p>از <code>wp-config.php</code> خوانده می‌شود.</p>
                            <?php else : ?>
                                <input id="sepehr-secret" name="<?php echo esc_attr(self::OPTION); ?>[secret]" type="password" dir="ltr" class="regular-text" autocomplete="new-password" value="" />
                                <p class="description"><?php echo strlen($s['secret']) >= 32 ? 'تنظیم شده است. برای تغییر، راز تازه را بنویسید.' : 'تنظیم نشده است. دست‌کم ۳۲ نویسه.'; ?></p>
                            <?php endif; ?>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="sepehr-city">کد شهر پیش‌فرض</label></th>
                        <td><input id="sepehr-city" name="<?php echo esc_attr(self::OPTION); ?>[default_city]" type="text" dir="ltr" value="<?php echo esc_attr($s['default_city']); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="sepehr-consent">متن رضایت پیامک</label></th>
                        <td><input id="sepehr-consent" name="<?php echo esc_attr(self::OPTION); ?>[consent_text]" type="text" class="large-text" value="<?php echo esc_attr($s['consent_text']); ?>" /></td>
                    </tr>
                </table>
                <?php submit_button('ذخیره'); ?>
            </form>
        </div>
        <?php
    }
}
