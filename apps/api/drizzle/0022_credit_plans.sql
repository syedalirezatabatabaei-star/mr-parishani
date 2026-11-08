-- 0022 credit plans (task 3-3; doc 10 §3; ADR-006). Data only, expand only.
-- The plans are one versioned configuration key, defined by the strategy manager and
-- approved by a second person (sensitive); a case locks the version it chose (rule 16).
-- None until the client gives the pilot's plans (TODO(decision), task-3-3 decisions).
-- Whether a patient may ask for a smaller loan and pay the rest in cash: off.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.plans', 'business', true),
  ('credit.allow_patient_amount_reduction', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.plans', 'global', '{"plans": []}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: هنوز طرحی تعریف نشده (مهاجرت 0022)', now()),
  ('credit.allow_patient_amount_reduction', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۳ (مهاجرت 0022)', now());
