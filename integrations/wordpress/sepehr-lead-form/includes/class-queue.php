<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The local queue (doc 19 8-2: «no lead lost»): a lead is written here first, then sent. On
 * 202 it is sent; on no answer, 429 or 5xx it waits and WP-Cron retries it with the same
 * idempotency key, the wait doubling up to an hour; any other 4xx is rejected and not retried
 * (the integration guide). Sent rows are purged after 30 days: the record is the system's.
 */
final class Sepehr_Lead_Queue
{
    public const CRON_HOOK = 'sepehr_lead_retry';
    private const LOCK = 'sepehr_lead_lock';
    private const BATCH = 20;
    private const MAX_WAIT_MINUTES = 60;

    public static function table(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'sepehr_lead_queue';
    }

    public static function activate(): void
    {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $charset = $wpdb->get_charset_collate();
        dbDelta('CREATE TABLE ' . self::table() . " (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            idempotency_key varchar(100) NOT NULL,
            body longtext NOT NULL,
            status varchar(16) NOT NULL DEFAULT 'pending',
            attempts int(11) NOT NULL DEFAULT 0,
            next_attempt_at datetime NOT NULL,
            last_code smallint(6) DEFAULT NULL,
            created_at datetime NOT NULL,
            sent_at datetime DEFAULT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY idempotency_key (idempotency_key),
            KEY due (status, next_attempt_at)
        ) $charset;");
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + 60, 'sepehr_five_minutes', self::CRON_HOOK);
        }
    }

    public static function deactivate(): void
    {
        wp_clear_scheduled_hook(self::CRON_HOOK);
    }

    /** @param array<string, array<string, mixed>> $schedules */
    public static function schedules(array $schedules): array
    {
        $schedules['sepehr_five_minutes'] = ['interval' => 300, 'display' => 'هر ۵ دقیقه'];
        return $schedules;
    }

    /** Saves the lead, then tries it once; true when the system already has it. */
    public static function enqueue(array $lead): bool
    {
        global $wpdb;
        $key = 'wp-' . wp_generate_uuid4();
        $body = (string) wp_json_encode($lead, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $now = gmdate('Y-m-d H:i:s');
        $wpdb->insert(self::table(), [
            'idempotency_key' => $key,
            'body' => $body,
            'status' => 'pending',
            'attempts' => 0,
            'next_attempt_at' => $now,
            'created_at' => $now,
        ]);
        $id = (int) $wpdb->insert_id;
        if ($id === 0) {
            return false;
        }
        return self::attempt($id, $key, $body, 0) === 'sent';
    }

    /** One try of one row; its new status. */
    private static function attempt(int $id, string $key, string $body, int $attempts): string
    {
        global $wpdb;
        $code = Sepehr_Lead_Client::send($body, $key);
        $attempts++;
        if ($code === 202) {
            $wpdb->update(
                self::table(),
                ['status' => 'sent', 'attempts' => $attempts, 'last_code' => $code, 'sent_at' => gmdate('Y-m-d H:i:s')],
                ['id' => $id],
            );
            return 'sent';
        }
        $retry = $code === 0 || $code === 429 || $code >= 500;
        $wait = min(self::MAX_WAIT_MINUTES, 2 ** max(0, $attempts - 1));
        $wpdb->update(
            self::table(),
            [
                'status' => $retry ? 'pending' : 'rejected',
                'attempts' => $attempts,
                'last_code' => $code,
                'next_attempt_at' => gmdate('Y-m-d H:i:s', time() + $wait * 60),
            ],
            ['id' => $id],
        );
        return $retry ? 'pending' : 'rejected';
    }

    /**
     * WP-Cron: the due rows, a batch at a time, never two runs at once (an option name is
     * unique, so adding it is the lock; a lock older than five minutes is a dead run's).
     * `$all` sends every pending row now (the status page's button).
     */
    public static function run_due(bool $all = false): int
    {
        global $wpdb;
        $held = get_option(self::LOCK);
        if ($held !== false && (int) $held > time() - 300) {
            return 0;
        }
        delete_option(self::LOCK);
        if (!add_option(self::LOCK, (string) time(), '', false)) {
            return 0;
        }
        $done = 0;
        try {
            $due = $all ? '' : $wpdb->prepare(' AND next_attempt_at <= %s', gmdate('Y-m-d H:i:s'));
            $rows = $wpdb->get_results(
                'SELECT id, idempotency_key, body, attempts FROM ' . self::table()
                . " WHERE status = 'pending'" . $due . ' ORDER BY id LIMIT ' . self::BATCH,
                ARRAY_A,
            );
            foreach ($rows ?: [] as $row) {
                if (self::attempt((int) $row['id'], (string) $row['idempotency_key'], (string) $row['body'], (int) $row['attempts']) === 'sent') {
                    $done++;
                }
            }
            $wpdb->query($wpdb->prepare(
                'DELETE FROM ' . self::table() . " WHERE status = 'sent' AND sent_at < %s",
                gmdate('Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS),
            ));
        } finally {
            delete_option(self::LOCK);
        }
        return $done;
    }

    /** @return array{pending: int, rejected: int, sent: int} */
    public static function counts(): array
    {
        global $wpdb;
        $counts = ['pending' => 0, 'rejected' => 0, 'sent' => 0];
        foreach ($wpdb->get_results('SELECT status, COUNT(*) AS n FROM ' . self::table() . ' GROUP BY status', ARRAY_A) ?: [] as $r) {
            $counts[(string) $r['status']] = (int) $r['n'];
        }
        return $counts;
    }

    /** @return list<array<string, mixed>> */
    public static function recent(int $limit = 50): array
    {
        global $wpdb;
        return $wpdb->get_results($wpdb->prepare(
            'SELECT id, body, status, attempts, last_code, created_at, next_attempt_at FROM ' . self::table() . ' ORDER BY id DESC LIMIT %d',
            $limit,
        ), ARRAY_A) ?: [];
    }
}
