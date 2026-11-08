<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The system's API, server to server (doc 05 §7; docs/integrations/wordpress-lead-webhook.md):
 * the treatment fields (public, cached an hour, the last good list kept), and a lead signed
 * with HMAC-SHA256 over "<timestamp>.<raw body>" with its idempotency key.
 */
final class Sepehr_Lead_Client
{
    private const FIELDS_CACHE = 'sepehr_lead_fields';
    private const FIELDS_LAST_GOOD = 'sepehr_lead_fields_last_good';

    /** @return list<array{code: string, name: string}> */
    public static function fields(): array
    {
        $cached = get_transient(self::FIELDS_CACHE);
        if (is_array($cached)) {
            return $cached;
        }
        $fields = null;
        $base = Sepehr_Lead_Settings::base_url();
        if ($base !== '') {
            $res = wp_remote_get($base . '/api/v1/catalog/fields', ['timeout' => 5]);
            if (!is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200) {
                $data = json_decode(wp_remote_retrieve_body($res), true);
                if (is_array($data)) {
                    $fields = [];
                    foreach ($data as $f) {
                        if (is_array($f) && isset($f['code'], $f['name'])) {
                            $fields[] = ['code' => (string) $f['code'], 'name' => (string) $f['name']];
                        }
                    }
                }
            }
        }
        if ($fields === null || $fields === []) {
            // The system unreachable: the last list that came, so the form still works.
            $last = get_option(self::FIELDS_LAST_GOOD, []);
            return is_array($last) ? $last : [];
        }
        set_transient(self::FIELDS_CACHE, $fields, HOUR_IN_SECONDS);
        update_option(self::FIELDS_LAST_GOOD, $fields, false);
        return $fields;
    }

    /**
     * Sends one lead. Returns the HTTP status: 202 accepted (or replayed), 0 when the system
     * could not be reached; the caller keeps it for later on 0, 429 and 5xx.
     */
    public static function send(string $body, string $idempotency_key): int
    {
        $settings = Sepehr_Lead_Settings::all();
        $base = Sepehr_Lead_Settings::base_url();
        if ($base === '' || strlen($settings['secret']) < 32) {
            return 0;
        }
        $timestamp = (string) time();
        $signature = hash_hmac('sha256', $timestamp . '.' . $body, $settings['secret']);
        $res = wp_remote_post($base . '/api/v1/leads/intake', [
            'timeout' => 10,
            'redirection' => 0,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-Sepehr-Source' => 'wordpress',
                'X-Sepehr-Timestamp' => $timestamp,
                'X-Sepehr-Signature' => 'v1=' . $signature,
                'Idempotency-Key' => $idempotency_key,
            ],
            'body' => $body,
        ]);
        return is_wp_error($res) ? 0 : (int) wp_remote_retrieve_response_code($res);
    }
}
