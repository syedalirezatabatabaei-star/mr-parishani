-- 0094 (owner 1405/07/27, ADR-046): a doctor's or center's contract term, 3, 6 or 12 months;
-- from its end no new service is recorded; a notice 30 days before. Add only: two config
-- keys (business, sensitive: two people) and their global values. Globally no term is
-- recorded, so nothing is blocked until a term is set for a center or doctor.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('settlement.provider_contract', 'business', true),
  ('settlement.provider_contract_warn_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('settlement.provider_contract', 'global', '{"startsOn": null, "months": null}',
   '2020-01-01T00:00:00Z', 'approved',
   'بی مدت ثبت‌شده: هیچ پزشک یا مرکزی مسدود نیست تا مدت قراردادش ثبت شود (ADR-046، مهاجرت 0094)', now()),
  ('settlement.provider_contract_warn_days', 'global', '30',
   '2020-01-01T00:00:00Z', 'approved', 'هشدار ۳۰ روز مانده به پایان، تصمیم مالک ۱۴۰۵/۰۷/۲۷ (ADR-046، مهاجرت 0094)', now());
