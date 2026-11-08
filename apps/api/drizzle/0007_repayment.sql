-- 0007 repayment (task 1-3; doc 02 §4–5; ADR-019). Hand-written (ADR-003: explicit SQL in
-- financial modules); written only by the repayment module.

-- One schedule per case (purse), fixed at creation: the total obligation (principal plus
-- plan fee), the count, the funding instant and the rounding unit, with the configuration
-- version it came from (rule 16). Never edited.
CREATE TABLE "installment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"purse_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"principal_rial" bigint NOT NULL,
	"plan_fee_rial" bigint NOT NULL,
	"total_rial" bigint NOT NULL,
	"installment_count" integer NOT NULL,
	"funded_at" timestamp with time zone NOT NULL,
	"rounding_unit_rial" bigint NOT NULL,
	"rounding_config_version_id" uuid NOT NULL,
	"plan_fee_journal_entry_id" uuid REFERENCES "journal_entries" ("id"),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_schedules_case_key" UNIQUE ("case_id"),
	CONSTRAINT "installment_schedules_purse_key" UNIQUE ("purse_id"),
	CONSTRAINT "installment_schedules_idempotency_key_key" UNIQUE ("idempotency_key"),
	CONSTRAINT "installment_schedules_amounts_check" CHECK (
	  "principal_rial" > 0 AND "plan_fee_rial" >= 0 AND "total_rial" = "principal_rial" + "plan_fee_rial"
	  AND "rounding_unit_rial" > 0
	),
	-- Task 1-3 hard rule: never a zero installment.
	CONSTRAINT "installment_schedules_count_check" CHECK (
	  "installment_count" BETWEEN 1 AND 360
	  AND "total_rial" >= "installment_count" * "rounding_unit_rial"
	),
	CONSTRAINT "installment_schedules_fee_journal_check" CHECK (("plan_fee_rial" = 0) = ("plan_fee_journal_entry_id" IS NULL))
);--> statement-breakpoint

-- The installments of a schedule: a due day (the Tehran calendar day, as `date`) and an
-- amount. Never edited: no late penalty, no early-settlement discount (doc 02 §5); what
-- is paid is derived from payment_allocations.
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_id" uuid NOT NULL REFERENCES "installment_schedules" ("id"),
	"index" integer NOT NULL,
	"due_on" date NOT NULL,
	"amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installments_schedule_index_key" UNIQUE ("schedule_id", "index"),
	CONSTRAINT "installments_index_check" CHECK ("index" >= 1),
	CONSTRAINT "installments_amount_check" CHECK ("amount_rial" > 0)
);--> statement-breakpoint

-- The schedule's installments always add up to its total (checked at commit).
CREATE FUNCTION public.installment_schedules_check_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  n integer;
  total numeric;
  expected record;
BEGIN
  SELECT installment_count, total_rial INTO expected FROM public.installment_schedules WHERE id = NEW.id;
  SELECT count(*), coalesce(sum(amount_rial), 0) INTO n, total
  FROM public.installments WHERE schedule_id = NEW.id;
  IF n <> expected.installment_count OR total <> expected.total_rial THEN
    RAISE EXCEPTION 'schedule % has % installments totalling %, expected % totalling %',
      NEW.id, n, total, expected.installment_count, expected.total_rial
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER installment_schedules_total
  AFTER INSERT ON "installment_schedules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.installment_schedules_check_total();--> statement-breakpoint

-- A payment received for a case (a bank slip: the only method in version one, ADR-009).
-- Only its decision is ever written: pending_approval → approved | rejected.
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_id" uuid NOT NULL REFERENCES "installment_schedules" ("id"),
	"amount_rial" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference" text,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"receipt_journal_entry_id" uuid NOT NULL REFERENCES "journal_entries" ("id"),
	"allocation_journal_entry_id" uuid REFERENCES "journal_entries" ("id"),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_key" UNIQUE ("idempotency_key"),
	CONSTRAINT "payments_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "payments_status_check" CHECK ("status" IN ('pending_approval', 'approved', 'rejected')),
	CONSTRAINT "payments_decision_check" CHECK (("status" = 'pending_approval') = ("decided_at" IS NULL)),
	CONSTRAINT "payments_rejection_reason_check" CHECK ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "payments_schedule_idx" ON "payments" ("schedule_id", "created_at");--> statement-breakpoint
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE FUNCTION public.payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.schedule_id, NEW.amount_rial, NEW.received_at, NEW.reference,
      NEW.receipt_journal_entry_id, NEW.idempotency_key, NEW.request_hash, NEW.created_by,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.schedule_id, OLD.amount_rial, OLD.received_at, OLD.reference,
      OLD.receipt_journal_entry_id, OLD.idempotency_key, OLD.request_hash, OLD.created_by,
      OLD.created_at) THEN
    RAISE EXCEPTION 'payment % can only record its decision', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending_approval' OR NEW.status = 'pending_approval' THEN
    RAISE EXCEPTION 'payment % is already decided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payments_guard BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.payments_guard();--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "payments" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "allocation_journal_entry_id", "decided_by", "decided_at", "decision_reason")
  ON "payments" TO sepehr_app;--> statement-breakpoint

-- How much of which payment went to which installment. Append-only.
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"payment_id" uuid NOT NULL REFERENCES "payments" ("id"),
	"installment_id" uuid NOT NULL REFERENCES "installments" ("id"),
	"amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "payment_allocations_payment_installment_key" UNIQUE ("payment_id", "installment_id")
);--> statement-breakpoint
CREATE INDEX "payment_allocations_installment_idx" ON "payment_allocations" ("installment_id");--> statement-breakpoint

-- Schedules, installments and allocations never change or disappear.
REVOKE UPDATE ON "installment_schedules", "installments", "payment_allocations" FROM sepehr_app;--> statement-breakpoint
-- The schedule row is the lock that serializes a case's payment decisions, and
-- SELECT … FOR UPDATE needs UPDATE on some column. This grant lets it lock; any actual
-- update is still refused by the append-only trigger below, even for the owner.
GRANT UPDATE ("id") ON "installment_schedules" TO sepehr_app;--> statement-breakpoint
CREATE TRIGGER installment_schedules_append_only BEFORE UPDATE OR DELETE ON "installment_schedules"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER installments_append_only BEFORE UPDATE OR DELETE ON "installments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- No installment ever receives more than its amount (checked on every allocation).
CREATE FUNCTION public.payment_allocations_check_cap() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  allocated numeric;
  due numeric;
BEGIN
  SELECT amount_rial INTO due FROM public.installments WHERE id = NEW.installment_id;
  SELECT coalesce(sum(amount_rial), 0) INTO allocated
  FROM public.payment_allocations WHERE installment_id = NEW.installment_id;
  IF allocated > due THEN
    RAISE EXCEPTION 'installment % would receive % of %', NEW.installment_id, allocated, due
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_allocations_cap
  AFTER INSERT ON "payment_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payment_allocations_check_cap();--> statement-breakpoint

-- Reading schedules and payments: accounting and the auditor; approving or rejecting a
-- received payment: accounting, one person, fully audited (task 1-3 decision; doc 04 §5
-- does not list it among the two-person actions).
INSERT INTO "permissions" ("code") VALUES ('repayment.read'), ('repayment.approve_payment');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'repayment.read'),
  ('accounting', 'repayment.approve_payment'),
  ('auditor', 'repayment.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
