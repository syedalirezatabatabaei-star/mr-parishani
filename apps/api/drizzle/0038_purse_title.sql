-- 0038 the purse's name on the patient's pages (task 4-7; doc 13: from configuration,
-- «کیف اعتبار» by default; doc 01: never «کیف پول»). Configuration data only: no table.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('wallet.purse_title', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('wallet.purse_title', 'global', '"کیف اعتبار"', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه، سند ۱۳ تسک ۴-۷ (مهاجرت 0038)', now());
