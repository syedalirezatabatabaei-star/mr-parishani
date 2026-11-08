<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Tools → ارسال‌های سرنخ سپهر (doc 19 8-2): what waits, what was refused and what was sent,
 * the mobile masked; a button to try every waiting one now. For administrators only.
 */
final class Sepehr_Lead_Status_Page
{
    public static function register(): void
    {
        add_action('admin_menu', static function (): void {
            add_management_page(
                'ارسال‌های سرنخ سپهر',
                'ارسال‌های سرنخ سپهر',
                'manage_options',
                'sepehr-lead-status',
                [self::class, 'render'],
            );
        });
        add_action('admin_post_sepehr_lead_retry', [self::class, 'retry']);
    }

    public static function retry(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('', '', ['response' => 403]);
        }
        check_admin_referer('sepehr_lead_retry');
        $sent = Sepehr_Lead_Queue::run_due(true);
        wp_safe_redirect(add_query_arg(['page' => 'sepehr-lead-status', 'sent' => $sent], admin_url('tools.php')));
        exit;
    }

    private static function masked(string $body): string
    {
        $lead = json_decode($body, true);
        $mobile = is_array($lead) ? (string) ($lead['mobile'] ?? '') : '';
        return strlen($mobile) >= 7 ? substr($mobile, 0, 4) . '***' . substr($mobile, -4) : '—';
    }

    public static function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $counts = Sepehr_Lead_Queue::counts();
        $labels = ['pending' => 'در انتظار ارسال', 'rejected' => 'ردشده (بی تلاش دوباره)', 'sent' => 'ارسال‌شده'];
        ?>
        <div class="wrap" dir="rtl">
            <h1>ارسال‌های سرنخ سپهر</h1>
            <?php if (!Sepehr_Lead_Settings::configured()) : ?>
                <div class="notice notice-warning"><p>نشانی سامانه یا راز امضا تنظیم نشده است؛ سرنخ‌ها در صف می‌مانند.</p></div>
            <?php endif; ?>
            <?php if (isset($_GET['sent'])) : ?>
                <div class="notice notice-success"><p><?php echo esc_html((string) (int) $_GET['sent']); ?> سرنخ ارسال شد.</p></div>
            <?php endif; ?>
            <p>
                در انتظار: <strong><?php echo esc_html((string) $counts['pending']); ?></strong> ·
                ردشده: <strong><?php echo esc_html((string) $counts['rejected']); ?></strong> ·
                ارسال‌شده (۳۰ روز اخیر): <strong><?php echo esc_html((string) $counts['sent']); ?></strong>
            </p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="sepehr_lead_retry" />
                <?php wp_nonce_field('sepehr_lead_retry'); ?>
                <?php submit_button('تلاش دوباره اکنون', 'secondary', 'submit', false); ?>
            </form>
            <table class="widefat striped" style="margin-top:1rem">
                <thead><tr><th>ثبت (UTC)</th><th>موبایل</th><th>وضعیت</th><th>تلاش‌ها</th><th>آخرین پاسخ</th><th>تلاش بعدی (UTC)</th></tr></thead>
                <tbody>
                <?php foreach (Sepehr_Lead_Queue::recent() as $row) : ?>
                    <tr>
                        <td dir="ltr"><?php echo esc_html((string) $row['created_at']); ?></td>
                        <td dir="ltr"><?php echo esc_html(self::masked((string) $row['body'])); ?></td>
                        <td><?php echo esc_html($labels[(string) $row['status']] ?? (string) $row['status']); ?></td>
                        <td><?php echo esc_html((string) $row['attempts']); ?></td>
                        <td dir="ltr"><?php echo esc_html($row['last_code'] === null ? '—' : ((int) $row['last_code'] === 0 ? 'no answer' : (string) $row['last_code'])); ?></td>
                        <td dir="ltr"><?php echo esc_html((string) $row['status'] === 'pending' ? (string) $row['next_attempt_at'] : '—'); ?></td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        </div>
        <?php
    }
}
