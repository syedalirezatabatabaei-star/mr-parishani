<?php
/**
 * Removing the plugin (not deactivating it) removes its queue, settings and schedule. A lead
 * still waiting is lost with it: the status page shows how many wait before you remove it.
 */

declare(strict_types=1);

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

global $wpdb;
$wpdb->query('DROP TABLE IF EXISTS ' . $wpdb->prefix . 'sepehr_lead_queue');
delete_option('sepehr_lead_form');
delete_option('sepehr_lead_fields_last_good');
delete_option('sepehr_lead_lock');
delete_transient('sepehr_lead_fields');
wp_clear_scheduled_hook('sepehr_lead_retry');
