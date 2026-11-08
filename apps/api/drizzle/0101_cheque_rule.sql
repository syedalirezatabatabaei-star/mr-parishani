-- 0101 (owner 1405/07/29, ج۵ approved in round thirty-three). Add only: two configuration keys,
-- both 0 = off, changed by two people only. No table, no column, no ledger row. Summary:
-- docs/decisions/owner-plans-1405-07-27.md, «دور سی‌وسوم».
--
-- instrument.borrower_cheque_min_count: the borrower's checked cheques, at least this many.
-- instrument.guarantee_cheque_min_bps: each guarantor's checked cheques, at least this share of
--   the proforma's total (bps). The annex's launch values (1 and 11000) are set in the panel;
--   ops:launch-check item 17 warns while either is 0.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('instrument.borrower_cheque_min_count', 'business', true),
  ('instrument.guarantee_cheque_min_bps', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('instrument.borrower_cheque_min_count', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'قاعده چک خاموش تا تنظیم دونفره (مصوبه مالک ج۵، مهاجرت 0101)', now()),
  ('instrument.guarantee_cheque_min_bps', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'قاعده چک خاموش تا تنظیم دونفره (مصوبه مالک ج۵، مهاجرت 0101)', now());
