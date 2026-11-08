-- 0060 the collection module (task 6-7; doc 15 §5; owner 1405/07/16). Hand-written (ADR-003).
-- Expand only: six new tables, three configuration keys, eight permissions and one role. No
-- table of another module is touched; the collection module reads repayment, lead and credit
-- through their ports.

-- === The queue: one open item per overdue case ==========================================
CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignee_account_id" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_close_check"
	  CHECK (("closed_at" IS NULL) = ("close_reason" IS NULL)),
	CONSTRAINT "collection_items_reason_check"
	  CHECK ("close_reason" IS NULL OR "close_reason" IN ('cured', 'settled', 'cancelled'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_open_key" ON "collection_items" ("case_id")
  WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "collection_items_case_idx" ON "collection_items" ("case_id", "opened_at");--> statement-breakpoint
CREATE INDEX "collection_items_assignee_idx" ON "collection_items" ("assignee_account_id")
  WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE FUNCTION public.collection_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['assignee_account_id', 'closed_at', 'close_reason'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'collection item % keeps its case and opening', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'collection item % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER collection_items_guard BEFORE UPDATE ON "collection_items"
  FOR EACH ROW EXECUTE FUNCTION public.collection_items_guard();--> statement-breakpoint
CREATE TRIGGER collection_items_no_delete BEFORE DELETE ON "collection_items"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "collection_items" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "collection_items" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("assignee_account_id", "closed_at", "close_reason") ON "collection_items" TO sepehr_app;--> statement-breakpoint

-- === Who it went to, and why (append-only) ===============================================
CREATE TABLE "collection_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "collection_items" ("id"),
	"account_id" uuid,
	"kind" text NOT NULL,
	"weight_version_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_assignments_kind_check"
	  CHECK ("kind" IN ('auto', 'returning', 'manual', 'unassigned')),
	CONSTRAINT "collection_assignments_who_check"
	  CHECK (("kind" = 'unassigned') = ("account_id" IS NULL)),
	CONSTRAINT "collection_assignments_reason_check"
	  CHECK ("kind" <> 'manual' OR length("reason") BETWEEN 3 AND 1000)
);--> statement-breakpoint
CREATE INDEX "collection_assignments_item_idx" ON "collection_assignments" ("item_id", "created_at");--> statement-breakpoint
CREATE TRIGGER collection_assignments_append_only BEFORE UPDATE OR DELETE ON "collection_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "collection_assignments" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "collection_assignments" TO sepehr_app;--> statement-breakpoint

-- === Actions, recorded by hand (append-only; Issabel's call id and recording later, by
-- === nullable columns added then) ========================================================
CREATE TABLE "collection_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "collection_items" ("id"),
	"case_id" uuid NOT NULL,
	"actor_account_id" uuid,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"next_follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_actions_kind_check" CHECK ("kind" IN ('call', 'sms', 'visit', 'letter',
	  'guarantor_contact', 'legal_referral')),
	CONSTRAINT "collection_actions_outcome_check" CHECK (length("outcome") BETWEEN 2 AND 200)
);--> statement-breakpoint
CREATE INDEX "collection_actions_item_idx" ON "collection_actions" ("item_id", "occurred_at");--> statement-breakpoint
CREATE TRIGGER collection_actions_append_only BEFORE UPDATE OR DELETE ON "collection_actions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "collection_actions" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "collection_actions" TO sepehr_app;--> statement-breakpoint

-- === Payment promises: open, then kept, broken or cancelled, once =======================
CREATE TABLE "payment_promises" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "collection_items" ("id"),
	"case_id" uuid NOT NULL,
	"promised_amount_rial" bigint NOT NULL,
	"promised_on" date NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"evaluated_at" timestamp with time zone,
	"allocated_rial" bigint,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "payment_promises_amount_check" CHECK ("promised_amount_rial" > 0),
	CONSTRAINT "payment_promises_status_check"
	  CHECK ("status" IN ('open', 'kept', 'broken', 'cancelled')),
	CONSTRAINT "payment_promises_evaluated_check"
	  CHECK (("status" IN ('kept', 'broken')) = ("evaluated_at" IS NOT NULL AND "allocated_rial" IS NOT NULL)),
	CONSTRAINT "payment_promises_cancel_check"
	  CHECK (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "payment_promises_due_idx" ON "payment_promises" ("promised_on")
  WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "payment_promises_item_idx" ON "payment_promises" ("item_id");--> statement-breakpoint
CREATE FUNCTION public.payment_promises_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'evaluated_at', 'allocated_rial', 'cancelled_by',
    'cancel_reason'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'payment promise % keeps what was promised', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'payment promise % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payment_promises_guard BEFORE UPDATE ON "payment_promises"
  FOR EACH ROW EXECUTE FUNCTION public.payment_promises_guard();--> statement-breakpoint
CREATE TRIGGER payment_promises_no_delete BEFORE DELETE ON "payment_promises"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "payment_promises" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_promises" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "evaluated_at", "allocated_rial", "cancelled_by", "cancel_reason")
  ON "payment_promises" TO sepehr_app;--> statement-breakpoint

-- === Tasks: escalation only suggests (doc 15 §5); stage 3 and 4 by two people ============
CREATE TABLE "collection_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "collection_items" ("id"),
	"case_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"kind" text NOT NULL,
	"promise_id" uuid REFERENCES "payment_promises" ("id"),
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposed_by" uuid,
	"proposed_at" timestamp with time zone,
	"proposal_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "collection_tasks_stage_check" CHECK ("stage" BETWEEN 1 AND 4),
	CONSTRAINT "collection_tasks_kind_check" CHECK ("kind" IN ('call', 'guarantor_notice',
	  'suggest_cheque', 'legal_referral', 'promise_broken')),
	CONSTRAINT "collection_tasks_status_check"
	  CHECK ("status" IN ('open', 'proposed', 'done', 'dismissed')),
	CONSTRAINT "collection_tasks_promise_check"
	  CHECK (("kind" = 'promise_broken') = ("promise_id" IS NOT NULL)),
	CONSTRAINT "collection_tasks_decided_check"
	  CHECK (("status" IN ('done', 'dismissed')) = ("decided_at" IS NOT NULL AND "decision_note" IS NOT NULL)),
	-- Stage 3 and 4: proposed first, then decided by someone else (doc 15 §5; owner).
	CONSTRAINT "collection_tasks_two_person_check"
	  CHECK ("stage" < 3 OR "status" <> 'done'
	         OR ("proposed_by" IS NOT NULL AND "decided_by" IS NOT NULL
	             AND "decided_by" <> "proposed_by"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "collection_tasks_stage_key" ON "collection_tasks" ("item_id", "stage", "kind")
  WHERE "promise_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_tasks_promise_key" ON "collection_tasks" ("promise_id")
  WHERE "promise_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "collection_tasks_open_idx" ON "collection_tasks" ("item_id")
  WHERE "status" IN ('open', 'proposed');--> statement-breakpoint
CREATE FUNCTION public.collection_tasks_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'proposed_by', 'proposed_at', 'proposal_note',
    'decided_by', 'decided_at', 'decision_note'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'collection task % keeps what it is', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('proposed', 'done', 'dismissed'))
       OR (OLD.status = 'proposed' AND NEW.status IN ('done', 'dismissed'))) THEN
    RAISE EXCEPTION 'collection task % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER collection_tasks_guard BEFORE UPDATE ON "collection_tasks"
  FOR EACH ROW EXECUTE FUNCTION public.collection_tasks_guard();--> statement-breakpoint
CREATE TRIGGER collection_tasks_no_delete BEFORE DELETE ON "collection_tasks"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "collection_tasks" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "collection_tasks" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "proposed_by", "proposed_at", "proposal_note", "decided_by",
  "decided_at", "decision_note") ON "collection_tasks" TO sepehr_app;--> statement-breakpoint

-- === Deceased or disabled: with a document, approved by another person ==================
CREATE TABLE "borrower_status_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"evidence_key" text NOT NULL,
	"evidence_mime" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"note" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "borrower_status_events_kind_check"
	  CHECK ("kind" IN ('deceased', 'disabled', 'lifted')),
	CONSTRAINT "borrower_status_events_note_check" CHECK (length("note") BETWEEN 3 AND 1000),
	CONSTRAINT "borrower_status_events_approved_check"
	  CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL)),
	CONSTRAINT "borrower_status_events_two_person_check"
	  CHECK ("approved_by" IS NULL OR "approved_by" <> "proposed_by")
);--> statement-breakpoint
CREATE INDEX "borrower_status_events_person_idx" ON "borrower_status_events" ("person_id", "approved_at");--> statement-breakpoint
CREATE FUNCTION public.borrower_status_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['approved_by', 'approved_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'borrower status % keeps its proposal', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'borrower status % is already approved', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER borrower_status_events_guard BEFORE UPDATE ON "borrower_status_events"
  FOR EACH ROW EXECUTE FUNCTION public.borrower_status_events_guard();--> statement-breakpoint
CREATE TRIGGER borrower_status_events_no_delete BEFORE DELETE ON "borrower_status_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "borrower_status_events" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "borrower_status_events" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("approved_by", "approved_at") ON "borrower_status_events" TO sepehr_app;--> statement-breakpoint

-- === Configuration: every threshold and day in the panel (6.4; owner) ===================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('collection.buckets', 'business', true),
  ('collection.escalation_rules', 'business', true),
  ('collection.same_agent_for_returning', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('collection.buckets', 'global', '[1, 31, 61, 91]', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۴ (۱–۳۰، ۳۱–۶۰، ۶۱–۹۰، ۹۰+)؛ مهاجرت 0060', now()),
  ('collection.escalation_rules', 'global',
   '{"stage1": {"minDays": 1}, "stage2": {"minDays": 30, "minInstallments": 2}, "stage3": {"minDays": 60, "minInstallments": 3}}',
   '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۴ (جدول سند ۱۵ §۵)؛ مهاجرت 0060', now()),
  ('collection.same_agent_for_returning', 'global', 'false', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض خاموش (سند ۱۵ §۵: قابل روشن‌کردن)؛ مهاجرت 0060', now());--> statement-breakpoint

-- === Permissions and the collection manager's role (owner: only two powers) ==============
INSERT INTO "permissions" ("code") VALUES
  ('collection.read_queue'), ('collection.record_action'), ('collection.manage_promises'),
  ('collection.work_tasks'), ('collection.propose_borrower_status'),
  ('collection.approve_borrower_status'), ('collection.decide_escalation'),
  ('collection.assign');--> statement-breakpoint
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('collection_manager', 'مدیر واحد معوقات', true);--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('collection', 'collection.read_queue'),
  ('collection', 'collection.record_action'),
  ('collection', 'collection.manage_promises'),
  ('collection', 'collection.work_tasks'),
  ('collection', 'collection.propose_borrower_status'),
  ('collection_manager', 'collection.read_queue'),
  ('collection_manager', 'collection.approve_borrower_status'),
  ('collection_manager', 'collection.decide_escalation'),
  ('strategy_manager', 'collection.assign')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
