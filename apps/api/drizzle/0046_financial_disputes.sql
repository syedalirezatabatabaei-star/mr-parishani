-- 0046 financial disputes and holding an item (task 5-2 [financial]; doc 14 الف, 5-2; doc 06
-- §4, §8 test 4; doc 02 §8 test 7; owner 1405/07/14). Hand-written (ADR-003). Expand only:
-- two new tables and two permissions; no existing table, column or constraint changes.

-- === A dispute on a settlement item (settlement module) ===================================
-- Accepted on a fee: its document reversed whole, the fee reversed. Accepted on a doctor's
-- payable: accepted_pending_posting only (owner, option ب): the items stay held, out of
-- every payment, and nothing is posted until task 5-2b (after 5-4).
CREATE TABLE "financial_disputes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	-- An accepted fee's reversing document.
	"correction_journal_entry_id" uuid,
	-- Phase 7 links a ticket here (doc 17).
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_disputes_subject_check"
	  CHECK ("subject_type" IN ('doctor_payable', 'service_fee')),
	CONSTRAINT "financial_disputes_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "financial_disputes_status_check" CHECK ("status" IN
	  ('open', 'resolved_accepted', 'resolved_rejected', 'accepted_pending_posting')),
	-- Who opens it never decides it.
	CONSTRAINT "financial_disputes_two_people_check"
	  CHECK ("resolved_by" IS NULL OR "resolved_by" <> "opened_by"),
	CONSTRAINT "financial_disputes_resolution_check" CHECK (
	  ("status" = 'open' AND "resolved_by" IS NULL AND "resolved_at" IS NULL)
	  OR ("status" <> 'open' AND "resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL
	      AND "resolution_note" IS NOT NULL)
	),
	-- Only a fee is accepted with a document; a payable waits for 5-2b.
	CONSTRAINT "financial_disputes_correction_check" CHECK (
	  "correction_journal_entry_id" IS NULL
	  OR ("status" = 'resolved_accepted' AND "subject_type" = 'service_fee')
	),
	CONSTRAINT "financial_disputes_pending_check" CHECK (
	  "status" <> 'accepted_pending_posting' OR "subject_type" = 'doctor_payable'
	)
);--> statement-breakpoint
-- One dispute holding an item at a time (owner): open, or accepted and waiting for its posting.
CREATE UNIQUE INDEX "financial_disputes_live_key" ON "financial_disputes" ("subject_type", "subject_id")
  WHERE "status" IN ('open', 'accepted_pending_posting');--> statement-breakpoint
CREATE UNIQUE INDEX "financial_disputes_correction_key" ON "financial_disputes" ("correction_journal_entry_id");--> statement-breakpoint
CREATE INDEX "financial_disputes_status_idx" ON "financial_disputes" ("status", "opened_at");--> statement-breakpoint
CREATE FUNCTION public.financial_disputes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'resolved_by', 'resolved_at', 'resolution_note',
    'correction_journal_entry_id', 'ticket_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'financial dispute % keeps its subject and reason', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status = 'open' AND NEW.status IN ('resolved_accepted', 'resolved_rejected', 'accepted_pending_posting')
  ) THEN
    RAISE EXCEPTION 'financial dispute % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER financial_disputes_guard BEFORE UPDATE ON "financial_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.financial_disputes_guard();--> statement-breakpoint
CREATE TRIGGER financial_disputes_set_updated_at BEFORE UPDATE ON "financial_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER financial_disputes_no_delete BEFORE DELETE ON "financial_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "financial_disputes" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "resolved_by", "resolved_at", "resolution_note",
  "correction_journal_entry_id", "ticket_id", "updated_at") ON "financial_disputes" TO sepehr_app;--> statement-breakpoint

-- === What a dispute holds, and what each held item was before (append-only) ===============
-- The subject and its sibling of the same service: a payable and its fee are held together.
CREATE TABLE "financial_dispute_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"dispute_id" uuid NOT NULL REFERENCES "financial_disputes" ("id"),
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"held_from_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_dispute_items_type_check"
	  CHECK ("item_type" IN ('doctor_payable', 'service_fee')),
	CONSTRAINT "financial_dispute_items_from_check"
	  CHECK ("held_from_status" IN ('accrued', 'due', 'in_statement'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "financial_dispute_items_key" ON "financial_dispute_items" ("dispute_id", "item_type", "item_id");--> statement-breakpoint
CREATE INDEX "financial_dispute_items_item_idx" ON "financial_dispute_items" ("item_type", "item_id");--> statement-breakpoint
CREATE TRIGGER financial_dispute_items_append_only BEFORE UPDATE OR DELETE ON "financial_dispute_items"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "financial_dispute_items" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (doc 04: support and accounting open; accounting decides, another person) =
INSERT INTO "permissions" ("code") VALUES
  ('settlement.open_dispute'), ('settlement.resolve_dispute');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('support', 'settlement.open_dispute'),
  ('accounting', 'settlement.open_dispute'),
  ('accounting', 'settlement.resolve_dispute')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
