-- 0063 the ticket module (task 7-1; doc 17 §1). Hand-written (ADR-003), like 0060.
-- Expand only: five new tables of the ticket module, a sequence, three configuration keys,
-- five permissions and their grants. No table of another module is changed: the proforma
-- disputes of task 3-4 (support_requests) are only read, each copied once into a ticket and
-- kept as they are (rule 7). Plan and summary: docs/decisions/task-7-1-decisions.md.

CREATE SEQUENCE "ticket_number_seq" AS bigint START 1000;--> statement-breakpoint

-- === Tickets ================================================================================
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" bigint DEFAULT nextval('ticket_number_seq') NOT NULL,
	"kind" text DEFAULT 'ticket' NOT NULL,
	"topic_code" text NOT NULL,
	"unit" text NOT NULL,
	"subject" text NOT NULL,
	"requester_channel" text NOT NULL,
	"requester_account_id" uuid,
	"requester_person_id" uuid,
	"requester_node_id" uuid,
	"requester_node_path" ltree,
	"opened_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_account_id" uuid,
	-- The topic's deadline when opened, and the configuration version it came from (rule 16).
	"response_hours" integer NOT NULL,
	"config_version_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"source" text,
	"source_id" uuid,
	"legacy_support_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_kind_check" CHECK ("kind" IN ('ticket')),
	CONSTRAINT "tickets_status_check" CHECK ("status" IN ('open', 'assigned', 'in_progress',
	  'waiting_on_requester', 'resolved', 'closed', 'reopened')),
	CONSTRAINT "tickets_subject_check" CHECK (length("subject") BETWEEN 3 AND 200),
	CONSTRAINT "tickets_hours_check" CHECK ("response_hours" BETWEEN 0 AND 8760),
	CONSTRAINT "tickets_due_check" CHECK (("response_hours" = 0) = ("due_at" IS NULL)),
	CONSTRAINT "tickets_reopened_check" CHECK ("reopened_count" >= 0),
	-- Who asked: a patient (their person), a center (a node of the opener's scope), or staff
	-- for a caller (the caller's person, and who opened it).
	CONSTRAINT "tickets_channel_check" CHECK (
	  ("requester_channel" = 'patient' AND "requester_person_id" IS NOT NULL
	     AND "requester_node_id" IS NULL AND "requester_node_path" IS NULL)
	  OR ("requester_channel" = 'center' AND "requester_account_id" IS NOT NULL
	     AND "requester_node_id" IS NOT NULL AND "requester_node_path" IS NOT NULL
	     AND "requester_person_id" IS NULL)
	  OR ("requester_channel" = 'staff' AND "requester_person_id" IS NOT NULL
	     AND "opened_by" IS NOT NULL AND "requester_node_id" IS NULL)
	),
	-- Unassigned exactly while open; worked by someone otherwise (until resolved).
	CONSTRAINT "tickets_assignee_check" CHECK (
	  ("status" = 'open') = ("assignee_account_id" IS NULL)
	  OR "status" IN ('resolved', 'closed')
	),
	CONSTRAINT "tickets_paused_check" CHECK ("paused_at" IS NULL
	  OR ("status" = 'waiting_on_requester' AND "due_at" IS NOT NULL)),
	CONSTRAINT "tickets_resolved_check"
	  CHECK (("status" IN ('resolved', 'closed')) = ("resolved_at" IS NOT NULL)),
	CONSTRAINT "tickets_closed_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
	CONSTRAINT "tickets_source_check" CHECK (("source" IS NULL) = ("source_id" IS NULL)
	  AND ("source" IS NULL OR "source" IN ('proforma_dispute')))
);--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets" ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_source_key" ON "tickets" ("source", "source_id")
  WHERE "source" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_legacy_key" ON "tickets" ("legacy_support_request_id")
  WHERE "legacy_support_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_unit_status_idx" ON "tickets" ("unit", "status", "created_at");--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "tickets" ("assignee_account_id")
  WHERE "status" NOT IN ('resolved', 'closed');--> statement-breakpoint
CREATE INDEX "tickets_person_idx" ON "tickets" ("requester_person_id", "created_at");--> statement-breakpoint
CREATE INDEX "tickets_account_idx" ON "tickets" ("requester_account_id", "created_at");--> statement-breakpoint
CREATE INDEX "tickets_node_path_idx" ON "tickets" USING gist ("requester_node_path");--> statement-breakpoint
CREATE INDEX "tickets_due_idx" ON "tickets" ("due_at")
  WHERE "status" NOT IN ('resolved', 'closed') AND "due_at" IS NOT NULL;--> statement-breakpoint

-- Only its state changes, and only along the ticket's life (rule 8; doc 17 §1):
-- open → assigned; assigned → in_progress | resolved; in_progress → waiting_on_requester |
-- resolved; waiting_on_requester → in_progress | resolved; resolved → closed | reopened;
-- reopened → in_progress | resolved; any live status → open (a transfer to another unit);
-- a live status to itself (another assignee, the deadline moved). Closed is final.
CREATE FUNCTION public.tickets_guard() RETURNS trigger
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
  IF (OLD.status = 'open' AND NEW.status = 'assigned')
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
CREATE TRIGGER tickets_guard BEFORE UPDATE OR DELETE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION public.tickets_guard();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "tickets" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "tickets" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "assignee_account_id", "unit", "due_at", "paused_at", "resolved_at",
  "closed_at", "reopened_count") ON "tickets" TO sepehr_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "ticket_number_seq" TO sepehr_app;--> statement-breakpoint

-- === Links: what the requester may reach, checked by the owning module ====================
CREATE TABLE "ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets" ("id"),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_links_type_check" CHECK ("entity_type" IN ('appointment', 'proforma',
	  'service', 'installment', 'payment', 'statement')),
	CONSTRAINT "ticket_links_label_check" CHECK (length("label") BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_key" ON "ticket_links" ("ticket_id", "entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX "ticket_links_entity_idx" ON "ticket_links" ("entity_type", "entity_id");--> statement-breakpoint
CREATE TRIGGER ticket_links_append_only BEFORE UPDATE OR DELETE ON "ticket_links"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_links" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ticket_links" TO sepehr_app;--> statement-breakpoint

-- === The conversation: internal notes only staff write and see (test 3) ====================
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets" ("id"),
	"author_account_id" uuid,
	"author_side" text NOT NULL,
	"visibility" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_side_check" CHECK ("author_side" IN ('requester', 'staff')),
	CONSTRAINT "ticket_messages_visibility_check" CHECK ("visibility" IN ('public', 'internal')
	  AND ("author_side" = 'staff' OR "visibility" = 'public')),
	CONSTRAINT "ticket_messages_body_check" CHECK (length("body") BETWEEN 1 AND 4000)
);--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" ("ticket_id", "created_at");--> statement-breakpoint
CREATE TRIGGER ticket_messages_append_only BEFORE UPDATE OR DELETE ON "ticket_messages"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_messages" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ticket_messages" TO sepehr_app;--> statement-breakpoint

-- === Attachments: private space, scanned, real type (task 2-8) ============================
CREATE TABLE "ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets" ("id"),
	"message_id" uuid REFERENCES "ticket_messages" ("id"),
	"visibility" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	-- Marked by whoever added it; hidden from the collection unit (doc 17 §1; task 7-2).
	"contains_treatment" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid,
	"uploader_side" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_attachments_side_check" CHECK ("uploader_side" IN ('requester', 'staff')),
	CONSTRAINT "ticket_attachments_visibility_check" CHECK ("visibility" IN ('public', 'internal')
	  AND ("uploader_side" = 'staff' OR "visibility" = 'public')),
	CONSTRAINT "ticket_attachments_size_check" CHECK ("size_bytes" > 0),
	CONSTRAINT "ticket_attachments_type_check"
	  CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_attachments_key" ON "ticket_attachments" ("object_key");--> statement-breakpoint
CREATE INDEX "ticket_attachments_ticket_idx" ON "ticket_attachments" ("ticket_id", "created_at");--> statement-breakpoint
CREATE TRIGGER ticket_attachments_append_only BEFORE UPDATE OR DELETE ON "ticket_attachments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_attachments" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ticket_attachments" TO sepehr_app;--> statement-breakpoint

-- === History: every change of state, assignment and unit, and each deadline alert once =====
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets" ("id"),
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_unit" text,
	"to_unit" text,
	"assignee_account_id" uuid,
	"reason" text,
	"due_at" timestamp with time zone,
	"actor_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_kind_check" CHECK ("kind" IN ('opened', 'assigned', 'status',
	  'transferred', 'sla_warning', 'sla_breached')),
	CONSTRAINT "ticket_events_transfer_check" CHECK ("kind" <> 'transferred'
	  OR ("from_unit" IS NOT NULL AND "to_unit" IS NOT NULL AND "reason" IS NOT NULL)),
	CONSTRAINT "ticket_events_sla_check"
	  CHECK (("kind" IN ('sla_warning', 'sla_breached')) = ("due_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" ("ticket_id", "created_at");--> statement-breakpoint
-- Each alert once per deadline: a moved deadline (paused while waiting) may warn again.
CREATE UNIQUE INDEX "ticket_events_sla_key" ON "ticket_events" ("ticket_id", "kind", "due_at")
  WHERE "kind" IN ('sla_warning', 'sla_breached');--> statement-breakpoint
CREATE TRIGGER ticket_events_append_only BEFORE UPDATE OR DELETE ON "ticket_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_events" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ticket_events" TO sepehr_app;--> statement-breakpoint

-- === Configuration (CLAUDE.md §4: every number 0 or off at first) ==========================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('ticket.topics', 'business', true),
  ('ticket.reopen_days', 'business', true),
  ('ticket.sla_warning_minutes', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('ticket.topics', 'global',
   '[{"code": "general", "title": "پرسش عمومی", "unit": "support", "responseHours": 0, "active": true},
     {"code": "appointment", "title": "نوبت", "unit": "support", "responseHours": 0, "active": true},
     {"code": "proforma_dispute", "title": "اعتراض به پیش‌فاکتور", "unit": "support", "responseHours": 0, "active": true},
     {"code": "service", "title": "خدمت", "unit": "support", "responseHours": 0, "active": true},
     {"code": "installment", "title": "قسط", "unit": "collection", "responseHours": 0, "active": true},
     {"code": "payment", "title": "فیش و پرداخت", "unit": "accounting", "responseHours": 0, "active": true},
     {"code": "statement", "title": "صورت‌وضعیت", "unit": "accounting", "responseHours": 0, "active": true}]',
   '2020-01-01T00:00:00Z', 'approved',
   'فهرست آغازین ۷-۱ (ت۷)؛ مهلت‌ها ۰ تا تعیین (۷.۵: ۲۴ ساعت)؛ مهاجرت 0063', now()),
  ('ticket.reopen_days', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'خاموش تا تعیین (۷.۴: ۷ روز؛ CLAUDE.md §۴)؛ مهاجرت 0063', now()),
  ('ticket.sla_warning_minutes', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'خاموش تا تعیین (CLAUDE.md §۴)؛ هشدار پس از مهلت همیشه هست؛ مهاجرت 0063', now());--> statement-breakpoint

-- === Permissions and grants (task 7-1 decision ت۹) =========================================
INSERT INTO "permissions" ("code") VALUES
  ('ticket.open_center'), ('ticket.open_on_behalf'), ('ticket.work'), ('ticket.assign'),
  ('ticket.read_all');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('center_manager', 'ticket.open_center'),
  ('doctor', 'ticket.open_center'),
  ('secretary', 'ticket.open_center'),
  ('support', 'ticket.open_on_behalf'),
  ('advisor', 'ticket.open_on_behalf'),
  ('support', 'ticket.work'),
  ('collection', 'ticket.work'),
  ('accounting', 'ticket.work'),
  ('network_specialist', 'ticket.work'),
  ('case_completion', 'ticket.work'),
  ('credit_specialist', 'ticket.work'),
  ('advisor', 'ticket.work'),
  ('strategy_manager', 'ticket.assign'),
  ('collection_manager', 'ticket.assign'),
  ('credit_manager', 'ticket.assign'),
  ('system_admin', 'ticket.assign'),
  ('ceo', 'ticket.read_all'),
  ('auditor', 'ticket.read_all')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Task 3-4's proforma disputes, each once into a ticket (kept as they are) ==============
INSERT INTO "tickets" ("topic_code", "unit", "subject", "requester_channel",
  "requester_account_id", "requester_person_id", "opened_by", "status", "response_hours",
  "config_version_id", "source", "source_id", "legacy_support_request_id", "created_at")
SELECT 'proforma_dispute', 'support', 'اعتراض به پیش‌فاکتور', 'patient', s.account_id,
  s.person_id, s.account_id, 'open', 0,
  (SELECT v.id FROM config_values v WHERE v.key = 'ticket.topics' AND v.status = 'approved'
   ORDER BY v.created_at LIMIT 1),
  'proforma_dispute', s.subject_id, s.id, s.created_at
FROM support_requests s
WHERE s.subject_type = 'proforma'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "ticket_messages" ("ticket_id", "author_account_id", "author_side", "visibility",
  "body", "created_at")
SELECT t.id, s.account_id, 'requester', 'public', s.note, s.created_at
FROM tickets t JOIN support_requests s ON s.id = t.legacy_support_request_id
WHERE NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id);--> statement-breakpoint
INSERT INTO "ticket_links" ("ticket_id", "entity_type", "entity_id", "label", "created_at")
SELECT t.id, 'proforma', s.subject_id,
  'پیش‌فاکتور، نسخه ' || translate(p.version::text, '0123456789', '۰۱۲۳۴۵۶۷۸۹'), s.created_at
FROM tickets t
JOIN support_requests s ON s.id = t.legacy_support_request_id
JOIN proformas p ON p.id = s.subject_id
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "ticket_events" ("ticket_id", "kind", "to_status", "to_unit", "reason", "created_at")
SELECT t.id, 'opened', 'open', 'support', 'از support_requests (۳-۴)؛ مهاجرت 0063', t.created_at
FROM tickets t
WHERE t.legacy_support_request_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id);
