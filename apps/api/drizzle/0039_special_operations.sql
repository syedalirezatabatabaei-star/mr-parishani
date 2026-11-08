-- 0039 special operations on a credit purse, part 1 (task 4-8 [financial]; doc 12 §7; owner
-- 1405/07/13). Hand-written (ADR-003). Expand only: three new tables and two permissions.
-- No change to any existing table: the purse moves through phase 1's cancel_unused (with an
-- amount, owner پ۱۵), and a schedule changes only by a new revision (owner ج), never UPDATE.

-- === Requests, decided by another person (doc 12 §7: two people for anything that moves money)
CREATE TABLE "purse_operation_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL REFERENCES "credit_purses" ("id"),
	"kind" text NOT NULL,
	-- What is asked (an amount as rial text); ids and amounts only (rule 30).
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	-- What was done: the wallet operation, the schedule revision, the split.
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purse_operation_requests_kind_check" CHECK ("kind" IN ('cancel_unused', 'reverse_cancel_unused')),
	CONSTRAINT "purse_operation_requests_status_check"
	  CHECK ("status" IN ('requested', 'approved', 'rejected')),
	CONSTRAINT "purse_operation_requests_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "purse_operation_requests_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "purse_operation_requests_decision_check" CHECK (
	  ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL AND "result" IS NULL)
	  OR ("status" = 'approved' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "result" IS NOT NULL)
	  OR ("status" = 'rejected' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "decision_reason" IS NOT NULL AND "result" IS NULL)
	)
);--> statement-breakpoint
-- One open request per purse: two at once would race for the same balance.
CREATE UNIQUE INDEX "purse_operation_requests_open_key" ON "purse_operation_requests" ("purse_id")
  WHERE "status" = 'requested';--> statement-breakpoint
-- A cancellation is reversed once: one live reversal request per cancellation.
CREATE UNIQUE INDEX "purse_operation_requests_reversal_key" ON "purse_operation_requests" (("payload" ->> 'requestId'))
  WHERE "kind" = 'reverse_cancel_unused' AND "status" IN ('requested', 'approved');--> statement-breakpoint
CREATE INDEX "purse_operation_requests_status_idx"
  ON "purse_operation_requests" ("status", "requested_at");--> statement-breakpoint
CREATE FUNCTION public.purse_operation_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason',
                                 'result', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'purse operation request % can only be decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'purse operation request % was decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER purse_operation_requests_guard BEFORE UPDATE ON "purse_operation_requests"
  FOR EACH ROW EXECUTE FUNCTION public.purse_operation_requests_guard();--> statement-breakpoint
CREATE TRIGGER purse_operation_requests_set_updated_at BEFORE UPDATE ON "purse_operation_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER purse_operation_requests_no_delete BEFORE DELETE ON "purse_operation_requests"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "purse_operation_requests" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "result", "updated_at")
  ON "purse_operation_requests" TO sepehr_app;--> statement-breakpoint

-- === Schedule revisions: a schedule changes only by a new revision (owner ج) ===============
-- An installment's amount is its newest revision's, else its own; installments and the
-- schedule row are never updated (their append-only triggers stay).
CREATE TABLE "installment_schedule_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_id" uuid NOT NULL REFERENCES "installment_schedules" ("id"),
	"revision_no" integer NOT NULL,
	"reason" text NOT NULL,
	-- The schedule total's change: negative for a reduction, positive for one reversed.
	"change_rial" bigint NOT NULL,
	-- A revision that undoes another (a reversed cancellation), once.
	"reverts_revision_id" uuid REFERENCES "installment_schedule_revisions" ("id"),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_schedule_revisions_no_check" CHECK ("revision_no" >= 1),
	CONSTRAINT "installment_schedule_revisions_change_check" CHECK ("change_rial" <> 0),
	CONSTRAINT "installment_schedule_revisions_reason_check" CHECK (length(trim("reason")) >= 3)
);--> statement-breakpoint
CREATE UNIQUE INDEX "installment_schedule_revisions_no_key"
  ON "installment_schedule_revisions" ("schedule_id", "revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_schedule_revisions_reverts_key"
  ON "installment_schedule_revisions" ("reverts_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_schedule_revisions_key_key"
  ON "installment_schedule_revisions" ("idempotency_key");--> statement-breakpoint
CREATE TRIGGER installment_schedule_revisions_append_only
  BEFORE UPDATE OR DELETE ON "installment_schedule_revisions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "installment_schedule_revisions" FROM sepehr_app;--> statement-breakpoint

CREATE TABLE "installment_revision_amounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"revision_id" uuid NOT NULL REFERENCES "installment_schedule_revisions" ("id"),
	"installment_id" uuid NOT NULL REFERENCES "installments" ("id"),
	"from_rial" bigint NOT NULL,
	"amount_rial" bigint NOT NULL,
	CONSTRAINT "installment_revision_amounts_check"
	  CHECK ("amount_rial" >= 0 AND "from_rial" >= 0 AND "amount_rial" <> "from_rial")
);--> statement-breakpoint
CREATE UNIQUE INDEX "installment_revision_amounts_key"
  ON "installment_revision_amounts" ("revision_id", "installment_id");--> statement-breakpoint
CREATE INDEX "installment_revision_amounts_installment_idx"
  ON "installment_revision_amounts" ("installment_id");--> statement-breakpoint
CREATE TRIGGER installment_revision_amounts_append_only
  BEFORE UPDATE OR DELETE ON "installment_revision_amounts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "installment_revision_amounts" FROM sepehr_app;--> statement-breakpoint

-- === Permissions: finance asks, another person in finance decides =========================
INSERT INTO "permissions" ("code") VALUES
  ('wallet.request_special_operation'), ('wallet.approve_special_operation');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'wallet.request_special_operation'),
  ('accounting', 'wallet.approve_special_operation')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
