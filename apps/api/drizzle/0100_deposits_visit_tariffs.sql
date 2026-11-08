-- 0100 (owner 1405/07/29, answers f and i). Add only: two new tables, their checks, foreign keys,
-- indexes and triggers; two permissions and their grants; two configuration keys, both off.
-- No ledger row, no account, no change to any existing table. Summary:
-- docs/decisions/owner-plans-1405-07-27.md, «دور سی‌ودوم».
--
-- f: a formation deposit's details only (credit_formation_deposits); deposit.held comes after
--    the pilot with its own ADR. Amount = credit.formation_deposit_rial ("0" = off), locked.
-- i: a doctor's visit price from the internal panel by two people (visit_tariff_proposals);
--    catalog.visit_tariff_internal_only (off) closes the center panel's one-person path.
CREATE TABLE "visit_tariff_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"is_free" boolean NOT NULL,
	"min_amount_rial" bigint NOT NULL,
	"max_amount_rial" bigint NOT NULL,
	"effective_at" timestamp with time zone,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"tariff_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "visit_tariff_proposals_status_check" CHECK ("visit_tariff_proposals"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "visit_tariff_proposals_reason_check" CHECK (length(trim("visit_tariff_proposals"."reason")) >= 3),
	CONSTRAINT "visit_tariff_proposals_pricing_check" CHECK (("visit_tariff_proposals"."is_free" AND "visit_tariff_proposals"."min_amount_rial" = 0 AND "visit_tariff_proposals"."max_amount_rial" = 0)
          OR (NOT "visit_tariff_proposals"."is_free" AND "visit_tariff_proposals"."min_amount_rial" > 0 AND "visit_tariff_proposals"."max_amount_rial" >= "visit_tariff_proposals"."min_amount_rial")),
	CONSTRAINT "visit_tariff_proposals_two_people_check" CHECK ("visit_tariff_proposals"."decided_by" IS NULL OR "visit_tariff_proposals"."decided_by" <> "visit_tariff_proposals"."requested_by"),
	CONSTRAINT "visit_tariff_proposals_decided_check" CHECK (("visit_tariff_proposals"."status" = 'pending') = ("visit_tariff_proposals"."decided_by" IS NULL AND "visit_tariff_proposals"."decided_at" IS NULL)),
	CONSTRAINT "visit_tariff_proposals_version_check" CHECK (("visit_tariff_proposals"."status" = 'approved') = ("visit_tariff_proposals"."tariff_version_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "credit_formation_deposits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"config_version_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"bank_reference" text NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"refunded_on" date,
	"refund_reference" text,
	"refund_reason" text,
	"refunded_by" uuid,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_formation_deposits_amount_check" CHECK ("credit_formation_deposits"."amount_rial" > 0),
	CONSTRAINT "credit_formation_deposits_reference_check" CHECK (length(trim("credit_formation_deposits"."bank_reference")) BETWEEN 3 AND 60),
	CONSTRAINT "credit_formation_deposits_refund_check" CHECK (("credit_formation_deposits"."refunded_on" IS NULL AND "credit_formation_deposits"."refund_reference" IS NULL AND "credit_formation_deposits"."refund_reason" IS NULL
           AND "credit_formation_deposits"."refunded_by" IS NULL AND "credit_formation_deposits"."refunded_at" IS NULL)
          OR ("credit_formation_deposits"."refunded_on" IS NOT NULL AND "credit_formation_deposits"."refund_reference" IS NOT NULL
           AND "credit_formation_deposits"."refund_reason" IS NOT NULL AND "credit_formation_deposits"."refunded_by" IS NOT NULL
           AND "credit_formation_deposits"."refunded_at" IS NOT NULL AND "credit_formation_deposits"."refunded_on" >= "credit_formation_deposits"."paid_on"
           AND length(trim("credit_formation_deposits"."refund_reason")) >= 3
           AND length(trim("credit_formation_deposits"."refund_reference")) BETWEEN 3 AND 60))
);
--> statement-breakpoint
ALTER TABLE "visit_tariff_proposals" ADD CONSTRAINT "visit_tariff_proposals_workplace_id_doctor_workplaces_id_fk" FOREIGN KEY ("workplace_id") REFERENCES "public"."doctor_workplaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_tariff_proposals" ADD CONSTRAINT "visit_tariff_proposals_tariff_version_id_tariff_versions_id_fk" FOREIGN KEY ("tariff_version_id") REFERENCES "public"."tariff_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_formation_deposits" ADD CONSTRAINT "credit_formation_deposits_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_tariff_proposals_open_key" ON "visit_tariff_proposals" USING btree ("workplace_id") WHERE "visit_tariff_proposals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_formation_deposits_application_key" ON "credit_formation_deposits" USING btree ("credit_application_id") WHERE "credit_formation_deposits"."deleted_at" IS NULL;
--> statement-breakpoint
-- A deposit's details never change; only its refund is recorded, once.
CREATE FUNCTION public.credit_formation_deposits_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credit_application_id <> OLD.credit_application_id OR NEW.amount_rial <> OLD.amount_rial
     OR NEW.config_version_id <> OLD.config_version_id OR NEW.paid_on <> OLD.paid_on
     OR NEW.bank_reference <> OLD.bank_reference OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.recorded_by <> OLD.recorded_by OR NEW.created_at <> OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'credit_formation_deposits: a recorded deposit does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.refunded_at IS NOT NULL AND (NEW.refunded_on IS DISTINCT FROM OLD.refunded_on
     OR NEW.refund_reference IS DISTINCT FROM OLD.refund_reference
     OR NEW.refund_reason IS DISTINCT FROM OLD.refund_reason
     OR NEW.refunded_by IS DISTINCT FROM OLD.refunded_by
     OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at) THEN
    RAISE EXCEPTION 'credit_formation_deposits: a refund is recorded once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER credit_formation_deposits_guard BEFORE UPDATE ON "credit_formation_deposits"
  FOR EACH ROW EXECUTE FUNCTION public.credit_formation_deposits_guard();--> statement-breakpoint
CREATE TRIGGER credit_formation_deposits_set_updated_at BEFORE UPDATE ON "credit_formation_deposits"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- No DELETE for sepehr_app: 0000's default privileges never grant it (tested, round 33).
-- A proposal is decided once: only pending leaves; what was proposed never changes.
CREATE FUNCTION public.visit_tariff_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'visit_tariff_proposals: a decided proposal does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.workplace_id <> OLD.workplace_id OR NEW.is_free <> OLD.is_free
     OR NEW.min_amount_rial <> OLD.min_amount_rial OR NEW.max_amount_rial <> OLD.max_amount_rial
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'visit_tariff_proposals: what was proposed does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER visit_tariff_proposals_guard BEFORE UPDATE ON "visit_tariff_proposals"
  FOR EACH ROW EXECUTE FUNCTION public.visit_tariff_proposals_guard();--> statement-breakpoint
CREATE TRIGGER visit_tariff_proposals_set_updated_at BEFORE UPDATE ON "visit_tariff_proposals"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- No DELETE for sepehr_app: 0000's default privileges never grant it (tested, round 33).

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES
  ('credit.record_formation_deposit'),
  ('catalog.manage_visit_tariffs');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'credit.record_formation_deposit'
FROM "roles" r WHERE r."code" = 'case_completion' AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'catalog.manage_visit_tariffs'
FROM "roles" r WHERE r."code" IN ('network_specialist', 'network_manager') AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- === Configuration (both off) ================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.formation_deposit_rial', 'business', true),
  ('catalog.visit_tariff_internal_only', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.formation_deposit_rial', 'global', '"0"', '2020-01-01T00:00:00Z', 'approved',
   'بیعانه تشکیل خاموش تا تنظیم دونفره (پاسخ مالک ۱۴۰۵/۰۷/۲۹، مهاجرت 0100)', now()),
  ('catalog.visit_tariff_internal_only', 'global', 'false', '2020-01-01T00:00:00Z', 'approved',
   'مسیر یک‌نفره ویزیت تا روشن شدن دونفره می‌ماند (پاسخ مالک ۱۴۰۵/۰۷/۲۹، مهاجرت 0100)', now());
