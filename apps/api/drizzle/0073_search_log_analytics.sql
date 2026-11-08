-- 0073 the search log and the data made ready for analysis (task 7-6; doc 17 §6, §7). Hand-
-- written (ADR-003). Expand only. Summary: docs/decisions/task-7-6-decisions.md.

-- === The public search's log (2-7 wrote it to the log stream only) =======================
-- What was asked and how fast, never the term itself (rule 30): which filters, their combination.
CREATE TABLE "search_query_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"audience" text NOT NULL,
	"order_by" text NOT NULL,
	"filters" text[] NOT NULL,
	-- The sorted filters joined by '+', or 'none': the combination's key.
	"filter_combo" text NOT NULL,
	"has_term" boolean NOT NULL,
	"page" integer NOT NULL,
	"page_size" integer NOT NULL,
	"total" integer NOT NULL,
	"returned" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_query_log_audience_check" CHECK ("audience" IN ('public')),
	CONSTRAINT "search_query_log_counts_check" CHECK ("page" >= 1 AND "page_size" >= 1
	  AND "total" >= 0 AND "returned" >= 0 AND "duration_ms" >= 0),
	CONSTRAINT "search_query_log_combo_check" CHECK (length("filter_combo") BETWEEN 1 AND 300)
);--> statement-breakpoint
CREATE INDEX "search_query_log_created_idx" ON "search_query_log" ("created_at");--> statement-breakpoint
CREATE INDEX "search_query_log_combo_idx" ON "search_query_log" ("filter_combo", "created_at");--> statement-breakpoint
CREATE TRIGGER search_query_log_append_only BEFORE UPDATE OR DELETE ON "search_query_log"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "search_query_log" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "search_query_log" TO sepehr_app;--> statement-breakpoint
GRANT SELECT ON "search_query_log" TO sepehr_report;--> statement-breakpoint
-- The index suggestions' sample EXPLAINs read the search index itself (public data).
GRANT SELECT ON "search_entries" TO sepehr_report;--> statement-breakpoint

-- === analytics: anonymized views on the reporting connection (doc 17 §7) ==================
-- Stable stand-in ids: md5 of a random key and the id. The key is made here, once, and only
-- the owner reads it; nobody else gets the raw id, a name, a mobile or a national id.
CREATE SCHEMA "analytics";--> statement-breakpoint
CREATE TABLE "analytics"."pseudonym_key" (
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "analytics"."pseudonym_key" ("key")
VALUES (md5(random()::text || clock_timestamp()::text || random()::text));--> statement-breakpoint
REVOKE ALL ON "analytics"."pseudonym_key" FROM PUBLIC;--> statement-breakpoint

CREATE VIEW "analytics"."cases" AS
SELECT md5(k.key || c.id::text) AS case_pid,
       md5(k.key || c.person_id::text) AS person_pid,
       c.status, c.queue_code, c.treatment_field_code, c.city_code, c.channel, c.is_returning,
       (date_trunc('month', c.created_at AT TIME ZONE 'Asia/Tehran'))::date AS created_month,
       (c.closed_at AT TIME ZONE 'Asia/Tehran')::date AS closed_day,
       c.abandonment_reason_code
FROM cases c CROSS JOIN analytics.pseudonym_key k
WHERE c.deleted_at IS NULL;--> statement-breakpoint

CREATE VIEW "analytics"."credit_applications" AS
SELECT md5(k.key || a.id::text) AS application_pid,
       md5(k.key || a.case_id::text) AS case_pid,
       md5(k.key || a.borrower_person_id::text) AS borrower_pid,
       a.status, a.plan_code, a.installment_count, a.loan_rial, a.down_payment_rial,
       a.plan_fee_rial, a.total_obligation_rial,
       (a.submitted_at AT TIME ZONE 'Asia/Tehran')::date AS submitted_day,
       r.final_outcome, r.grade, r.out_of_matrix,
       (r.sla_due_at IS NOT NULL AND r.sla_breached_at IS NULL) AS sla_met
FROM credit_applications a
CROSS JOIN analytics.pseudonym_key k
LEFT JOIN report_credit_applications r ON r.id = a.id
WHERE a.deleted_at IS NULL;--> statement-breakpoint

CREATE VIEW "analytics"."installments" AS
SELECT md5(k.key || s.installment_id::text) AS installment_pid,
       md5(k.key || s.schedule_id::text) AS schedule_pid,
       md5(k.key || s.case_id::text) AS case_pid,
       s.index, s.due_on, s.amount_rial, s.paid_rial, s.outstanding_rial, s.status,
       s.days_past_due, s.as_of
FROM installment_states s CROSS JOIN analytics.pseudonym_key k;--> statement-breakpoint

CREATE VIEW "analytics"."tickets" AS
SELECT md5(k.key || t.id::text) AS ticket_pid,
       md5(k.key || coalesce(t.requester_person_id, t.requester_account_id)::text) AS requester_pid,
       t.kind, t.topic_code, t.unit, t.status, t.requester_channel, t.response_hours,
       (t.created_at AT TIME ZONE 'Asia/Tehran')::date AS created_day,
       (t.resolved_at AT TIME ZONE 'Asia/Tehran')::date AS resolved_day,
       EXISTS (SELECT 1 FROM ticket_events e
               WHERE e.ticket_id = t.id AND e.kind = 'sla_breached') AS breached,
       t.reopened_count
FROM tickets t CROSS JOIN analytics.pseudonym_key k;--> statement-breakpoint

GRANT USAGE ON SCHEMA "analytics" TO sepehr_report;--> statement-breakpoint
GRANT SELECT ON "analytics"."cases", "analytics"."credit_applications",
  "analytics"."installments", "analytics"."tickets" TO sepehr_report;--> statement-breakpoint

-- === Permission: the search log's reports and suggestions (the system admin) ===============
INSERT INTO "permissions" ("code") VALUES ('reporting.read_search');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'reporting.read_search' FROM "roles" r
WHERE r.code = 'system_admin' AND r.deleted_at IS NULL;
