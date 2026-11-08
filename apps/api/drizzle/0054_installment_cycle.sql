-- 0054 the installment cycle (task 6-1 [financial]; doc 15 §3; ADR-019; owner 1405/07/15:
-- computed state and a materialized view, installments never changed). Hand-written
-- (ADR-003). Expand only: two new tables, a materialized view and a view, a configuration
-- key; no existing table, column or constraint changes.

-- === Grace days, locked on each schedule when it is made (rule 16) ========================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('repayment.grace_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('repayment.grace_days', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۲ (۰ روز)؛ مهاجرت 0054', now());--> statement-breakpoint
CREATE TABLE "installment_schedule_terms" (
	"schedule_id" uuid PRIMARY KEY NOT NULL REFERENCES "installment_schedules" ("id"),
	"grace_days" integer NOT NULL,
	"grace_config_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_schedule_terms_grace_check" CHECK ("grace_days" BETWEEN 0 AND 90)
);--> statement-breakpoint
CREATE TRIGGER installment_schedule_terms_append_only BEFORE UPDATE OR DELETE ON "installment_schedule_terms"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "installment_schedule_terms" FROM sepehr_app;--> statement-breakpoint
-- The schedules made before: the value in force for them, 0.
INSERT INTO "installment_schedule_terms" ("schedule_id", "grace_days", "grace_config_version_id")
SELECT s.id, 0, v.id
FROM "installment_schedules" s
CROSS JOIN (SELECT id FROM "config_values" WHERE "key" = 'repayment.grace_days' LIMIT 1) v;--> statement-breakpoint

-- === Each installment's event, once: due today, overdue from today ========================
CREATE TABLE "installment_cycle_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"installment_id" uuid NOT NULL REFERENCES "installments" ("id"),
	"kind" text NOT NULL,
	"as_of" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_cycle_events_kind_check" CHECK ("kind" IN ('due', 'overdue'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "installment_cycle_events_key" ON "installment_cycle_events" ("installment_id", "kind");--> statement-breakpoint
CREATE TRIGGER installment_cycle_events_append_only BEFORE UPDATE OR DELETE ON "installment_cycle_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "installment_cycle_events" FROM sepehr_app;--> statement-breakpoint

-- === Each installment's state as of the Tehran day of the last refresh ===================
-- The same rule as contracts' installmentState (a test keeps them equal): an amount from the
-- newest revision (4-8), what was allocated, the schedule's grace days.
CREATE MATERIALIZED VIEW "installment_states" AS
WITH base AS (
  SELECT i.id AS installment_id, i.schedule_id, s.case_id, i.index, i.due_on,
         coalesce((
           SELECT r.amount_rial FROM installment_revision_amounts r
           JOIN installment_schedule_revisions v ON v.id = r.revision_id
           WHERE r.installment_id = i.id
           ORDER BY v.revision_no DESC LIMIT 1
         ), i.amount_rial) AS amount_rial,
         coalesce((SELECT sum(a.amount_rial) FROM payment_allocations a
                   WHERE a.installment_id = i.id), 0)::bigint AS paid_rial,
         coalesce(t.grace_days, 0) AS grace_days,
         (now() AT TIME ZONE 'Asia/Tehran')::date AS as_of
  FROM installments i
  JOIN installment_schedules s ON s.id = i.schedule_id
  LEFT JOIN installment_schedule_terms t ON t.schedule_id = i.schedule_id
)
SELECT installment_id, schedule_id, case_id, index, due_on, amount_rial, paid_rial,
       greatest(amount_rial - paid_rial, 0) AS outstanding_rial, grace_days, as_of,
       CASE
         WHEN amount_rial = 0 AND paid_rial = 0 THEN 'cancelled'
         WHEN paid_rial >= amount_rial THEN 'paid'
         WHEN greatest(as_of - due_on, 0) > grace_days THEN 'overdue'
         WHEN paid_rial > 0 THEN 'partially_paid'
         WHEN as_of >= due_on THEN 'due'
         ELSE 'scheduled'
       END AS status,
       CASE WHEN paid_rial >= amount_rial THEN 0 ELSE greatest(as_of - due_on, 0) END
         AS days_past_due
FROM base
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "installment_states_key" ON "installment_states" ("installment_id");--> statement-breakpoint
CREATE INDEX "installment_states_case_idx" ON "installment_states" ("case_id");--> statement-breakpoint
CREATE INDEX "installment_states_status_idx" ON "installment_states" ("status", "due_on");--> statement-breakpoint
-- PostgreSQL 17: refreshing needs MAINTAIN; nothing else of the view is writable.
GRANT SELECT, MAINTAIN ON "installment_states" TO sepehr_app;--> statement-breakpoint

-- === Each case's worst lateness (the overdue queue of 6-7, reports) ======================
CREATE VIEW "case_overdue" AS
SELECT case_id, max(days_past_due) AS max_days_past_due,
       count(*) FILTER (WHERE status = 'overdue') AS overdue_installments,
       sum(outstanding_rial) FILTER (WHERE status = 'overdue') AS overdue_rial,
       max(as_of) AS as_of
FROM installment_states
GROUP BY case_id;--> statement-breakpoint
GRANT SELECT ON "case_overdue" TO sepehr_app;
