-- 0076 the internal panel closed by default (task 9-3, R10; owner 1405/07/18: VPN only, or the
-- office's address without a VPN, never left open). Hand-written (ADR-003). Add only: a new
-- version of the allow-list; the earlier one stays in its history.
-- Summary: docs/decisions/task-9-3-decisions.md (part 4).
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('access.internal_panel_ip_allowlist', 'global', '{"enabled": true, "cidrs": []}',
   now(), 'approved', 'پیش‌فرض بسته (R10، دستور مالک ۱۴۰۵/۰۷/۱۸؛ مهاجرت 0076)', now());
