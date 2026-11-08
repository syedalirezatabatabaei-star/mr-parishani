-- 0075 a limit on every public endpoint, per client address (task 9-3, R5; ASVS 11.1.4).
-- Hand-written (ADR-003). Add only. Summary: docs/decisions/task-9-3-decisions.md.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('identity.public_rate_limit', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.public_rate_limit', 'global', '{"perIpPerMinute": 300}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0075)', now());
