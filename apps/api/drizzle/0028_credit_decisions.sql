-- 0028 credit decisions and the committee (task 3-6; doc 10 §6, doc 03 §6). Expand only:
-- two new tables, eight new nullable columns on credit_applications (made in 0024), new
-- triggers beside the old ones, six permissions, two roles, three configuration keys.
CREATE TABLE "credit_committee_votes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_decision_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"vote" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"authority" text NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"out_of_matrix" boolean DEFAULT false NOT NULL,
	"approved_amount_rial" bigint,
	"amount_level" text,
	"quote" jsonb,
	"conditions" jsonb,
	"missing" jsonb,
	"reason_code" text,
	"reason" text NOT NULL,
	"minutes_number" text,
	"meeting_at" timestamp with time zone,
	"attendee_account_ids" uuid[],
	"proposed_by" uuid NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone,
	"closed_by" uuid,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_decisions_reason_check" CHECK (length(btrim("credit_decisions"."reason")) > 0),
	CONSTRAINT "credit_decisions_amount_check" CHECK (("credit_decisions"."outcome" IN ('approved', 'conditional')) = ("credit_decisions"."approved_amount_rial" IS NOT NULL)
          AND ("credit_decisions"."approved_amount_rial" IS NULL OR "credit_decisions"."approved_amount_rial" > 0))
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "decision_authority" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "guarantee_requirement" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "sufficiency" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "approved_amount_rial" bigint;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "conditions" jsonb;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_committee_votes" ADD CONSTRAINT "credit_committee_votes_credit_decision_id_credit_decisions_id_fk" FOREIGN KEY ("credit_decision_id") REFERENCES "public"."credit_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_committee_votes_member_key" ON "credit_committee_votes" USING btree ("credit_decision_id","account_id");--> statement-breakpoint
CREATE INDEX "credit_decisions_application_idx" ON "credit_decisions" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_decisions_open_key" ON "credit_decisions" USING btree ("credit_application_id") WHERE "credit_decisions"."status" = 'proposed';--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_approved_amount_check" CHECK ("credit_applications"."approved_amount_rial" IS NULL OR ("credit_applications"."approved_amount_rial" > 0 AND "credit_applications"."approved_amount_rial" <= "credit_applications"."loan_rial"));--> statement-breakpoint
-- === Hand-written (task 3-6, doc 10 §6): expand only. ======================================
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_outcome_check" CHECK ("outcome" IN ('approved', 'conditional', 'rejected', 'needs_more_guarantors'));--> statement-breakpoint
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_status_check" CHECK ("status" IN ('proposed', 'decided', 'refused', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_shape_check" CHECK (
  ("outcome" = 'conditional') = ("conditions" IS NOT NULL)
  AND ("outcome" = 'needs_more_guarantors') = ("missing" IS NOT NULL)
  AND ("outcome" = 'rejected') = ("reason_code" IS NOT NULL)
  AND ("checked_by" IS NULL) = ("checked_at" IS NULL)
  AND ("checked_by" IS NULL OR "checked_by" <> "proposed_by")
  AND (("status" = 'proposed') = ("closed_at" IS NULL))
  AND ("status" NOT IN ('refused', 'withdrawn') OR ("closed_by" IS NOT NULL AND length(btrim("close_reason")) > 0))
  AND ("authority" <> 'committee' OR "outcome" = 'needs_more_guarantors'
       OR ("minutes_number" IS NOT NULL AND "attendee_account_ids" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "credit_committee_votes" ADD CONSTRAINT "credit_committee_votes_vote_check" CHECK ("vote" IN ('approve', 'object'));--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_decision_check" CHECK (
  ("decision" IS NULL AND "status" NOT IN ('approved', 'conditional', 'rejected'))
  OR ("decision" = "status" AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
);--> statement-breakpoint

-- A decision's content never changes; only its state: proposed → decided | refused |
-- withdrawn, once; checked once, by someone other than its proposer (the CHECK above).
CREATE FUNCTION public.credit_decisions_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'checked_by', 'checked_at', 'closed_by',
                                 'close_reason', 'closed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'credit decision % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'credit decision % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.checked_by IS NOT NULL
     AND (NEW.checked_by, NEW.checked_at) IS DISTINCT FROM (OLD.checked_by, OLD.checked_at) THEN
    RAISE EXCEPTION 'credit decision % was checked once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_decisions_guard_change BEFORE UPDATE ON "credit_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.credit_decisions_guard_change();--> statement-breakpoint
CREATE TRIGGER credit_decisions_set_updated_at BEFORE UPDATE ON "credit_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_decisions_no_delete BEFORE DELETE ON "credit_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_committee_votes_append_only BEFORE UPDATE OR DELETE ON "credit_committee_votes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Once an application is decided, its decision and what the engine said of it are fixed.
-- A trigger of its own, beside 0024's guard and 0025's ruleset lock.
CREATE FUNCTION public.credit_applications_decision_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.decision IS NOT NULL AND
     (NEW.decision, NEW.approved_amount_rial, NEW.conditions, NEW.decided_by, NEW.decided_at,
      NEW.decision_authority, NEW.guarantee_requirement, NEW.sufficiency, NEW.amount_level)
     IS DISTINCT FROM
     (OLD.decision, OLD.approved_amount_rial, OLD.conditions, OLD.decided_by, OLD.decided_at,
      OLD.decision_authority, OLD.guarantee_requirement, OLD.sufficiency, OLD.amount_level) THEN
    RAISE EXCEPTION 'credit application % was decided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_decision_locked BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_decision_locked();--> statement-breakpoint

REVOKE UPDATE ON "credit_decisions" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "checked_by", "checked_at", "closed_by", "close_reason", "closed_at", "updated_at")
  ON "credit_decisions" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "credit_committee_votes" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("decision_authority", "guarantee_requirement", "sufficiency", "approved_amount_rial",
              "decision", "conditions", "decided_by", "decided_at")
  ON "credit_applications" TO sepehr_app;--> statement-breakpoint

-- === Roles and permissions =================================================================
-- Doc 10 §6 names the credit manager's permission; doc 04 has no role for it yet. A
-- committee member votes for the unit of their other role (credit.committee_units).
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('credit_manager', 'مسئول / مدیر اعتبار', true),
  ('credit_committee', 'عضو کمیته ریسک و اعتبار', true);--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES
  ('credit.propose_decision'),
  ('credit.decide_second_check'),
  ('credit.decide_manager'),
  ('credit.decide_out_of_matrix'),
  ('credit.committee_vote'),
  ('credit.read_status');--> statement-breakpoint
-- TODO(decision): whether another credit specialist may give the second check; only the
-- credit manager for now. Advisors, doctors and center managers see a status, never a
-- score or a reason (doc 10 §6).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('credit_specialist', 'credit.propose_decision'),
  ('credit_manager', 'credit.read_applications'),
  ('credit_manager', 'access.view_credit_score'),
  ('credit_manager', 'access.view_decision_reasons'),
  ('credit_manager', 'credit.decide_second_check'),
  ('credit_manager', 'credit.decide_manager'),
  ('credit_manager', 'credit.decide_out_of_matrix'),
  ('strategy_manager', 'credit.decide_out_of_matrix'),
  ('credit_committee', 'credit.read_applications'),
  ('credit_committee', 'access.view_credit_score'),
  ('credit_committee', 'access.view_decision_reasons'),
  ('credit_committee', 'credit.committee_vote'),
  ('advisor', 'credit.read_status'),
  ('doctor', 'credit.read_status'),
  ('center_manager', 'credit.read_status')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.rejection_reasons', 'business', true),
  ('credit.committee_units', 'business', true),
  ('credit.decision_sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.rejection_reasons', 'global',
   '{"reasons": [{"code": "insufficient_income", "label": "درآمد یا پوشش قسط ناکافی"}, {"code": "insufficient_guarantee", "label": "ضمانت ناکافی"}, {"code": "unverifiable_documents", "label": "مدارک غیرقابل احراز"}, {"code": "high_obligations", "label": "تعهدات قبلی زیاد"}, {"code": "grade", "label": "رتبه اعتباری نامناسب"}, {"code": "other", "label": "سایر"}]}',
   '2020-01-01T00:00:00Z', 'approved', 'فهرست آغازین تا فهرست کارفرما، سند ۱۰ §۶ (مهاجرت 0028)', now()),
  ('credit.committee_units', 'global',
   '{"minUnits": 2, "units": [{"code": "strategy", "label": "واحد استراتژی", "roleCodes": ["strategy_manager"]}, {"code": "collection", "label": "واحد وصول", "roleCodes": ["collection"]}, {"code": "finance", "label": "واحد مالی", "roleCodes": ["accounting"]}]}',
   '2020-01-01T00:00:00Z', 'approved', 'سند ۰۳ §۶ و سند ۱۰ §۶: دست‌کم دو واحد از سه (مهاجرت 0028)', now()),
  ('credit.decision_sms_templates', 'global',
   '{"approved": "درخواست اعتبار درمان شما در سپهر سلامتی تأیید شد. برای ادامه وارد شوید.", "conditional": "درخواست اعتبار درمان شما در سپهر سلامتی با شرایطی تأیید شد. برای دیدن شرایط وارد شوید.", "rejected": "درخواست اعتبار درمان شما در سپهر سلامتی تأیید نشد. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.", "needsMoreGuarantors": "برای ادامه بررسی پرونده اعتباری شما در سپهر سلامتی، ضامن بیشتری لازم است. وارد شوید."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۶ (مهاجرت 0028)', now());
