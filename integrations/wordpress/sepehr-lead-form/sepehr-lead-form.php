<?php
/**
 * Plugin Name:       فرم سرنخ سپهر سلامتی
 * Description:       فرم درخواست مشاوره سپهر سلامتی: ارسال امضاشده سمت سرور به سامانه، با صف محلی و تلاش دوباره تا هیچ سرنخی گم نشود.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            سپهر سلامتی
 * License:           Proprietary
 * Text Domain:       sepehr-lead-form
 *
 * Task 8-2 (doc 05 §7; doc 19). Server to server only: the HMAC secret never reaches a
 * browser. No outside service, no external captcha: a honeypot, a minimum fill time and a
 * local rate limit, besides the system's own limits. A lead is saved in the local queue
 * before it is sent, then retried by WP-Cron with the same idempotency key until accepted.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

define('SEPEHR_LEAD_VERSION', '1.0.0');
define('SEPEHR_LEAD_DIR', __DIR__);
define('SEPEHR_LEAD_FILE', __FILE__);

require_once __DIR__ . '/includes/class-settings.php';
require_once __DIR__ . '/includes/class-client.php';
require_once __DIR__ . '/includes/class-queue.php';
require_once __DIR__ . '/includes/class-attribution.php';
require_once __DIR__ . '/includes/class-form.php';
require_once __DIR__ . '/includes/class-status-page.php';

register_activation_hook(__FILE__, [Sepehr_Lead_Queue::class, 'activate']);
register_deactivation_hook(__FILE__, [Sepehr_Lead_Queue::class, 'deactivate']);

add_filter('cron_schedules', [Sepehr_Lead_Queue::class, 'schedules']);
add_action(Sepehr_Lead_Queue::CRON_HOOK, [Sepehr_Lead_Queue::class, 'run_due']);

add_action('init', [Sepehr_Lead_Attribution::class, 'capture']);
add_action('init', [Sepehr_Lead_Form::class, 'register']);
add_action('admin_post_nopriv_sepehr_lead', [Sepehr_Lead_Form::class, 'handle']);
add_action('admin_post_sepehr_lead', [Sepehr_Lead_Form::class, 'handle']);

if (is_admin()) {
    Sepehr_Lead_Settings::register();
    Sepehr_Lead_Status_Page::register();
}
