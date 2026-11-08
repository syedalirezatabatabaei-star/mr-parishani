<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The form, `[sepehr_lead_form]` (doc 05 §7): mobile, treatment field, an optional name and
 * the SMS consent. Posted to WordPress itself (admin-post.php), never to the system from the
 * browser. Against bots, all local: a honeypot, a minimum time to fill it in (a signed
 * start time) and a rate limit per address; the system adds its own limits.
 */
final class Sepehr_Lead_Form
{
    private const MIN_FILL_SECONDS = 3;
    private const RATE_LIMIT = 5;
    private const RATE_WINDOW = 10 * MINUTE_IN_SECONDS;

    public static function register(): void
    {
        add_shortcode('sepehr_lead_form', [self::class, 'render']);
    }

    /** Persian and Arabic digits as Latin ones; a mobile as 9XXXXXXXXX, or null. */
    public static function normalize_mobile(string $input): ?string
    {
        $digits = strtr($input, [
            '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4',
            '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
            '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
            '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
        ]);
        $digits = (string) preg_replace('/[\s\-.()\x{200C}\x{200E}\x{200F}]/u', '', $digits);
        if (str_starts_with($digits, '+98')) {
            $digits = substr($digits, 3);
        } elseif (str_starts_with($digits, '0098')) {
            $digits = substr($digits, 4);
        } elseif (preg_match('/^98\d{10}$/', $digits) === 1) {
            $digits = substr($digits, 2);
        } elseif (preg_match('/^0\d{10}$/', $digits) === 1) {
            $digits = substr($digits, 1);
        }
        return preg_match('/^9\d{9}$/', $digits) === 1 ? $digits : null;
    }

    private static function started_token(int $at): string
    {
        return $at . '.' . hash_hmac('sha256', 'sepehr-lead-start.' . $at, wp_salt('nonce'));
    }

    private static function started_at(string $token): ?int
    {
        $parts = explode('.', $token, 2);
        if (count($parts) !== 2 || !ctype_digit($parts[0])) {
            return null;
        }
        return hash_equals(self::started_token((int) $parts[0]), $token) ? (int) $parts[0] : null;
    }

    private static function client_ip(): string
    {
        return isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
    }

    /** @param array<string, string>|string $atts */
    public static function render($atts = []): string
    {
        $fields = Sepehr_Lead_Client::fields();
        $settings = Sepehr_Lead_Settings::all();
        $state = isset($_GET['sepehr_lead']) ? sanitize_key((string) $_GET['sepehr_lead']) : '';
        $page = (string) get_permalink();
        ob_start();
        ?>
        <div id="sepehr-lead-form" class="sepehr-lead" dir="rtl">
            <style>
                .sepehr-lead form{display:grid;gap:.75rem;max-width:28rem}
                .sepehr-lead label{display:block;font-weight:600;margin-bottom:.25rem}
                .sepehr-lead input[type=text],.sepehr-lead input[type=tel],.sepehr-lead select{width:100%;min-height:2.5rem}
                .sepehr-lead .sepehr-hp{position:absolute!important;left:-10000px!important;width:1px;height:1px;overflow:hidden}
                .sepehr-lead .sepehr-note{padding:.75rem;border-radius:.375rem;background:#eef6ee}
                .sepehr-lead .sepehr-note.error{background:#fbecec}
            </style>
            <?php if ($state === 'ok') : ?>
                <p class="sepehr-note" role="status">درخواست شما ثبت شد. کارشناسان سپهر به‌زودی با شما تماس می‌گیرند.</p>
            <?php elseif ($state === 'invalid') : ?>
                <p class="sepehr-note error" role="alert">شماره موبایل یا رشته درمان درست نیست. لطفاً دوباره بررسی کنید.</p>
            <?php elseif ($state === 'busy') : ?>
                <p class="sepehr-note error" role="alert">درخواست‌های زیادی از این دستگاه رسیده است؛ کمی بعد دوباره تلاش کنید.</p>
            <?php endif; ?>
            <?php if ($fields === []) : ?>
                <p class="sepehr-note error">فرم فعلاً در دسترس نیست. لطفاً کمی بعد دوباره سر بزنید.</p>
            <?php else : ?>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="sepehr_lead" />
                <?php wp_nonce_field('sepehr_lead', 'sepehr_lead_nonce'); ?>
                <input type="hidden" name="sepehr_started" value="<?php echo esc_attr(self::started_token(time())); ?>" />
                <input type="hidden" name="sepehr_page" value="<?php echo esc_attr($page); ?>" />
                <div>
                    <label for="sepehr-mobile">شماره موبایل</label>
                    <input id="sepehr-mobile" name="sepehr_mobile" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" required placeholder="09123456789" />
                </div>
                <div>
                    <label for="sepehr-field">رشته درمان</label>
                    <select id="sepehr-field" name="sepehr_field" required>
                        <option value="">انتخاب کنید</option>
                        <?php foreach ($fields as $f) : ?>
                            <option value="<?php echo esc_attr($f['code']); ?>"><?php echo esc_html($f['name']); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div>
                    <label for="sepehr-name">نام (اختیاری)</label>
                    <input id="sepehr-name" name="sepehr_name" type="text" autocomplete="name" maxlength="100" />
                </div>
                <div class="sepehr-hp" aria-hidden="true">
                    <label for="sepehr-website">وب‌سایت</label>
                    <input id="sepehr-website" name="website" type="text" tabindex="-1" autocomplete="off" />
                </div>
                <div>
                    <label><input name="sepehr_consent" type="checkbox" value="1" /> <?php echo esc_html($settings['consent_text']); ?></label>
                </div>
                <button type="submit">ثبت درخواست مشاوره</button>
            </form>
            <?php endif; ?>
        </div>
        <?php
        return (string) ob_get_clean();
    }

    /** admin-post.php?action=sepehr_lead: checked, saved to the queue, tried, then back. */
    public static function handle(): void
    {
        $page = isset($_POST['sepehr_page']) ? esc_url_raw(wp_unslash((string) $_POST['sepehr_page'])) : '';
        $back = static function (string $state) use ($page): void {
            $target = wp_validate_redirect($page !== '' ? $page : home_url('/'), home_url('/'));
            wp_safe_redirect(add_query_arg('sepehr_lead', $state, $target) . '#sepehr-lead-form');
            exit;
        };

        if (!isset($_POST['sepehr_lead_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash((string) $_POST['sepehr_lead_nonce'])), 'sepehr_lead')) {
            $back('invalid');
        }
        // A bot: it filled the hidden field, or answered faster than a person can. Thanked
        // as a person would be, and nothing is kept or sent.
        $honeypot = isset($_POST['website']) ? trim((string) wp_unslash($_POST['website'])) : '';
        $started = self::started_at(isset($_POST['sepehr_started']) ? (string) wp_unslash($_POST['sepehr_started']) : '');
        if ($honeypot !== '' || $started === null || time() - $started < self::MIN_FILL_SECONDS) {
            $back('ok');
        }

        $rate_key = 'sepehr_lead_rl_' . md5(self::client_ip());
        $count = (int) get_transient($rate_key);
        if ($count >= self::RATE_LIMIT) {
            $back('busy');
        }
        set_transient($rate_key, $count + 1, self::RATE_WINDOW);

        $mobile = self::normalize_mobile(isset($_POST['sepehr_mobile']) ? (string) wp_unslash($_POST['sepehr_mobile']) : '');
        $field = isset($_POST['sepehr_field']) ? sanitize_key((string) wp_unslash($_POST['sepehr_field'])) : '';
        $known = array_column(Sepehr_Lead_Client::fields(), 'code');
        if ($mobile === null || $field === '' || ($known !== [] && !in_array($field, $known, true))) {
            $back('invalid');
        }
        $name = isset($_POST['sepehr_name']) ? mb_substr(sanitize_text_field(wp_unslash((string) $_POST['sepehr_name'])), 0, 100) : '';
        $source = Sepehr_Lead_Attribution::get();
        $city = Sepehr_Lead_Settings::all()['default_city'];

        $lead = [
            'mobile' => '0' . $mobile,
            'treatmentFieldCode' => $field,
            'smsConsent' => isset($_POST['sepehr_consent']),
            'pageUrl' => mb_substr($page, 0, 2000),
        ];
        if ($name !== '') {
            $lead['name'] = $name;
        }
        if ($city !== '') {
            $lead['cityCode'] = $city;
        }
        if ($source['utm'] !== []) {
            $lead['utm'] = $source['utm'];
        }
        if ($source['referrer'] !== '') {
            $lead['referrer'] = $source['referrer'];
        }
        // Saved before it is sent: if the system is down it waits here, never lost.
        Sepehr_Lead_Queue::enqueue($lead);
        $back('ok');
    }
}
