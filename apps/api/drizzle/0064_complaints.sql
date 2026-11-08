-- 0064 complaints and the financial hold (task 7-2 [financial]; doc 17 §1; owner ج۱–ج۴,
-- 1405/07/16). Hand-written (ADR-003). Only the ticket module's own tables of 0063 change:
-- two columns, wider checks (ج۱) and one more step of the guard; one new append-only table.
-- No financial table is changed: financial_disputes is only read, each of its rows copied once
-- into a complaint and left as it is (ج۲). Summary: docs/decisions/task-7-2-decisions.md.

-- === Tickets: complaints, the internal channel, the dispute and the respondent ==============
ALTER TABLE "tickets" ADD COLUMN "financial_dispute_id" uuid;--> statement-breakpoint
-- The workplace a complaint about a doctor is about: whose panel sees it (doc 17 §1).
ALTER TABLE "tickets" ADD COLUMN "respondent_node_path" ltree;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_financial_dispute_key" ON "tickets" ("financial_dispute_id")
  WHERE "financial_dispute_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_respondent_path_idx" ON "tickets" USING gist ("respondent_node_path");--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_kind_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_kind_check"
  CHECK ("kind" IN ('ticket', 'complaint'));--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_source_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_check" CHECK (("source" IS NULL) = ("source_id" IS NULL)
  AND ("source" IS NULL OR "source" IN ('proforma_dispute', 'financial_dispute')));--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_channel_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_channel_check" CHECK (
  ("requester_channel" = 'patient' AND "requester_person_id" IS NOT NULL
     AND "requester_node_id" IS NULL AND "requester_node_path" IS NULL)
  OR ("requester_channel" = 'center' AND "requester_account_id" IS NOT NULL
     AND "requester_node_id" IS NOT NULL AND "requester_node_path" IS NOT NULL
     AND "requester_person_id" IS NULL)
  OR ("requester_channel" = 'staff' AND "requester_person_id" IS NOT NULL
     AND "opened_by" IS NOT NULL AND "requester_node_id" IS NULL)
  -- Staff for nobody outside: 5-2's disputes from before tickets (task 7-2).
  OR ("requester_channel" = 'internal' AND "requester_person_id" IS NULL
     AND "requester_node_id" IS NULL AND "requester_node_path" IS NULL)
);--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_dispute_check"
  CHECK ("financial_dispute_id" IS NULL OR "kind" = 'complaint');--> statement-breakpoint

-- As 0063, and one more step: open → resolved, a financial complaint whose dispute was decided
-- before anyone took it (the decision is accounting's, task 5-2).
CREATE OR REPLACE FUNCTION public.tickets_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'assignee_account_id', 'unit', 'due_at',
    'paused_at', 'resolved_at', 'closed_at', 'reopened_count'];
  live constant text[] := ARRAY['open', 'assigned', 'in_progress', 'waiting_on_requester',
    'reopened'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket % is never deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'ticket % keeps what was asked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reopened_count < OLD.reopened_count THEN
    RAISE EXCEPTION 'ticket % reopen count only grows', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status = ANY (live) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ticket % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.status = 'open' AND NEW.status IN ('assigned', 'resolved'))
     OR (OLD.status = 'assigned' AND NEW.status IN ('in_progress', 'resolved'))
     OR (OLD.status = 'in_progress' AND NEW.status IN ('waiting_on_requester', 'resolved'))
     OR (OLD.status = 'waiting_on_requester' AND NEW.status IN ('in_progress', 'resolved'))
     OR (OLD.status = 'resolved' AND NEW.status IN ('closed', 'reopened'))
     OR (OLD.status = 'reopened' AND NEW.status IN ('in_progress', 'resolved'))
     OR (OLD.status = ANY (live) AND NEW.status = 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ticket % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END
$$;--> statement-breakpoint

-- === Links: a doctor's settlement items ====================================================
ALTER TABLE "ticket_links" DROP CONSTRAINT "ticket_links_type_check";--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_type_check" CHECK ("entity_type" IN
  ('appointment', 'proforma', 'service', 'installment', 'payment', 'statement',
   'doctor_payable', 'service_fee'));--> statement-breakpoint

-- === Messages: the doctor's answer; what tells of the treatment ===========================
ALTER TABLE "ticket_messages" ADD COLUMN "contains_treatment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_side_check";--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_side_check"
  CHECK ("author_side" IN ('requester', 'staff', 'respondent'));--> statement-breakpoint

-- Staff marking a message as telling of the treatment after it was written (the message
-- itself never changes): hidden from the collection unit from then on (doc 17 §1).
CREATE TABLE "ticket_message_flags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets" ("id"),
	"message_id" uuid NOT NULL REFERENCES "ticket_messages" ("id"),
	"reason" text NOT NULL,
	"flagged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_message_flags_reason_check" CHECK (length("reason") BETWEEN 3 AND 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_message_flags_key" ON "ticket_message_flags" ("message_id");--> statement-breakpoint
CREATE INDEX "ticket_message_flags_ticket_idx" ON "ticket_message_flags" ("ticket_id");--> statement-breakpoint
CREATE TRIGGER ticket_message_flags_append_only BEFORE UPDATE OR DELETE ON "ticket_message_flags"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_message_flags" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ticket_message_flags" TO sepehr_app;--> statement-breakpoint

-- === Configuration: the complaint topics, added to the topics in force (deadlines 0) =======
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at")
SELECT 'ticket.topics', 'global',
  (SELECT jsonb_agg(t) FROM jsonb_array_elements(v.value) t
    WHERE t->>'code' NOT IN ('complaint_financial', 'complaint_doctor', 'complaint_general'))
  || '[{"code": "complaint_financial", "title": "شکایت مالی", "unit": "accounting", "responseHours": 0, "active": true, "kind": "complaint", "financial": true},
       {"code": "complaint_doctor", "title": "شکایت از پزشک", "unit": "support", "responseHours": 0, "active": true, "kind": "complaint", "financial": false},
       {"code": "complaint_general", "title": "شکایت", "unit": "support", "responseHours": 0, "active": true, "kind": "complaint", "financial": false}]'::jsonb,
  now(), 'approved', 'موضوع‌های شکایت ۷-۲؛ مهلت‌ها ۰ تا تعیین؛ مهاجرت 0064', now()
FROM (
  SELECT value FROM config_values
  WHERE key = 'ticket.topics' AND status = 'approved' AND scope_level = 'global'
  ORDER BY effective_at DESC, created_at DESC LIMIT 1
) v;--> statement-breakpoint

-- === Permission: the doctor answers a complaint about them =================================
INSERT INTO "permissions" ("code") VALUES ('ticket.respond');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES ('doctor', 'ticket.respond'), ('secretary', 'ticket.respond'))
  AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Task 5-2's disputes, each once into a financial complaint (kept as they are, ج۲) ======
INSERT INTO "tickets" ("kind", "topic_code", "unit", "subject", "requester_channel",
  "requester_account_id", "opened_by", "status", "response_hours", "config_version_id",
  "resolved_at", "source", "source_id", "financial_dispute_id", "created_at")
SELECT 'complaint', 'complaint_financial', 'accounting', 'اختلاف مالی (پیش از ۷-۲)', 'internal',
  d.opened_by, d.opened_by, CASE WHEN d.status = 'open' THEN 'open' ELSE 'resolved' END, 0,
  (SELECT v.id FROM config_values v WHERE v.key = 'ticket.topics' AND v.status = 'approved'
   ORDER BY v.effective_at DESC, v.created_at DESC LIMIT 1),
  CASE WHEN d.status = 'open' THEN NULL ELSE d.resolved_at END,
  'financial_dispute', d.id, d.id, d.opened_at
FROM financial_disputes d
WHERE d.ticket_id IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "ticket_messages" ("ticket_id", "author_account_id", "author_side", "visibility",
  "body", "created_at")
SELECT t.id, d.opened_by, 'requester', 'public', left(d.reason, 4000), d.opened_at
FROM tickets t JOIN financial_disputes d ON d.id = t.financial_dispute_id
WHERE t.source = 'financial_dispute'
  AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id);--> statement-breakpoint
INSERT INTO "ticket_links" ("ticket_id", "entity_type", "entity_id", "label", "created_at")
SELECT t.id, d.subject_type, d.subject_id,
  CASE WHEN d.subject_type = 'doctor_payable' THEN 'بدهی به پزشک' ELSE 'کارمزد خدمت' END,
  d.opened_at
FROM tickets t JOIN financial_disputes d ON d.id = t.financial_dispute_id
WHERE t.source = 'financial_dispute'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "ticket_events" ("ticket_id", "kind", "to_status", "to_unit", "reason", "created_at")
SELECT t.id, 'opened', t.status, 'accounting', 'از financial_disputes (۵-۲)؛ مهاجرت 0064',
  t.created_at
FROM tickets t
WHERE t.source = 'financial_dispute'
  AND NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id);
