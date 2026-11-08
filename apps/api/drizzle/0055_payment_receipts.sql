-- 0055 payment slips (task 6-2 [financial]; doc 15 §2; owner 1405/07/15: on phase 1's payments,
-- a duplicate flag rather than a status, two kinds of rejection, settlement per schedule and
-- the case completed when all of its are). Hand-written (ADR-003).
--   * payments: new nullable columns and new constraints on them only; its status CHECK and
--     guard are untouched (owner, Q2). The app may set the new decision columns.
--   * loan_settlements: new, append-only.
--   * cases (lead, not financial): its guard lets an open case go to completed directly, as
--     it does to cancelled (owner: «مسیر مستقیم به completed»); only the service does it.
--   * the rejection SMS's first template version.

-- === payments: the slip's own facts, the duplicate flag, the kind of rejection ============
ALTER TABLE "payments" ADD COLUMN "channel" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bank_ref_norm" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payer_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "submitted_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "image_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "image_mime" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "image_sha256" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "suspected_duplicate_of" uuid REFERENCES "payments" ("id");--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "duplicate_cleared_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reject_kind" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reject_journal_entry_id" uuid REFERENCES "journal_entries" ("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_channel_check"
  CHECK ("channel" IN ('staff', 'manual_receipt', 'bank_statement'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reject_kind_check" CHECK (
  ("reject_kind" IS NULL OR ("status" = 'rejected'
     AND "reject_kind" IN ('not_received', 'received_unaccepted')))
  -- Only money that never came is reversed.
  AND ("reject_journal_entry_id" IS NULL OR "reject_kind" = 'not_received')
);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_image_check" CHECK (
  ("image_key" IS NULL) = ("image_sha256" IS NULL) AND ("image_key" IS NULL) = ("image_mime" IS NULL)
);--> statement-breakpoint
-- A flagged slip is approved only with a reason why it is not a duplicate.
ALTER TABLE "payments" ADD CONSTRAINT "payments_duplicate_check" CHECK (
  "suspected_duplicate_of" IS NULL OR "status" <> 'approved' OR "duplicate_cleared_reason" IS NOT NULL
);--> statement-breakpoint
CREATE INDEX "payments_duplicate_idx" ON "payments" ("bank_ref_norm", "amount_rial", "paid_on")
  WHERE "bank_ref_norm" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_queue_idx" ON "payments" ("status", "created_at");--> statement-breakpoint
GRANT UPDATE ("reject_kind", "reject_journal_entry_id", "duplicate_cleared_reason")
  ON "payments" TO sepehr_app;--> statement-breakpoint

-- === A schedule paid in full, once ======================================================
CREATE TABLE "loan_settlements" (
	"schedule_id" uuid PRIMARY KEY NOT NULL REFERENCES "installment_schedules" ("id"),
	"case_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL REFERENCES "payments" ("id"),
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "loan_settlements_case_idx" ON "loan_settlements" ("case_id");--> statement-breakpoint
CREATE TRIGGER loan_settlements_append_only BEFORE UPDATE OR DELETE ON "loan_settlements"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "loan_settlements" FROM sepehr_app;--> statement-breakpoint

-- === cases: completed directly from any open status, like cancelled =====================
CREATE OR REPLACE FUNCTION public.cases_guard_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  chain CONSTANT text[] := ARRAY['new', 'advising', 'appointment_booked', 'examined',
    'proforma_issued', 'credit_requested', 'credit_decided', 'contracted', 'funded',
    'in_treatment', 'completed'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' THEN
      RAISE EXCEPTION 'a case starts as new' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'case % is closed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    -- Task 6-2: a case whose loans are all paid is completed, wherever it stood.
    IF NEW.status NOT IN ('cancelled', 'completed')
       AND array_position(chain, NEW.status) IS DISTINCT FROM array_position(chain, OLD.status) + 1 THEN
      RAISE EXCEPTION 'case % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- === The rejection SMS's first version (the panel makes later ones; task 6-4) ============
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('repayment.receipt_rejected', 1, 'borrower', 'transactional',
   'فیش واریزی شما به مبلغ {{amount}} تأیید نشد. برای پیگیری با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0055 (تسک ۶-۲)');
