-- 0096 (owner 1405/07/27, plan e): promissory notes are not taken. Add only: one config key
-- (business, sensitive: two people) and its value, off. Instruments recorded before stay as
-- they are, their legal referral too. No ledger row: an instrument posts nothing.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('instrument.promissory_enabled', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('instrument.promissory_enabled', 'global', 'false', '2020-01-01T00:00:00Z', 'approved',
   'سفته دریافت نمی‌شود، تصمیم مالک ۱۴۰۵/۰۷/۲۷ (نقشه ه، مهاجرت 0096)', now());
