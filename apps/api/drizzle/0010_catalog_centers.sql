-- 0010 centers and branches (task 2-2; doc 08 §2–3; ADR-022). Drafted by drizzle-kit for the
-- catalog module's tables, then extended by hand (ADR-003): the org_nodes tree gains branches
-- (expand only: every existing node stays valid), and the database itself guards the
-- status machine, the two-person rule and the encrypted identifiers.

CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"node_id" uuid NOT NULL,
	"center_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"address" text,
	"latitude_e6" integer,
	"longitude_e6" integer,
	"phone" text,
	"parking" text,
	"nearest_metro" text,
	"nearest_brt" text,
	"route_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "center_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"center_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"sheba_enc" text,
	"sheba_index" text,
	"sheba_last4" text,
	"account_holder_name" text,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "center_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"center_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "center_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"center_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "center_treatment_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"center_id" uuid NOT NULL,
	"field_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "centers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"node_id" uuid NOT NULL,
	"person_type" text NOT NULL,
	"name" text NOT NULL,
	"city_code" text NOT NULL,
	"address" text,
	"latitude_e6" integer,
	"longitude_e6" integer,
	"phone" text,
	"license_number" text,
	"identifier_enc" text NOT NULL,
	"identifier_index" text NOT NULL,
	"identifier_last4" text NOT NULL,
	"sheba_enc" text,
	"sheba_index" text,
	"sheba_last4" text,
	"account_holder_name" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"checklist_config_version_id" uuid,
	"first_activated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "branches_node_id_key" ON "branches" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_default_key" ON "branches" USING btree ("center_id") WHERE "branches"."is_default" AND "branches"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "branches_center_id_idx" ON "branches" USING btree ("center_id");--> statement-breakpoint
CREATE UNIQUE INDEX "center_change_requests_open_key" ON "center_change_requests" USING btree ("center_id","kind") WHERE "center_change_requests"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "center_change_requests_status_idx" ON "center_change_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "center_documents_key" ON "center_documents" USING btree ("center_id","code") WHERE "center_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "center_status_changes_center_idx" ON "center_status_changes" USING btree ("center_id");--> statement-breakpoint
CREATE UNIQUE INDEX "center_treatment_fields_key" ON "center_treatment_fields" USING btree ("center_id","field_code") WHERE "center_treatment_fields"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "centers_node_id_key" ON "centers" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "centers_identifier_index_key" ON "centers" USING btree ("identifier_index") WHERE "centers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "centers_sheba_index_key" ON "centers" USING btree ("sheba_index") WHERE "centers"."deleted_at" IS NULL AND "centers"."sheba_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "centers_city_code_idx" ON "centers" USING btree ("city_code");--> statement-breakpoint
CREATE INDEX "centers_status_idx" ON "centers" USING btree ("status");--> statement-breakpoint

-- === The tree: Center → Branch → Doctor → Secretary (doc 08 §2) ===========================
ALTER TABLE "org_nodes" DROP CONSTRAINT "org_nodes_kind_check";--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_kind_check" CHECK ("kind" IN ('center', 'branch', 'doctor', 'secretary'));--> statement-breakpoint
-- As in 0002, plus: a branch sits under a center; a doctor under a center (task 0-5 data;
-- new doctors go under a branch, task 2-2 decision) or a branch, or is a root.
CREATE OR REPLACE FUNCTION public.org_nodes_set_path() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  parent public.org_nodes%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.kind <> OLD.kind
       OR NEW.path <> OLD.path OR NEW.city_code <> OLD.city_code THEN
      RAISE EXCEPTION 'org node % cannot move or change kind, path or city', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NULL THEN
    IF NEW.kind = 'secretary' THEN
      RAISE EXCEPTION 'a secretary must belong to a doctor' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'branch' THEN
      RAISE EXCEPTION 'a branch must belong to a center' USING ERRCODE = 'check_violation';
    END IF;
    NEW.path := text2ltree(replace(NEW.id::text, '-', ''));
    RETURN NEW;
  END IF;

  SELECT * INTO parent FROM public.org_nodes WHERE id = NEW.parent_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent org node not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT ((NEW.kind = 'branch' AND parent.kind = 'center')
          OR (NEW.kind = 'doctor' AND parent.kind IN ('center', 'branch'))
          OR (NEW.kind = 'secretary' AND parent.kind = 'doctor')) THEN
    RAISE EXCEPTION 'a % cannot be placed under a %', NEW.kind, parent.kind
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.path := parent.path || text2ltree(replace(NEW.id::text, '-', ''));
  NEW.city_code := parent.city_code;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A role may be scoped to one branch (its manager sees only what is under it).
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_scope_kind_check";--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_kind_check" CHECK ("scope_kind" IN ('global', 'city', 'center', 'branch', 'doctor', 'queue', 'own'));--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_scope_ref_check";--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_ref_check" CHECK (
  ("scope_kind" IN ('global', 'own') AND "scope_node_id" IS NULL AND "scope_code" IS NULL)
  OR ("scope_kind" IN ('center', 'branch', 'doctor') AND "scope_node_id" IS NOT NULL AND "scope_code" IS NULL)
  OR ("scope_kind" IN ('city', 'queue') AND "scope_node_id" IS NULL AND "scope_code" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint

-- === Integrity ===========================================================================
ALTER TABLE "centers" ADD CONSTRAINT "centers_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id");--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id");--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
ALTER TABLE "center_treatment_fields" ADD CONSTRAINT "center_treatment_fields_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
ALTER TABLE "center_documents" ADD CONSTRAINT "center_documents_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
ALTER TABLE "center_status_changes" ADD CONSTRAINT "center_status_changes_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
ALTER TABLE "center_status_changes" ADD CONSTRAINT "center_status_changes_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."center_change_requests"("id");--> statement-breakpoint
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint

ALTER TABLE "centers" ADD CONSTRAINT "centers_person_type_check" CHECK ("person_type" IN ('natural', 'legal'));--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_status_check" CHECK ("status" IN ('draft', 'under_review', 'needs_fix', 'active', 'suspended', 'terminated'));--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_city_code_check" CHECK ("city_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_name_check" CHECK (length("name") BETWEEN 2 AND 200);--> statement-breakpoint
-- Encrypted values only (FieldCrypto and blind index, both `v1.` form): a plaintext ID or
-- Sheba can never land in these columns by mistake.
ALTER TABLE "centers" ADD CONSTRAINT "centers_identifier_check" CHECK (
  "identifier_enc" LIKE 'v1.%' AND "identifier_index" LIKE 'v1.%' AND "identifier_last4" ~ '^[0-9]{4}$'
);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_sheba_check" CHECK (
  ("sheba_enc" IS NULL AND "sheba_index" IS NULL AND "sheba_last4" IS NULL)
  OR ("sheba_enc" LIKE 'v1.%' AND "sheba_index" LIKE 'v1.%' AND "sheba_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_location_check" CHECK (
  ("latitude_e6" IS NULL) = ("longitude_e6" IS NULL)
  AND ("latitude_e6" IS NULL OR "latitude_e6" BETWEEN -90000000 AND 90000000)
  AND ("longitude_e6" IS NULL OR "longitude_e6" BETWEEN -180000000 AND 180000000)
);--> statement-breakpoint
-- Active, suspended and terminated centers have been activated, with a bank account.
ALTER TABLE "centers" ADD CONSTRAINT "centers_activated_check" CHECK (
  "status" IN ('draft', 'under_review', 'needs_fix')
  OR ("first_activated_at" IS NOT NULL AND "sheba_enc" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_name_check" CHECK (length("name") BETWEEN 2 AND 200);--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_parking_check" CHECK ("parking" IN ('available', 'limited', 'none'));--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_location_check" CHECK (
  ("latitude_e6" IS NULL) = ("longitude_e6" IS NULL)
  AND ("latitude_e6" IS NULL OR "latitude_e6" BETWEEN -90000000 AND 90000000)
  AND ("longitude_e6" IS NULL OR "longitude_e6" BETWEEN -180000000 AND 180000000)
);--> statement-breakpoint
ALTER TABLE "center_treatment_fields" ADD CONSTRAINT "center_treatment_fields_code_check" CHECK ("field_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "center_documents" ADD CONSTRAINT "center_documents_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "center_documents" ADD CONSTRAINT "center_documents_status_check" CHECK ("status" IN ('received', 'verified', 'incomplete'));--> statement-breakpoint
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_kind_check" CHECK ("kind" IN ('activation', 'reactivation', 'bank_account'));--> statement-breakpoint
-- `withdrawn`: closed by the service when the center left the status the request was made
-- in (sent back for a fix, terminated); nobody approved or rejected it.
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_decision_check" CHECK (
  ("status" = 'proposed') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
);--> statement-breakpoint
-- The two-person rule (doc 04 §5; task 2-2 decision): whoever proposed never approves or
-- rejects, whatever roles they hold.
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_two_person_check" CHECK ("decided_by" IS NULL OR "status" = 'withdrawn' OR "decided_by" <> "proposed_by");--> statement-breakpoint
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_payload_check" CHECK (
  ("kind" = 'bank_account'
    AND "sheba_enc" LIKE 'v1.%' AND "sheba_index" LIKE 'v1.%' AND "sheba_last4" ~ '^[0-9]{4}$'
    AND "account_holder_name" IS NOT NULL)
  OR ("kind" <> 'bank_account'
    AND "sheba_enc" IS NULL AND "sheba_index" IS NULL AND "sheba_last4" IS NULL
    AND "account_holder_name" IS NULL)
);--> statement-breakpoint

-- === The status machine and the two-person rule, in the database too =====================
-- Only the transitions of doc 08 §3. A new center starts as a draft. Becoming active, and
-- a new bank account after the first activation, need a request approved in the same
-- transaction by someone other than its proposer. Once activated, the identity is fixed.
CREATE FUNCTION public.centers_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.first_activated_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new center starts as a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER centers_guard_insert BEFORE INSERT ON "centers"
  FOR EACH ROW EXECUTE FUNCTION public.centers_guard_insert();--> statement-breakpoint
CREATE FUNCTION public.centers_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  -- A terminated center is kept as it ended: only reports and settling earlier items.
  IF OLD.status = 'terminated' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated center % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Only a draft that was never activated may be soft-deleted, and never restored: an
  -- active, suspended or terminated center keeps blocking its IDs (task 2-2 decision).
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND (OLD.deleted_at IS NOT NULL OR OLD.status <> 'draft' OR OLD.first_activated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'center % cannot be deleted or restored in status %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Set once, by the first activation.
  IF NEW.first_activated_at IS DISTINCT FROM OLD.first_activated_at
     AND NOT (OLD.first_activated_at IS NULL AND OLD.status = 'under_review' AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'first_activated_at of center % is set only by its first activation', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Under review (and so in the activation itself) the reviewed identity and bank account
  -- stay as they were checked.
  IF OLD.status = 'under_review'
     AND (NEW.person_type <> OLD.person_type
          OR NEW.identifier_index <> OLD.identifier_index
          OR NEW.sheba_index IS DISTINCT FROM OLD.sheba_index
          OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name) THEN
    RAISE EXCEPTION 'the identity and bank account of center % under review cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status = 'under_review')
      OR (OLD.status = 'under_review' AND NEW.status IN ('needs_fix', 'active'))
      OR (OLD.status = 'needs_fix' AND NEW.status = 'under_review')
      OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'terminated'))
      OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'terminated'))
    ) THEN
      RAISE EXCEPTION 'center % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM center_change_requests r
      WHERE r.center_id = NEW.id AND r.status = 'approved'
        AND r.kind = CASE OLD.status WHEN 'suspended' THEN 'reactivation' ELSE 'activation' END
        AND r.decided_at = now()
    ) THEN
      RAISE EXCEPTION 'center % becomes active only by an approved two-person request', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.first_activated_at IS NOT NULL THEN
    IF NEW.first_activated_at IS DISTINCT FROM OLD.first_activated_at
       OR NEW.person_type <> OLD.person_type
       OR NEW.identifier_index <> OLD.identifier_index THEN
      RAISE EXCEPTION 'the identity of activated center % cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.sheba_index IS DISTINCT FROM OLD.sheba_index
        OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name)
       AND NOT EXISTS (
         SELECT 1 FROM center_change_requests r
         WHERE r.center_id = NEW.id AND r.kind = 'bank_account' AND r.status = 'approved'
           AND r.sheba_index = NEW.sheba_index
           AND r.account_holder_name = NEW.account_holder_name
           AND r.decided_at = now()
       ) THEN
      RAISE EXCEPTION 'the bank account of activated center % changes only by an approved two-person request', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER centers_guard_change BEFORE UPDATE ON "centers"
  FOR EACH ROW EXECUTE FUNCTION public.centers_guard_change();--> statement-breakpoint
-- A request starts as proposed and is decided once: approved or rejected by someone other
-- than its proposer (the CHECK above), or withdrawn. It cannot be written pre-approved.
CREATE FUNCTION public.center_change_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'a center request starts as proposed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'center request % is already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NEW.decided_by = OLD.proposed_by THEN
    RAISE EXCEPTION 'the proposer of center request % cannot decide it', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER center_change_requests_guard BEFORE INSERT OR UPDATE ON "center_change_requests"
  FOR EACH ROW EXECUTE FUNCTION public.center_change_requests_guard();--> statement-breakpoint

-- === Never physically deleted (rule 7); history append-only ==============================
CREATE TRIGGER centers_set_updated_at BEFORE UPDATE ON "centers"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER branches_set_updated_at BEFORE UPDATE ON "branches"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER center_treatment_fields_set_updated_at BEFORE UPDATE ON "center_treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER center_documents_set_updated_at BEFORE UPDATE ON "center_documents"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER center_change_requests_set_updated_at BEFORE UPDATE ON "center_change_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER centers_no_delete BEFORE DELETE ON "centers"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER branches_no_delete BEFORE DELETE ON "branches"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER center_treatment_fields_no_delete BEFORE DELETE ON "center_treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER center_documents_no_delete BEFORE DELETE ON "center_documents"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER center_change_requests_no_delete BEFORE DELETE ON "center_change_requests"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER center_status_changes_append_only BEFORE UPDATE OR DELETE ON "center_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "center_status_changes" FROM sepehr_app;--> statement-breakpoint
-- A request is decided once; what was proposed, and by whom, never changes.
REVOKE UPDATE ON "center_change_requests" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_note") ON "center_change_requests" TO sepehr_app;--> statement-breakpoint
-- A center's node, city, creator and creation never change.
REVOKE UPDATE ON "centers" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("person_type", "name", "address", "latitude_e6", "longitude_e6", "phone",
  "license_number", "identifier_enc", "identifier_index", "identifier_last4", "sheba_enc",
  "sheba_index", "sheba_last4", "account_holder_name", "status", "checklist_config_version_id",
  "first_activated_at", "deleted_at") ON "centers" TO sepehr_app;--> statement-breakpoint
-- A branch's node and center never change.
REVOKE UPDATE ON "branches" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name", "address", "latitude_e6", "longitude_e6", "phone", "parking",
  "nearest_metro", "nearest_brt", "route_note", "deleted_at") ON "branches" TO sepehr_app;--> statement-breakpoint

-- === The document checklist (task 2-2 decision: configurable; statuses only until 2-8) ===
-- TODO(decision): the documents each kind of center must provide. This starting list is
-- changed from the panel (two people), not in code.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('catalog.center_document_checklist', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('catalog.center_document_checklist', 'global',
   '{"natural": [{"code": "national_card", "title": "کارت ملی صاحب مرکز"}, {"code": "activity_license", "title": "پروانه فعالیت"}, {"code": "sheba_certificate", "title": "گواهی شماره شبا"}], "legal": [{"code": "official_gazette", "title": "روزنامه رسمی آخرین تغییرات"}, {"code": "activity_license", "title": "پروانه فعالیت"}, {"code": "signatory_ids", "title": "مدارک صاحبان امضای مجاز"}, {"code": "sheba_certificate", "title": "گواهی شماره شبا"}]}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0010)', now());--> statement-breakpoint

-- === Permissions and the network manager (task 2-2 decisions) =============================
INSERT INTO "permissions" ("code") VALUES
  ('catalog.read_centers'),
  ('catalog.manage_centers'),
  ('catalog.review_centers'),
  ('catalog.suspend_center'),
  ('catalog.approve_center_activation'),
  ('catalog.approve_bank_account_change'),
  ('catalog.view_bank_account');--> statement-breakpoint
-- The second person of an activation is operational, so not the strategy manager, whose
-- work is setting rules (task 2-2 decision).
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('network_manager', 'مدیر شبکه درمان', true);--> statement-breakpoint
-- Bank accounts: proposed by the network specialist or the center manager, approved by
-- accounting (task 2-2 decision); the network roles never see a full Sheba.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('network_specialist', 'catalog.read_centers'),
  ('network_specialist', 'catalog.manage_centers'),
  ('network_specialist', 'catalog.review_centers'),
  ('network_specialist', 'catalog.suspend_center'),
  ('network_manager', 'access.read_org'),
  ('network_manager', 'catalog.read_centers'),
  ('network_manager', 'catalog.review_centers'),
  ('network_manager', 'catalog.suspend_center'),
  ('network_manager', 'catalog.approve_center_activation'),
  ('center_manager', 'catalog.read_centers'),
  ('center_manager', 'catalog.manage_centers'),
  ('accounting', 'catalog.read_centers'),
  ('accounting', 'catalog.approve_bank_account_change'),
  ('accounting', 'catalog.view_bank_account'),
  ('auditor', 'catalog.read_centers'),
  ('ceo', 'catalog.read_centers')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
