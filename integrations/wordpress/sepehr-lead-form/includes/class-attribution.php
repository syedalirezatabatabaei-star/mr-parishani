<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Where the visitor came from (doc 05 §7; doc 19 8-2): the utm_* parameters of the address
 * they arrived at and the referrer of their first page, kept in a session cookie so a form
 * on a later page still knows them. Only these, sanitized and bounded; never personal data.
 */
final class Sepehr_Lead_Attribution
{
    private const COOKIE = 'sepehr_lead_src';
    private const UTM = ['source', 'medium', 'campaign', 'term', 'content'];

    public static function capture(): void
    {
        if (is_admin() || wp_doing_cron() || wp_doing_ajax() || headers_sent()) {
            return;
        }
        $utm = [];
        foreach (self::UTM as $k) {
            $v = isset($_GET['utm_' . $k]) ? sanitize_text_field(wp_unslash((string) $_GET['utm_' . $k])) : '';
            if ($v !== '') {
                $utm[$k] = mb_substr($v, 0, 200);
            }
        }
        $known = self::get();
        $referrer = $known['referrer'];
        if ($referrer === '' && isset($_SERVER['HTTP_REFERER'])) {
            $ref = esc_url_raw(wp_unslash((string) $_SERVER['HTTP_REFERER']));
            $own = wp_parse_url(home_url(), PHP_URL_HOST);
            // Another site's page only: a page of this site sent nobody.
            if ($ref !== '' && wp_parse_url($ref, PHP_URL_HOST) !== $own) {
                $referrer = mb_substr($ref, 0, 2000);
            }
        }
        if ($utm === [] && $referrer === $known['referrer']) {
            return;
        }
        $value = (string) wp_json_encode(['utm' => $utm !== [] ? $utm : $known['utm'], 'referrer' => $referrer]);
        setcookie(self::COOKIE, $value, [
            'expires' => 0,
            'path' => COOKIEPATH ?: '/',
            'secure' => is_ssl(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        $_COOKIE[self::COOKIE] = $value;
    }

    /** @return array{utm: array<string, string>, referrer: string} */
    public static function get(): array
    {
        $raw = isset($_COOKIE[self::COOKIE]) ? wp_unslash((string) $_COOKIE[self::COOKIE]) : '';
        $data = $raw !== '' ? json_decode($raw, true) : null;
        $utm = [];
        if (is_array($data) && is_array($data['utm'] ?? null)) {
            foreach (self::UTM as $k) {
                if (isset($data['utm'][$k]) && is_string($data['utm'][$k]) && $data['utm'][$k] !== '') {
                    $utm[$k] = mb_substr(sanitize_text_field($data['utm'][$k]), 0, 200);
                }
            }
        }
        $referrer = is_array($data) && is_string($data['referrer'] ?? null)
            ? mb_substr(esc_url_raw($data['referrer']), 0, 2000)
            : '';
        return ['utm' => $utm, 'referrer' => $referrer];
    }
}
