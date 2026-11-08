-- 0103 (ADR-050, ج۳; owner 1405/07/30, answer 7; plans approved). Add only: four new columns with
-- defaults that keep every existing row as it was ('wage', 0, null), new CHECKs that every
-- existing row already meets, one append-only table, one column grant, one permission. No ledger
-- row, no account, no change to an existing row, check or trigger. Summary:
-- docs/00-architecture-decisions.md ADR-050; docs/decisions/owner-plans-1405-07-27.md, «دور سی‌ونهم».
--
-- services.cost_kind / proforma_lines.cost_kind (+ reason): the doctor's wage or materials.
-- credit_applications.wage_rial / material_cash_rial: W and T − W, locked for a wage-only plan.
-- credit_cost_split_reviews: finance checked the split before the decision, once.
CREATE TABLE "credit_cost_split_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_cost_split_reviews_note_check" CHECK (length(trim("credit_cost_split_reviews"."note")) >= 3)
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "cost_kind" text DEFAULT 'wage' NOT NULL;--> statement-breakpoint
ALTER TABLE "proforma_lines" ADD COLUMN "cost_kind" text DEFAULT 'wage' NOT NULL;--> statement-breakpoint
ALTER TABLE "proforma_lines" ADD COLUMN "cost_kind_reason" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "wage_rial" bigint;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "material_cash_rial" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_cost_split_reviews" ADD CONSTRAINT "credit_cost_split_reviews_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_cost_split_reviews_application_key" ON "credit_cost_split_reviews" USING btree ("credit_application_id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_cost_kind_check" CHECK ("services"."cost_kind" IN ('wage', 'material'));--> statement-breakpoint
ALTER TABLE "proforma_lines" ADD CONSTRAINT "proforma_lines_cost_kind_check" CHECK ("proforma_lines"."cost_kind" IN ('wage', 'material'));--> statement-breakpoint
ALTER TABLE "proforma_lines" ADD CONSTRAINT "proforma_lines_cost_kind_reason_check" CHECK ("proforma_lines"."cost_kind_reason" IS NULL OR length(trim("proforma_lines"."cost_kind_reason")) >= 3);--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_material_cash_check" CHECK ("credit_applications"."material_cash_rial" >= 0 AND "credit_applications"."material_cash_rial" <= "credit_applications"."cash_top_up_rial"
          AND ("credit_applications"."wage_rial" IS NULL OR ("credit_applications"."wage_rial" >= 0 AND "credit_applications"."wage_rial" <= "credit_applications"."proforma_total_rial"
               AND "credit_applications"."material_cash_rial" = "credit_applications"."proforma_total_rial" - "credit_applications"."wage_rial"))
          AND ("credit_applications"."wage_rial" IS NOT NULL OR "credit_applications"."material_cash_rial" = 0));
--> statement-breakpoint
-- === Append-only (ADR-004) ===================================================================
CREATE TRIGGER credit_cost_split_reviews_append_only BEFORE UPDATE OR DELETE ON "credit_cost_split_reviews"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_cost_split_reviews_no_truncate BEFORE TRUNCATE ON "credit_cost_split_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- No DELETE for sepehr_app: 0000's default privileges never grant it (tested, round 33).
-- credit_applications' new columns get no UPDATE grant (0024's column grants): locked at insert.
-- proforma_lines keeps no UPDATE at all (0023): a line's cost kind is fixed when it is drafted.

-- === The network specialist sets a service's cost kind (with its name, 0012) ==================
GRANT UPDATE ("cost_kind") ON "services" TO sepehr_app;--> statement-breakpoint

-- === Permission ===============================================================================
INSERT INTO "permissions" ("code") VALUES ('credit.review_cost_split');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'credit.review_cost_split'
FROM "roles" r WHERE r."code" IN ('credit_specialist', 'case_completion') AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
