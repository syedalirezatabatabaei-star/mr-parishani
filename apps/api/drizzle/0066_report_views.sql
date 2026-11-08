-- 0066 the version-one reports' materialized views (task 7-4; doc 17 §2; ADR-012). Hand-
-- written (ADR-003). Expand only: four materialized views, their refresh log, SELECT for the
-- read-only reporting role, six permissions. No table, function or row changes. The views are
-- refreshed by the worker as sepehr_app (MAINTAIN, as installment_states, 0054); a refresh
-- runs their query as their owner. Summary: docs/decisions/task-7-4-decisions.md.

-- === The ledger by account, event and Tehran day: every financial figure of the reports ======
-- Exactly the sums of ledger_entries (doc 17 §2 principle 4); the event a reversal reverses
-- tells a reversed finalization from any other.
CREATE MATERIALIZED VIEW "report_ledger_daily" AS
SELECT e.account_id, a.code, a.owner_type, a.owner_id, a.entity_id, j.event_type,
       r.event_type AS reversed_event_type,
       (j.occurred_at AT TIME ZONE 'Asia/Tehran')::date AS day,
       coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0)::bigint AS debit_rial,
       coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)::bigint AS credit_rial,
       count(*)::int AS entries
FROM ledger_entries e
JOIN ledger_accounts a ON a.id = e.account_id
JOIN journal_entries j ON j.id = e.journal_entry_id
LEFT JOIN journal_entries r ON r.id = j.reverses_journal_entry_id
GROUP BY e.account_id, a.code, a.owner_type, a.owner_id, a.entity_id, j.event_type, r.event_type,
         (j.occurred_at AT TIME ZONE 'Asia/Tehran')::date
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_ledger_daily_key" ON "report_ledger_daily"
  ("account_id", "event_type", "reversed_event_type", "day") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "report_ledger_daily_code_idx" ON "report_ledger_daily" ("code", "owner_type", "day");--> statement-breakpoint
CREATE INDEX "report_ledger_daily_owner_idx" ON "report_ledger_daily" ("owner_id", "code");--> statement-breakpoint

-- === Each stay of a case in a stage (the sales funnel) =======================================
CREATE MATERIALIZED VIEW "report_case_stages" AS
WITH changes AS (
  SELECT s.id, s.case_id, s.to_status AS stage, s.created_at AS entered_at,
         lead(s.created_at) OVER (PARTITION BY s.case_id ORDER BY s.created_at, s.id) AS left_at
  FROM case_status_changes s
), firsts AS (
  -- A case is `new` from its creation until its first change, unless a change says so.
  SELECT c.id, c.id AS case_id, 'new'::text AS stage, c.created_at AS entered_at,
         (SELECT min(s.created_at) FROM case_status_changes s WHERE s.case_id = c.id) AS left_at
  FROM cases c
  WHERE NOT EXISTS (
    SELECT 1 FROM case_status_changes s WHERE s.case_id = c.id AND s.to_status = 'new'
  )
)
SELECT x.id, x.case_id, x.stage, x.entered_at, x.left_at, c.channel, c.treatment_field_code,
       c.city_code, c.assignee_account_id, c.created_at AS case_created_at,
       c.abandonment_reason_code, c.status AS current_status
FROM (SELECT * FROM changes UNION ALL SELECT * FROM firsts) x
JOIN cases c ON c.id = x.case_id AND c.deleted_at IS NULL
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_case_stages_key" ON "report_case_stages" ("id");--> statement-breakpoint
CREATE INDEX "report_case_stages_created_idx" ON "report_case_stages" ("case_created_at", "stage");--> statement-breakpoint

-- === Each submitted credit application: its deadline, final decision and grade ===============
CREATE MATERIALIZED VIEW "report_credit_applications" AS
SELECT a.id, a.submitted_at, a.sla_due_at, a.sla_breached_at,
       (SELECT d.outcome FROM credit_decisions d
        WHERE d.credit_application_id = a.id AND d.status = 'decided' AND d.deleted_at IS NULL
        ORDER BY d.updated_at DESC, d.id DESC LIMIT 1) AS final_outcome,
       EXISTS (SELECT 1 FROM credit_decisions d
               WHERE d.credit_application_id = a.id AND d.status = 'decided'
                 AND d.out_of_matrix AND d.deleted_at IS NULL) AS out_of_matrix,
       (SELECT s.grade FROM score_sheets s
        WHERE s.credit_application_id = a.id AND s.subject = 'borrower'
          AND s.superseded_by IS NULL
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS grade
FROM credit_applications a
WHERE a.submitted_at IS NOT NULL AND a.deleted_at IS NULL
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_credit_applications_key" ON "report_credit_applications" ("id");--> statement-breakpoint
CREATE INDEX "report_credit_applications_submitted_idx" ON "report_credit_applications" ("submitted_at");--> statement-breakpoint

-- === Every assignment of every queue: cases, credit, collection and tickets ==================
CREATE MATERIALIZED VIEW "report_assignments" AS
SELECT ca.id, c.queue_code, ca.account_id, ca.kind = 'auto' AS auto, ca.created_at AS assigned_at,
       'case'::text AS item_kind, ca.case_id AS item_id,
       (SELECT min(s.created_at) FROM case_status_changes s
        WHERE s.case_id = ca.case_id AND s.created_at > ca.created_at) AS first_response_at,
       (c.closed_at IS NULL AND c.deleted_at IS NULL AND c.assignee_account_id = ca.account_id)
         AS open_now
FROM case_assignments ca JOIN cases c ON c.id = ca.case_id
WHERE ca.account_id IS NOT NULL
UNION ALL
SELECT x.id, x.queue_code, x.account_id, x.kind = 'auto', x.created_at, 'credit_application',
       x.credit_application_id, NULL::timestamptz,
       (a.status IN ('incomplete', 'ready_for_review', 'scoring', 'manual_review')
        AND NOT EXISTS (SELECT 1 FROM credit_application_assignments y
                        WHERE y.credit_application_id = x.credit_application_id
                          AND y.queue_code = x.queue_code AND y.created_at > x.created_at))
FROM credit_application_assignments x JOIN credit_applications a ON a.id = x.credit_application_id
WHERE x.account_id IS NOT NULL
UNION ALL
SELECT x.id, 'collection', x.account_id, x.kind = 'auto', x.created_at, 'collection_item',
       x.item_id, NULL::timestamptz,
       (i.closed_at IS NULL AND i.assignee_account_id = x.account_id)
FROM collection_assignments x JOIN collection_items i ON i.id = x.item_id
WHERE x.account_id IS NOT NULL
UNION ALL
SELECT e.id, 'ticket_' || t.unit, e.assignee_account_id, e.reason IS NULL, e.created_at, 'ticket',
       e.ticket_id,
       (SELECT min(m.created_at) FROM ticket_messages m
        WHERE m.ticket_id = e.ticket_id AND m.author_side = 'staff' AND m.visibility = 'public'
          AND m.author_account_id = e.assignee_account_id AND m.created_at >= e.created_at),
       (t.status NOT IN ('resolved', 'closed') AND t.assignee_account_id = e.assignee_account_id)
FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
WHERE e.kind = 'assigned' AND e.assignee_account_id IS NOT NULL
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_assignments_key" ON "report_assignments" ("id");--> statement-breakpoint
CREATE INDEX "report_assignments_queue_idx" ON "report_assignments" ("queue_code", "assigned_at");--> statement-breakpoint

-- PostgreSQL 17: refreshing needs MAINTAIN; nothing else of the views is writable.
GRANT SELECT, MAINTAIN ON "report_ledger_daily", "report_case_stages",
  "report_credit_applications", "report_assignments" TO sepehr_app;--> statement-breakpoint

-- === Each refresh, kept (the reports show how fresh they are) ===============================
CREATE TABLE "report_refreshes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"view_name" text NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_refreshes_view_check" CHECK ("view_name" ~ '^report_[a-z_]+$'),
	CONSTRAINT "report_refreshes_duration_check" CHECK ("duration_ms" >= 0)
);--> statement-breakpoint
CREATE INDEX "report_refreshes_view_idx" ON "report_refreshes" ("view_name", "refreshed_at");--> statement-breakpoint
CREATE TRIGGER report_refreshes_append_only BEFORE UPDATE OR DELETE ON "report_refreshes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "report_refreshes" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "report_refreshes" TO sepehr_app;--> statement-breakpoint
-- The views' first data, made just above.
INSERT INTO "report_refreshes" ("view_name", "refreshed_at", "duration_ms") VALUES
  ('report_ledger_daily', now(), 0), ('report_case_stages', now(), 0),
  ('report_credit_applications', now(), 0), ('report_assignments', now(), 0);--> statement-breakpoint

-- === What the reports read, for the read-only reporting role (ADR-012) ======================
GRANT SELECT ON "report_ledger_daily", "report_case_stages", "report_credit_applications",
  "report_assignments", "report_refreshes", "installment_states", "payment_promises",
  "collection_items", "credit_purses", "doctor_payables" TO sepehr_report;--> statement-breakpoint
GRANT SELECT ("id", "name", "kind", "path") ON "org_nodes" TO sepehr_report;--> statement-breakpoint

-- === Permissions: each report's audience (doc 17 §2) ========================================
INSERT INTO "permissions" ("code") VALUES
  ('reporting.read_sales'), ('reporting.read_credit'), ('reporting.read_settlement'),
  ('reporting.read_receivables'), ('reporting.read_agents'), ('reporting.read_wallet');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('ceo', 'reporting.read_sales'),
  ('strategy_manager', 'reporting.read_sales'),
  ('ceo', 'reporting.read_credit'),
  ('strategy_manager', 'reporting.read_credit'),
  ('credit_manager', 'reporting.read_credit'),
  ('ceo', 'reporting.read_settlement'),
  ('accounting', 'reporting.read_settlement'),
  ('ceo', 'reporting.read_receivables'),
  ('collection', 'reporting.read_receivables'),
  ('collection_manager', 'reporting.read_receivables'),
  ('ceo', 'reporting.read_agents'),
  ('strategy_manager', 'reporting.read_agents'),
  ('collection_manager', 'reporting.read_agents'),
  ('credit_manager', 'reporting.read_agents'),
  ('ceo', 'reporting.read_wallet'),
  ('accounting', 'reporting.read_wallet')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
