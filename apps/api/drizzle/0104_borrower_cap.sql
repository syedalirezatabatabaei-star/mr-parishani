-- 0104 (ADR-051, ج۶; owner 1405/07/30, answer 8; plans approved). Add only: one append-only table and
-- one configuration key, off ("0"). No ledger row, no account, no change to an existing row,
-- check or trigger. Summary: docs/decisions/owner-plans-1405-07-27.md, «دور چهلم».
--
-- credit_exposure_checks: each check of a borrower's cap, at the decision or the funding; a pass
--   in the step's transaction, a refusal in one of its own.
-- credit.borrower_exposure_cap: {capRial "0" (off), basis obligation, includeApprovedUnfunded true};
--   the annex's 1,500,000,000 is set in the panel by two people.
CREATE TABLE "credit_exposure_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"step" text NOT NULL,
	"exposure_rial" bigint NOT NULL,
	"amount_rial" bigint NOT NULL,
	"cap_rial" bigint NOT NULL,
	"basis" text NOT NULL,
	"include_approved_unfunded" boolean NOT NULL,
	"config_version_id" uuid NOT NULL,
	"allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_exposure_checks_amounts_check" CHECK ("credit_exposure_checks"."exposure_rial" >= 0 AND "credit_exposure_checks"."amount_rial" > 0 AND "credit_exposure_checks"."cap_rial" > 0
          AND "credit_exposure_checks"."step" IN ('decision', 'funding') AND "credit_exposure_checks"."basis" IN ('obligation', 'loan')
          AND "credit_exposure_checks"."allowed" = ("credit_exposure_checks"."exposure_rial" + "credit_exposure_checks"."amount_rial" <= "credit_exposure_checks"."cap_rial"))
);
--> statement-breakpoint
ALTER TABLE "credit_exposure_checks" ADD CONSTRAINT "credit_exposure_checks_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_exposure_checks_application_idx" ON "credit_exposure_checks" USING btree ("credit_application_id");
--> statement-breakpoint
-- === Append-only (ADR-004) ===================================================================
CREATE TRIGGER credit_exposure_checks_append_only BEFORE UPDATE OR DELETE ON "credit_exposure_checks"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_exposure_checks_no_truncate BEFORE TRUNCATE ON "credit_exposure_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- No DELETE for sepehr_app: 0000's default privileges never grant it (tested, round 33).

-- === Configuration (off) =====================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.borrower_exposure_cap', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.borrower_exposure_cap', 'global',
   '{"capRial": "0", "basis": "obligation", "includeApprovedUnfunded": true}', '2020-01-01T00:00:00Z',
   'approved', 'سقف مانده وام‌گیرنده خاموش تا تنظیم دونفره (ADR-051، مهاجرت 0104)', now());
