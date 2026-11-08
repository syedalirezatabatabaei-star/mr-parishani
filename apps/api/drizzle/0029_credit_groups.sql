-- 0029 credit groups and shortfalls (task 3-7; doc 10 §7). Three new nullable columns, a new
-- index, triggers beside the old ones, one configuration key. One destructive step, approved
-- by the owner (1405/07/10): the unique index «one open application per proforma» of 0024
-- is replaced by «one per proforma, borrower and case», so that two borrowers of one case
-- (over the cap) or a new case of the same person (a large shortfall) can share a proforma.
-- The new index is made first; it is stricter-or-equal on every row the old one allowed.
ALTER TABLE "credit_applications" ADD COLUMN "case_group_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "approved_cash_top_up_rial" bigint;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "shortfall_kind" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_applications_open_borrower_key" ON "credit_applications" USING btree ("proforma_id","borrower_person_id","case_id") WHERE "credit_applications"."status" NOT IN ('rejected', 'expired') AND "credit_applications"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX "credit_applications_open_proforma_key";--> statement-breakpoint
CREATE INDEX "credit_applications_group_idx" ON "credit_applications" USING btree ("case_group_id");--> statement-breakpoint
-- === Hand-written (task 3-7, doc 10 §7). ===================================================
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_shortfall_check" CHECK (
  ("shortfall_kind" IS NULL) = ("approved_cash_top_up_rial" IS NULL)
  AND ("shortfall_kind" IS NULL OR "shortfall_kind" IN ('none', 'small', 'large'))
  AND ("approved_cash_top_up_rial" IS NULL OR "approved_cash_top_up_rial" >= 0)
  AND (("shortfall_kind" = 'none') = ("approved_cash_top_up_rial" = 0) OR "shortfall_kind" IS NULL)
);--> statement-breakpoint

-- A group, once joined, is never left; a shortfall, once recorded at the decision, never
-- changes. A trigger of its own, beside 0024's, 0025's and 0028's.
CREATE FUNCTION public.credit_applications_group_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.case_group_id IS NOT NULL AND NEW.case_group_id IS DISTINCT FROM OLD.case_group_id THEN
    RAISE EXCEPTION 'credit application % is in a group', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.shortfall_kind IS NOT NULL AND
     (NEW.shortfall_kind, NEW.approved_cash_top_up_rial)
     IS DISTINCT FROM (OLD.shortfall_kind, OLD.approved_cash_top_up_rial) THEN
    RAISE EXCEPTION 'the shortfall of credit application % was recorded', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_group_locked BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_group_locked();--> statement-breakpoint
GRANT UPDATE ("case_group_id", "approved_cash_top_up_rial", "shortfall_kind")
  ON "credit_applications" TO sepehr_app;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.small_shortfall_bps', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.small_shortfall_bps', 'global', '1000',
   '2020-01-01T00:00:00Z', 'approved', 'سند ۱۰ §۷: آستانه کسری کم، ۱۰٪ مبلغ مصوب (مهاجرت 0029)', now());
