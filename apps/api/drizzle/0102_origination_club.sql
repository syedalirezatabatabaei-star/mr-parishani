-- 0102 (ADR-048, ج۱; owner 1405/07/30: answers 2, 3 and 5, plans approved). Add only: four new
-- append-only tables, one new nullable column, three permissions, one role with no holder. No
-- ledger row, no account, no change to an existing table's rows, checks or triggers. Summary:
-- docs/00-architecture-decisions.md ADR-048; docs/decisions/owner-plans-1405-07-27.md, «دور سی‌وهشتم».
--
-- club_memberships / club_membership_revocations: a customer-club membership and its early end.
-- credit_applications.club_membership_id: locked when a club plan's case is made (no UPDATE grant).
-- origination_discounts: an officer's discount under their signature, once per application.
-- origination_fee_reductions: the origination fee owed, locked with its receipt (or at completion).
CREATE TABLE "club_membership_revocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"membership_id" uuid NOT NULL,
	"revoked_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_membership_revocations_reason_check" CHECK (length(trim("club_membership_revocations"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"recorded_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_memberships_dates_check" CHECK ("club_memberships"."ends_on" IS NULL OR "club_memberships"."ends_on" >= "club_memberships"."starts_on"),
	CONSTRAINT "club_memberships_reason_check" CHECK (length(trim("club_memberships"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "origination_discounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"discount_bps" integer NOT NULL,
	"granted_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "origination_discounts_amount_check" CHECK ("origination_discounts"."discount_bps" BETWEEN 1 AND 10000 AND "origination_discounts"."size_bytes" > 0),
	CONSTRAINT "origination_discounts_reason_check" CHECK (length(trim("origination_discounts"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "origination_fee_reductions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"receipt_id" uuid,
	"plans_version_id" uuid NOT NULL,
	"fee_rial" bigint NOT NULL,
	"base_rial" bigint NOT NULL,
	"cheque_count" integer NOT NULL,
	"waiver_bps" integer NOT NULL,
	"discount_id" uuid,
	"discount_bps" integer NOT NULL,
	"net_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "origination_fee_reductions_amount_check" CHECK ("origination_fee_reductions"."fee_rial" > 0 AND "origination_fee_reductions"."base_rial" > 0 AND "origination_fee_reductions"."net_rial" >= 0 AND "origination_fee_reductions"."net_rial" <= "origination_fee_reductions"."fee_rial"
          AND "origination_fee_reductions"."cheque_count" >= 0 AND "origination_fee_reductions"."waiver_bps" BETWEEN 0 AND 10000
          AND "origination_fee_reductions"."discount_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "origination_fee_reductions_discount_check" CHECK (("origination_fee_reductions"."discount_bps" > 0) = ("origination_fee_reductions"."discount_id" IS NOT NULL)),
	CONSTRAINT "origination_fee_reductions_unpaid_check" CHECK ("origination_fee_reductions"."receipt_id" IS NOT NULL OR "origination_fee_reductions"."net_rial" = 0)
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "club_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "club_membership_revocations" ADD CONSTRAINT "club_membership_revocations_membership_id_club_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."club_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origination_fee_reductions" ADD CONSTRAINT "origination_fee_reductions_receipt_id_completion_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."completion_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origination_fee_reductions" ADD CONSTRAINT "origination_fee_reductions_discount_id_origination_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."origination_discounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_membership_revocations_membership_key" ON "club_membership_revocations" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "club_memberships_person_idx" ON "club_memberships" USING btree ("person_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "origination_discounts_application_key" ON "origination_discounts" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "origination_discounts_storage_key" ON "origination_discounts" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "origination_discounts_created_idx" ON "origination_discounts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "origination_fee_reductions_receipt_key" ON "origination_fee_reductions" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "origination_fee_reductions_unpaid_key" ON "origination_fee_reductions" USING btree ("credit_application_id") WHERE "origination_fee_reductions"."receipt_id" IS NULL;--> statement-breakpoint
CREATE INDEX "origination_fee_reductions_application_idx" ON "origination_fee_reductions" USING btree ("credit_application_id");
--> statement-breakpoint
-- === Append-only: no row changes or leaves, not even by the owner (ADR-004) ==================
CREATE TRIGGER club_memberships_append_only BEFORE UPDATE OR DELETE ON "club_memberships"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER club_memberships_no_truncate BEFORE TRUNCATE ON "club_memberships"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER club_membership_revocations_append_only BEFORE UPDATE OR DELETE ON "club_membership_revocations"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER club_membership_revocations_no_truncate BEFORE TRUNCATE ON "club_membership_revocations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER origination_discounts_append_only BEFORE UPDATE OR DELETE ON "origination_discounts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER origination_discounts_no_truncate BEFORE TRUNCATE ON "origination_discounts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER origination_fee_reductions_append_only BEFORE UPDATE OR DELETE ON "origination_fee_reductions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER origination_fee_reductions_no_truncate BEFORE TRUNCATE ON "origination_fee_reductions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- No DELETE for sepehr_app: 0000's default privileges never grant it (tested, round 33).

-- === Permissions and the club officer role (no holder: given from /access) ====================
INSERT INTO "permissions" ("code") VALUES
  ('lead.record_club_membership'),
  ('contract.grant_origination_discount'),
  ('contract.read_origination_discounts');--> statement-breakpoint
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('club_officer', 'مسئول باشگاه مشتریان', true);--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g.permission_code
FROM (VALUES
  ('club_officer', 'lead.record_club_membership'),
  ('club_officer', 'contract.grant_origination_discount'),
  ('case_completion', 'contract.grant_origination_discount'),
  ('accounting', 'contract.read_origination_discounts'),
  ('ceo', 'contract.read_origination_discounts')
) AS g(role_code, permission_code)
JOIN "roles" r ON r."code" = g.role_code AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
