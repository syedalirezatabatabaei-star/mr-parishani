-- 0030 loan contracts (task 4-1; doc 12 §2). Expand only: three new tables, their rules,
-- two permissions, one configuration key (a sample template). No existing table changes.
CREATE TABLE "contract_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contract_id" uuid NOT NULL,
	"role" text NOT NULL,
	"person_id" uuid NOT NULL,
	"guarantor_id" uuid,
	"account_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"pdf_sha256" text NOT NULL,
	"session_id" uuid,
	"ip" text,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_number_sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL,
	"jalali_year" integer NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "contract_number_sequences_value_check" CHECK ("contract_number_sequences"."last_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"jalali_year" integer NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"template_version_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"sample" boolean NOT NULL,
	"parties" jsonb NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"storage_key" text,
	"sha256" text,
	"size_bytes" integer,
	"failure" text,
	"generated_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contract_acceptances" ADD CONSTRAINT "contract_acceptances_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_acceptances_party_key" ON "contract_acceptances" USING btree ("contract_id","person_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_number_sequences_year_key" ON "contract_number_sequences" USING btree ("entity_id","jalali_year");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_number_key" ON "contracts" USING btree ("entity_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_sequence_key" ON "contracts" USING btree ("entity_id","jalali_year","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_application_key" ON "contracts" USING btree ("credit_application_id") WHERE "contracts"."status" <> 'failed' AND "contracts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contracts_application_idx" ON "contracts" USING btree ("credit_application_id");--> statement-breakpoint
-- === Hand-written (task 4-1, doc 12 §2): expand only; no existing table changes. =========
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_entity_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("code");--> statement-breakpoint
ALTER TABLE "contract_number_sequences" ADD CONSTRAINT "contract_number_sequences_entity_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("code");--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_status_check" CHECK ("status" IN ('generating', 'ready', 'failed', 'accepted'));--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_shape_check" CHECK (
  "sequence" > 0 AND "jalali_year" BETWEEN 1300 AND 1500
  AND (("status" IN ('ready', 'accepted'))
       = ("storage_key" IS NOT NULL AND "sha256" IS NOT NULL AND "size_bytes" > 0 AND "generated_at" IS NOT NULL))
  AND (("status" = 'failed') = ("failure" IS NOT NULL))
  AND (("status" = 'accepted') = ("accepted_at" IS NOT NULL))
  AND ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "contract_acceptances" ADD CONSTRAINT "contract_acceptances_role_check" CHECK (
  "role" IN ('borrower', 'guarantor') AND (("role" = 'guarantor') = ("guarantor_id" IS NOT NULL))
  AND "pdf_sha256" ~ '^[0-9a-f]{64}$'
);--> statement-breakpoint

-- A contract: generating → ready | failed; ready → accepted. What it was filled with, its
-- number and template never change; its file and hash are written once.
CREATE FUNCTION public.contracts_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'storage_key', 'sha256', 'size_bytes', 'failure',
                                 'generated_at', 'accepted_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'contract % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'accepted')
  ) THEN
    RAISE EXCEPTION 'contract % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sha256 IS NOT NULL
     AND (NEW.storage_key, NEW.sha256, NEW.size_bytes, NEW.generated_at)
         IS DISTINCT FROM (OLD.storage_key, OLD.sha256, OLD.size_bytes, OLD.generated_at) THEN
    RAISE EXCEPTION 'the PDF of contract % is fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contracts_guard_change BEFORE UPDATE ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION public.contracts_guard_change();--> statement-breakpoint
CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER contracts_no_delete BEFORE DELETE ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER contract_acceptances_append_only BEFORE UPDATE OR DELETE ON "contract_acceptances"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- A year's numbers only go up; never removed.
CREATE FUNCTION public.contract_number_sequences_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.entity_id, NEW.jalali_year) IS DISTINCT FROM (OLD.id, OLD.entity_id, OLD.jalali_year)
     OR NEW.last_value <= OLD.last_value THEN
    RAISE EXCEPTION 'contract numbers of % in % only go up', OLD.entity_id, OLD.jalali_year
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_number_sequences_guard BEFORE UPDATE ON "contract_number_sequences"
  FOR EACH ROW EXECUTE FUNCTION public.contract_number_sequences_guard();--> statement-breakpoint
CREATE TRIGGER contract_number_sequences_no_delete BEFORE DELETE ON "contract_number_sequences"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "contracts" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "storage_key", "sha256", "size_bytes", "failure", "generated_at", "accepted_at", "updated_at")
  ON "contracts" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "contract_acceptances" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "contract_number_sequences" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("last_value") ON "contract_number_sequences" TO sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES ('contract.generate'), ('contract.read');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'contract.generate'),
  ('case_completion', 'contract.read'),
  ('credit_specialist', 'contract.read'),
  ('credit_manager', 'contract.read'),
  ('strategy_manager', 'contract.read'),
  ('auditor', 'contract.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
-- TODO(decision) ت۸: the legal text comes from the company's counsel; a sample until then.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('contract.loan_template', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('contract.loan_template', 'global',
   '{"title": "قرارداد وام درمان", "sample": true, "lender": {"entityId": "aramesh", "name": "شرکت آرامش ثروت"}, "body": "# طرفین\n\nاین قرارداد به شماره {{contract.number}} در تاریخ {{contract.date}} میان {{lender.name}} به‌عنوان وام‌دهنده و {{borrower.name}} به شماره همراه {{borrower.mobile}} به‌عنوان وام‌گیرنده بسته می‌شود.\n\nضامن یا ضامنان: {{guarantors.names}}\n\n# موضوع و مبلغ\n\nوام‌دهنده مبلغ {{loan.amount}} را برای هزینه درمان وام‌گیرنده، در قالب {{plan.title}}، از راه کیف اعتبار در اختیار مرکز درمانی می‌گذارد. پیش‌پرداخت {{downPayment.amount}} و هزینه تشکیل پرونده {{originationFee.amount}} است. کارمزد طرح {{planFee.amount}} و جمع اقساط {{totalObligation.amount}} است.\n\n# اقساط\n\nبازپرداخت در {{installments.count}} قسط ماهانه است. سررسیدها از روز واریز وام حساب می‌شوند و جدول زیر پیش‌نمایش است:\n\n{{installments.table}}\n\n# انصراف\n\nدر انصراف پس از واریز، وام‌گیرنده {{cancellation.penaltyPercent}} مبلغ مصوب وام را به‌عنوان خسارت می‌پردازد.\n\n# پذیرش\n\nوام‌گیرنده و ضامنان این قرارداد را با کد یک‌بارمصرف می‌پذیرند و نسخه امضاشده فیزیکی آن را نیز تحویل می‌دهند."}',
   '2020-01-01T00:00:00Z', 'approved', 'قالب نمونه — غیرقابل استفاده، تا متن مشاور حقوقی (مهاجرت 0030)', now());
