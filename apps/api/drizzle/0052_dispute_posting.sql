-- 0052 posting an accepted payable dispute (task 5-2b [financial]; ADR-038; owner
-- 1405/07/15). Hand-written (ADR-003). Three parts:
--   M1 (not add-only; asked separately): the dispute guard gains one path,
--      accepted_pending_posting → resolved_accepted.
--   M2 (not add-only; asked separately): a service authorization may be reversed once final:
--      the status 'reversed', its moment, and the guard's path finalized → reversed (final).
--   M3 (add-only): what each step of a posting made.
-- Every existing row stays valid under the new constraints; nothing is dropped but the two
-- CHECKs replaced by wider ones.

-- === M1: the dispute's new path ==========================================================
CREATE OR REPLACE FUNCTION public.financial_disputes_guard() RETURNS trigger
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
    (OLD.status = 'open' AND NEW.status IN ('resolved_accepted', 'resolved_rejected', 'accepted_pending_posting'))
    -- Task 5-2b: an accepted payable dispute, once its postings are made.
    OR (OLD.status = 'accepted_pending_posting' AND NEW.status = 'resolved_accepted')
  ) THEN
    RAISE EXCEPTION 'financial dispute % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- === M2: a final service taken back ======================================================
ALTER TABLE "service_authorizations" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_authorizations" DROP CONSTRAINT "service_authorizations_status_check";--> statement-breakpoint
ALTER TABLE "service_authorizations" ADD CONSTRAINT "service_authorizations_status_check"
  CHECK ("status" IN ('code_sent', 'delivered', 'finalized', 'expired', 'cancelled', 'reversed'));--> statement-breakpoint
ALTER TABLE "service_authorizations" DROP CONSTRAINT "service_authorizations_state_check";--> statement-breakpoint
ALTER TABLE "service_authorizations" ADD CONSTRAINT "service_authorizations_state_check" CHECK (
  ("status" = 'code_sent' AND "delivered_at" IS NULL AND "finalize_due_at" IS NULL
     AND "finalized_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'delivered' AND "delivered_at" IS NOT NULL AND "finalize_due_at" IS NOT NULL
     AND "register_operation_id" IS NOT NULL
     AND "finalized_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'finalized' AND "delivered_at" IS NOT NULL AND "finalized_at" IS NOT NULL
     AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'expired' AND "expired_at" IS NOT NULL AND "delivered_at" IS NULL
     AND "cancelled_at" IS NULL)
  OR ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "finalized_at" IS NULL
     AND "expired_at" IS NULL)
  -- Task 5-2b: what was final, and when it was taken back.
  OR ("status" = 'reversed' AND "delivered_at" IS NOT NULL AND "finalized_at" IS NOT NULL
     AND "reversed_at" IS NOT NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
);--> statement-breakpoint
ALTER TABLE "service_authorizations" ADD CONSTRAINT "service_authorizations_reversed_check"
  CHECK (("status" = 'reversed') = ("reversed_at" IS NOT NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.service_authorizations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'code_attempts', 'code_sends', 'delivered_at', 'register_operation_id',
    'finalize_due_at', 'finalized_at', 'expired_at', 'cancelled_at', 'cancelled_by',
    'cancel_reason', 'reversed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'service authorization % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'code_sent' AND NEW.status IN ('delivered', 'expired', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('finalized', 'cancelled'))
    -- Task 5-2b: only a final service, only taken back, once.
    OR (OLD.status = 'finalized' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION 'service authorization % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- A closed one changes no more; a final one only by being reversed.
  IF OLD.status IN ('expired', 'cancelled', 'reversed')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'service authorization % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'finalized'
     AND (to_jsonb(NEW) - ARRAY['status', 'reversed_at', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'reversed_at', 'updated_at']) THEN
    RAISE EXCEPTION 'service authorization % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code_attempts < OLD.code_attempts OR NEW.code_sends < OLD.code_sends THEN
    RAISE EXCEPTION 'service authorization % counters only grow', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
GRANT UPDATE ("reversed_at") ON "service_authorizations" TO sepehr_app;--> statement-breakpoint

-- === M3: what each step of a posting made (append-only) ==================================
CREATE TABLE "settlement_dispute_postings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"dispute_id" uuid NOT NULL REFERENCES "financial_disputes" ("id"),
	"step" text NOT NULL,
	"purse_operation_id" uuid,
	"journal_entry_id" uuid,
	"revision_id" uuid,
	"amount_rial" bigint,
	-- The refund step only: what of it went to the down payment refund, and to whom (4-6b
	-- counts it with the 4-8 cancellations).
	"down_payment_rial" bigint,
	"entity_id" text,
	"borrower_person_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_dispute_postings_step_check" CHECK ("step" IN (
	  'unfinalize', 'unregister', 'unreserve', 'fee', 'schedule', 'refund', 'service')),
	CONSTRAINT "settlement_dispute_postings_amount_check"
	  CHECK ("amount_rial" IS NULL OR "amount_rial" > 0),
	CONSTRAINT "settlement_dispute_postings_refund_check" CHECK (
	  ("step" = 'refund') = ("down_payment_rial" IS NOT NULL)
	  AND ("down_payment_rial" IS NULL OR ("down_payment_rial" >= 0
	       AND "entity_id" IS NOT NULL AND "borrower_person_id" IS NOT NULL))
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_dispute_postings_key" ON "settlement_dispute_postings" ("dispute_id", "step");--> statement-breakpoint
CREATE TRIGGER settlement_dispute_postings_append_only BEFORE UPDATE OR DELETE ON "settlement_dispute_postings"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "settlement_dispute_postings" FROM sepehr_app;
