-- 0110 the portal (owner 1405/08/10; docs/decisions/portal-1405-08-10-decisions.md).
-- Hand-written (ADR-003). Expand only: new tables, four new permissions granted to existing
-- roles, three SMS templates. No existing table, column, permission or grant changes.

-- === Partnership requests: a center or a doctor asks to join (public form) ===================
CREATE SEQUENCE "partnership_request_number_seq" START WITH 1001;--> statement-breakpoint
CREATE TABLE "partnership_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" bigint DEFAULT nextval('partnership_request_number_seq') NOT NULL,
	"center_name" text NOT NULL,
	"place_kind" text NOT NULL,
	"person_type" text NOT NULL,
	"city_code" text NOT NULL,
	"treatment_field_codes" text[] NOT NULL,
	"address" text NOT NULL,
	"phone" text,
	"manager_name" text NOT NULL,
	"manager_role" text,
	-- Normalized 9XXXXXXXXX, proved by a code sent to it before the request was accepted.
	"mobile" text NOT NULL,
	"mobile_verified_at" timestamp with time zone NOT NULL,
	"doctors" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"center_id" uuid,
	"account_id" uuid,
	-- An HMAC of the sender's address, for abuse checks only (rule 30: no address stored).
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "partnership_requests_status_check"
	  CHECK ("status" IN ('pending', 'reviewed', 'approved', 'rejected')),
	CONSTRAINT "partnership_requests_person_type_check"
	  CHECK ("person_type" IN ('natural', 'legal')),
	CONSTRAINT "partnership_requests_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "partnership_requests_name_check" CHECK (length("center_name") BETWEEN 3 AND 200),
	CONSTRAINT "partnership_requests_fields_check" CHECK (cardinality("treatment_field_codes") >= 1),
	-- Two people: the final approval is never the reviewer's (doc 04, owner 1405/08/10).
	CONSTRAINT "partnership_requests_two_people_check"
	  CHECK ("approved_by" IS NULL OR "approved_by" <> "reviewed_by"),
	CONSTRAINT "partnership_requests_reviewed_check"
	  CHECK ("status" = 'pending' OR "status" = 'rejected' OR "reviewed_by" IS NOT NULL),
	CONSTRAINT "partnership_requests_approved_check"
	  CHECK ("status" <> 'approved' OR ("approved_by" IS NOT NULL AND "center_id" IS NOT NULL)),
	CONSTRAINT "partnership_requests_rejected_check"
	  CHECK ("status" <> 'rejected' OR length("rejection_reason") >= 3)
);--> statement-breakpoint
CREATE UNIQUE INDEX "partnership_requests_number_key" ON "partnership_requests" ("number");--> statement-breakpoint
CREATE INDEX "partnership_requests_status_idx" ON "partnership_requests" ("status", "created_at");--> statement-breakpoint
CREATE INDEX "partnership_requests_mobile_idx" ON "partnership_requests" ("mobile", "created_at");--> statement-breakpoint
-- What the applicant sent never changes; the decision moves forward only.
CREATE FUNCTION public.partnership_requests_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.center_name <> OLD.center_name OR NEW.place_kind <> OLD.place_kind
     OR NEW.person_type <> OLD.person_type OR NEW.city_code <> OLD.city_code
     OR NEW.treatment_field_codes <> OLD.treatment_field_codes OR NEW.address <> OLD.address
     OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.manager_name <> OLD.manager_name
     OR NEW.manager_role IS DISTINCT FROM OLD.manager_role OR NEW.mobile <> OLD.mobile
     OR NEW.mobile_verified_at <> OLD.mobile_verified_at OR NEW.doctors <> OLD.doctors
     OR NEW.number <> OLD.number OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'partnership_requests: what was sent does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('approved', 'rejected') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'partnership_requests: a decided request stays decided'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = NEW.status)
       OR (OLD.status = 'pending' AND NEW.status IN ('reviewed', 'rejected'))
       OR (OLD.status = 'reviewed' AND NEW.status IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'partnership_requests: cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partnership_requests_guard BEFORE UPDATE ON "partnership_requests"
  FOR EACH ROW EXECUTE FUNCTION public.partnership_requests_guard();--> statement-breakpoint
CREATE TRIGGER partnership_requests_set_updated_at BEFORE UPDATE ON "partnership_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE UPDATE ON "partnership_requests" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "rejection_reason", "reviewed_by", "reviewed_at", "review_note",
  "approved_by", "approved_at", "center_id", "account_id", "updated_at")
  ON "partnership_requests" TO sepehr_app;--> statement-breakpoint

-- Its documents, each scanned before it was kept (rule 28): append-only.
CREATE TABLE "partnership_request_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "partnership_requests" ("id"),
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partnership_request_documents_kind_check"
	  CHECK ("kind" IN ('license', 'owner_id', 'iban', 'gazette')),
	CONSTRAINT "partnership_request_documents_size_check" CHECK ("size_bytes" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "partnership_request_documents_kind_key"
  ON "partnership_request_documents" ("request_id", "kind");--> statement-breakpoint
CREATE TRIGGER partnership_request_documents_append_only
  BEFORE UPDATE OR DELETE ON "partnership_request_documents"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "partnership_request_documents" FROM sepehr_app;--> statement-breakpoint

-- Its history: received, reviewed, approved, rejected, the account's link sent. Append-only.
CREATE TABLE "partnership_request_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "partnership_requests" ("id"),
	"action" text NOT NULL,
	"actor_account_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partnership_request_events_action_check"
	  CHECK ("action" IN ('received', 'reviewed', 'approved', 'rejected', 'center_created',
	    'account_created', 'link_sent'))
);--> statement-breakpoint
CREATE INDEX "partnership_request_events_request_idx"
  ON "partnership_request_events" ("request_id", "created_at");--> statement-breakpoint
CREATE TRIGGER partnership_request_events_append_only
  BEFORE UPDATE OR DELETE ON "partnership_request_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "partnership_request_events" FROM sepehr_app;--> statement-breakpoint

-- === One-time links that let a new center user set their own password =====================
CREATE TABLE "account_setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "user_accounts" ("id"),
	-- Only an HMAC of the token is kept; the token itself is in the SMS alone.
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_setup_tokens_attempts_check" CHECK ("attempts" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "account_setup_tokens_hash_key" ON "account_setup_tokens" ("token_hash");--> statement-breakpoint
CREATE TRIGGER account_setup_tokens_set_updated_at BEFORE UPDATE ON "account_setup_tokens"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE UPDATE ON "account_setup_tokens" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("used_at", "attempts", "updated_at") ON "account_setup_tokens" TO sepehr_app;--> statement-breakpoint

-- === The desk's banners, the text pages and the announcements: versions, two people =======
-- Each change is a new version row, proposed by one person and decided by another; what was
-- proposed never changes. The version in force is the newest approved one.
CREATE TABLE "dashboard_banners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"banner_key" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tone" text NOT NULL,
	"image_key" text,
	"image_type" text,
	"link_href" text,
	"link_label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"audiences" text[] NOT NULL,
	"active" boolean NOT NULL,
	"display_seconds" integer DEFAULT 6 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_banners_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "dashboard_banners_tone_check"
	  CHECK ("tone" IN ('accent', 'highlight', 'indigo', 'teal', 'rose', 'amber')),
	CONSTRAINT "dashboard_banners_audiences_check"
	  CHECK (cardinality("audiences") >= 1
	    AND "audiences" <@ ARRAY['patient', 'center', 'doctor', 'staff']::text[]),
	CONSTRAINT "dashboard_banners_title_check" CHECK (length("title") BETWEEN 2 AND 80),
	CONSTRAINT "dashboard_banners_body_check" CHECK (length("body") BETWEEN 2 AND 200),
	CONSTRAINT "dashboard_banners_link_check" CHECK ("link_href" IS NULL OR "link_href" ~ '^/[^/]'),
	CONSTRAINT "dashboard_banners_seconds_check" CHECK ("display_seconds" BETWEEN 3 AND 30),
	CONSTRAINT "dashboard_banners_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
	CONSTRAINT "dashboard_banners_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "proposed_by")
);--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_banners_version_key" ON "dashboard_banners" ("banner_key", "version");--> statement-breakpoint

CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	-- Blocks: headings, paragraphs, lists and links (packages/contracts content.ts).
	"body" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_pages_slug_check"
	  CHECK ("slug" IN ('about', 'terms', 'privacy', 'contact', 'help', 'faq')),
	CONSTRAINT "content_pages_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "content_pages_title_check" CHECK (length("title") BETWEEN 2 AND 120),
	CONSTRAINT "content_pages_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "proposed_by")
);--> statement-breakpoint
CREATE UNIQUE INDEX "content_pages_version_key" ON "content_pages" ("slug", "version");--> statement-breakpoint

CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"announcement_key" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text NOT NULL,
	"role_code" text,
	"urgent" boolean NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"active" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "announcements_audience_check"
	  CHECK ("audience" IN ('all', 'patients', 'centers', 'staff', 'role')),
	CONSTRAINT "announcements_role_check" CHECK (("audience" = 'role') = ("role_code" IS NOT NULL)),
	CONSTRAINT "announcements_title_check" CHECK (length("title") BETWEEN 2 AND 120),
	CONSTRAINT "announcements_body_check" CHECK (length("body") BETWEEN 2 AND 1000),
	CONSTRAINT "announcements_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
	CONSTRAINT "announcements_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "proposed_by")
);--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_version_key" ON "announcements" ("announcement_key", "version");--> statement-breakpoint

-- A proposal is decided once; what was proposed never changes (all three tables).
CREATE FUNCTION public.content_proposal_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  decision text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'updated_at'];
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION '%: a decided version does not change', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision) THEN
    RAISE EXCEPTION '%: what was proposed does not change', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER dashboard_banners_guard BEFORE UPDATE ON "dashboard_banners"
  FOR EACH ROW EXECUTE FUNCTION public.content_proposal_guard();--> statement-breakpoint
CREATE TRIGGER dashboard_banners_set_updated_at BEFORE UPDATE ON "dashboard_banners"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER content_pages_guard BEFORE UPDATE ON "content_pages"
  FOR EACH ROW EXECUTE FUNCTION public.content_proposal_guard();--> statement-breakpoint
CREATE TRIGGER content_pages_set_updated_at BEFORE UPDATE ON "content_pages"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER announcements_guard BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION public.content_proposal_guard();--> statement-breakpoint
CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- === Notifications: each account's own, and which announcements it has read ==============
CREATE TABLE "inbox_notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "user_accounts" ("id"),
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_href" text,
	-- The same event never notifies the same account twice.
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_notifications_link_check" CHECK ("link_href" IS NULL OR "link_href" ~ '^/[^/]')
);--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_notifications_dedupe_key" ON "inbox_notifications" ("account_id", "dedupe_key");--> statement-breakpoint
CREATE INDEX "inbox_notifications_account_idx" ON "inbox_notifications" ("account_id", "created_at");--> statement-breakpoint
REVOKE UPDATE ON "inbox_notifications" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("read_at") ON "inbox_notifications" TO sepehr_app;--> statement-breakpoint

CREATE TABLE "announcement_reads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "user_accounts" ("id"),
	"announcement_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "announcement_reads_key" ON "announcement_reads" ("account_id", "announcement_key");--> statement-breakpoint
REVOKE UPDATE ON "announcement_reads" FROM sepehr_app;--> statement-breakpoint

-- === Permissions: new codes only, granted to existing roles =================================
INSERT INTO "permissions" ("code") VALUES
  ('config.propose_content'),
  ('config.approve_content'),
  ('catalog.review_partnership'),
  ('catalog.approve_partnership');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g.permission_code
FROM (VALUES
  ('system_admin', 'config.propose_content'),
  ('system_admin', 'config.approve_content'),
  ('support', 'config.approve_content'),
  ('network_specialist', 'catalog.review_partnership'),
  ('network_manager', 'catalog.approve_partnership')
) AS g(role_code, permission_code)
JOIN "roles" r ON r."code" = g.role_code AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- === SMS to the applicant (staff audience: the person who will run the center's panel) =====
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('partnership.received', 1, 'staff', 'transactional',
   'درخواست همکاری شما در سپهر سلامتی با کد پیگیری {{case_number}} ثبت شد. نتیجه بررسی پیامک می‌شود.',
   'مهاجرت 0110: رسید درخواست همکاری'),
  ('partnership.rejected', 1, 'staff', 'transactional',
   'درخواست همکاری {{case_number}} در سپهر سلامتی پذیرفته نشد. علت: {{reason}}',
   'مهاجرت 0110: رد درخواست همکاری'),
  ('partnership.account_ready', 1, 'staff', 'transactional',
   'درخواست همکاری {{case_number}} تأیید شد. نام کاربری: {{username}}. ساخت رمز و ورود دومرحله‌ای تا ۲۴ ساعت: {{link}}',
   'مهاجرت 0110: حساب پنل مرکز');
