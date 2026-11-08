-- 0034 the down payment's ledger postings (task 4-5 [financial]; ADR-034; owner 1405/07/11).
-- Expand only: one new link table. completion_receipts, its CHECK and its trigger are
-- unchanged (owner, decision 3). The ledger is written only through the ledger module.
CREATE TABLE "down_payment_postings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"borrower_person_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"funded_purse_id" uuid,
	"funded_at" timestamp with time zone,
	"reversal_journal_entry_id" uuid,
	"reversal_reason" text,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "down_payment_postings_amount_check" CHECK ("down_payment_postings"."amount_rial" > 0),
	CONSTRAINT "down_payment_postings_state_check" CHECK ((("down_payment_postings"."funded_purse_id" IS NULL) = ("down_payment_postings"."funded_at" IS NULL))
        AND (("down_payment_postings"."reversal_journal_entry_id" IS NULL) = ("down_payment_postings"."reversed_at" IS NULL))
        AND (("down_payment_postings"."reversal_journal_entry_id" IS NULL) = ("down_payment_postings"."reversal_reason" IS NULL))
        AND (("down_payment_postings"."reversal_journal_entry_id" IS NULL) = ("down_payment_postings"."reversed_by" IS NULL))
        AND ("down_payment_postings"."funded_purse_id" IS NULL OR "down_payment_postings"."reversal_journal_entry_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "down_payment_postings" ADD CONSTRAINT "down_payment_postings_receipt_id_completion_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."completion_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "down_payment_postings_receipt_key" ON "down_payment_postings" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "down_payment_postings_journal_key" ON "down_payment_postings" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "down_payment_postings_reversal_key" ON "down_payment_postings" USING btree ("reversal_journal_entry_id");--> statement-breakpoint
CREATE INDEX "down_payment_postings_application_idx" ON "down_payment_postings" USING btree ("credit_application_id");--> statement-breakpoint
-- === Hand-written (ADR-034): expand only. ====================================================
ALTER TABLE "down_payment_postings" ADD CONSTRAINT "down_payment_postings_journal_fk"
  FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");--> statement-breakpoint
ALTER TABLE "down_payment_postings" ADD CONSTRAINT "down_payment_postings_reversal_journal_fk"
  FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id");--> statement-breakpoint

-- A posting: what was posted never changes; it is funded once or reversed once, from NULL.
CREATE FUNCTION public.down_payment_postings_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['funded_purse_id', 'funded_at', 'reversal_journal_entry_id',
                                 'reversal_reason', 'reversed_by', 'reversed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'down payment posting % can only be funded or reversed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.funded_purse_id IS NOT NULL OR OLD.reversal_journal_entry_id IS NOT NULL)
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'down payment posting % was already funded or reversed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER down_payment_postings_guard_change BEFORE UPDATE ON "down_payment_postings"
  FOR EACH ROW EXECUTE FUNCTION public.down_payment_postings_guard_change();--> statement-breakpoint
CREATE TRIGGER down_payment_postings_set_updated_at BEFORE UPDATE ON "down_payment_postings"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER down_payment_postings_no_delete BEFORE DELETE ON "down_payment_postings"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "down_payment_postings" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("funded_purse_id", "funded_at", "reversal_journal_entry_id", "reversal_reason",
              "reversed_by", "reversed_at", "updated_at")
  ON "down_payment_postings" TO sepehr_app;
