-- 0002 access and audit (task 0-5). Drafted by drizzle-kit for the tables in access.schema.ts,
-- then reviewed and extended by hand (ADR-003): the ltree extension, CHECK constraints,
-- triggers, row-level security, the seeded permissions, roles and policies, and the
-- audit tables, which are partitioned and written with explicit SQL only (not in the
-- Drizzle schema).

-- Materialized paths for the center tree (doc 04 §2). A trusted extension: the schema
-- owner may create it.
CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint

CREATE TABLE "access_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"policy_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"path" "ltree" DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"city_code" text NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_node_id" uuid,
	"scope_code" text,
	"reason" text NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
-- Moved before the foreign keys: role_permissions.permission_code references it.
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions" USING btree ("code");--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_parent_id_org_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_node_id_org_nodes_id_fk" FOREIGN KEY ("scope_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_policy_versions_key_idx" ON "access_policy_versions" USING btree ("policy_key","decided_at");--> statement-breakpoint
CREATE INDEX "org_nodes_path_idx" ON "org_nodes" USING gist ("path");--> statement-breakpoint
CREATE INDEX "org_nodes_parent_id_idx" ON "org_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_nodes_account_id_key" ON "org_nodes" USING btree ("account_id") WHERE "org_nodes"."account_id" IS NOT NULL AND "org_nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "role_assignments_account_id_idx" ON "role_assignments" USING btree ("account_id") WHERE "role_assignments"."revoked_at" IS NULL AND "role_assignments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_role_permission_key" ON "role_permissions" USING btree ("role_id","permission_code") WHERE "role_permissions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_code_key" ON "roles" USING btree ("code") WHERE "roles"."deleted_at" IS NULL;--> statement-breakpoint

-- Allowed values and shapes.
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_code_check" CHECK ("code" ~ '^[a-z]+\.[a-z][a-z_]*$');--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_kind_check" CHECK ("kind" IN ('center', 'doctor', 'secretary'));--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_city_code_check" CHECK ("city_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_secretary_account_check" CHECK ("kind" <> 'secretary' OR "account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_kind_check" CHECK ("scope_kind" IN ('global', 'city', 'center', 'doctor', 'queue', 'own'));--> statement-breakpoint
-- A node for center and doctor scopes, a code for city and (team) queue scopes, nothing
-- otherwise. A queue code is never a person's id (task 0-5 decision: queues are teams).
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_ref_check" CHECK (
  ("scope_kind" IN ('global', 'own') AND "scope_node_id" IS NULL AND "scope_code" IS NULL)
  OR ("scope_kind" IN ('center', 'doctor') AND "scope_node_id" IS NOT NULL AND "scope_code" IS NULL)
  OR ("scope_kind" IN ('city', 'queue') AND "scope_node_id" IS NULL AND "scope_code" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "access_policy_versions" ADD CONSTRAINT "access_policy_versions_key_check" CHECK ("policy_key" IN ('internal_panel_ip_allowlist', 'audit_retention'));--> statement-breakpoint
ALTER TABLE "access_policy_versions" ADD CONSTRAINT "access_policy_versions_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "access_policy_versions" ADD CONSTRAINT "access_policy_versions_decision_check" CHECK (("status" = 'proposed') = ("decided_at" IS NULL));--> statement-breakpoint
-- Maker-checker (ADR-006): the one who decides is never the one who proposed. Only the
-- values seeded below have no proposer, and so no decider either.
ALTER TABLE "access_policy_versions" ADD CONSTRAINT "access_policy_versions_two_people_check" CHECK (
  ("proposed_by" IS NULL AND "decided_by" IS NULL)
  OR ("proposed_by" IS NOT NULL AND ("decided_by" IS NULL OR "decided_by" <> "proposed_by"))
);--> statement-breakpoint

-- A TOTP reset request left without a second person expires (task 0-5 decision: 6 hours).
-- Expand only: the old code never writes 'expired'.
ALTER TABLE "totp_reset_requests" DROP CONSTRAINT "totp_reset_requests_status_check";--> statement-breakpoint
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'));--> statement-breakpoint

CREATE TRIGGER permissions_set_updated_at BEFORE UPDATE ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER role_permissions_set_updated_at BEFORE UPDATE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER role_assignments_set_updated_at BEFORE UPDATE ON "role_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER org_nodes_set_updated_at BEFORE UPDATE ON "org_nodes"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER access_policy_versions_set_updated_at BEFORE UPDATE ON "access_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- The center tree keeps its own shape: a center is a root, a doctor sits under a center
-- or is a root (private practice), a secretary sits under a doctor. The path is the
-- parent's path plus the node's id (hyphens removed: an ltree label), and children take
-- their parent's city. Nodes never move and never change kind.
CREATE FUNCTION public.org_nodes_set_path() RETURNS trigger
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
    NEW.path := text2ltree(replace(NEW.id::text, '-', ''));
    RETURN NEW;
  END IF;

  SELECT * INTO parent FROM public.org_nodes WHERE id = NEW.parent_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent org node not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT ((NEW.kind = 'doctor' AND parent.kind = 'center')
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
CREATE TRIGGER org_nodes_set_path BEFORE INSERT OR UPDATE ON "org_nodes"
  FOR EACH ROW EXECUTE FUNCTION public.org_nodes_set_path();--> statement-breakpoint

-- Row-level security: the second line of defense behind the service checks (doc 04 §2).
-- The application sets these for the current transaction only (set_config(..., true)):
--   app.rls_mode    'system' for the access module's own bookkeeping,
--                   'scoped' for reads on behalf of a user;
--   app.scope_all   'on' if the user has a global scope;
--   app.scope_paths comma-separated ltree paths of the user's center and doctor scopes;
--   app.scope_cities comma-separated city codes of the user's city scopes.
-- Without them a query sees no rows and can write none: it fails closed. sepehr_owner
-- owns the table and is not subject to these policies; sepehr_app is.
ALTER TABLE "org_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_nodes_system ON "org_nodes" TO sepehr_app
  USING (current_setting('app.rls_mode', true) = 'system')
  WITH CHECK (current_setting('app.rls_mode', true) = 'system');--> statement-breakpoint
CREATE POLICY org_nodes_scoped_read ON "org_nodes" FOR SELECT TO sepehr_app
  USING (
    current_setting('app.rls_mode', true) = 'scoped'
    AND (
      current_setting('app.scope_all', true) = 'on'
      OR "path" <@ string_to_array(nullif(current_setting('app.scope_paths', true), ''), ',')::ltree[]
      OR "city_code" = ANY (string_to_array(nullif(current_setting('app.scope_cities', true), ''), ','))
    )
  );--> statement-breakpoint

-- Permissions are code (doc 04 §1): only migrations write this table.
REVOKE INSERT, UPDATE ON "permissions" FROM sepehr_app;--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES
  ('identity.request_totp_reset'),
  ('identity.approve_totp_reset'),
  ('access.read_roles'),
  ('access.manage_roles'),
  ('access.assign_roles'),
  ('access.manage_secretaries'),
  ('access.read_org'),
  ('access.manage_org'),
  ('access.read_policies'),
  ('access.manage_policies'),
  ('access.view_treatment'),
  ('access.view_credit_score'),
  ('access.view_decision_reasons'),
  ('access.view_patient_financials'),
  ('audit.read'),
  ('settlement.approve');--> statement-breakpoint

-- System roles: doc 04 §3 (internal) and §2 (center side). Each gets only what doc 04
-- names for it among the permissions that exist today; where the doc is not explicit it
-- gets less, never more (task 0-5 decision). Later tasks add their modules' codes.
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('advisor', 'مشاور (حامی)', true),
  ('network_specialist', 'کارشناس شبکه درمان', true),
  ('case_completion', 'کارشناس تکمیل پرونده', true),
  ('credit_specialist', 'کارشناس اعتبار', true),
  ('strategy_manager', 'مدیر استراتژی', true),
  ('accounting', 'حسابداری و تسویه', true),
  ('collection', 'واحد معوقات', true),
  ('support', 'پشتیبانی', true),
  ('system_admin', 'مدیر سیستم', true),
  ('ceo', 'مدیرعامل', true),
  ('auditor', 'حسابرس', true),
  ('center_manager', 'مدیر مرکز', true),
  ('doctor', 'پزشک', true),
  ('secretary', 'منشی', true);--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, p.code
FROM (VALUES
  -- advisor: leads, appointments and own cases; none of those modules exist yet.
  --   TODO(decision): nothing granted until the lead and booking modules add codes.
  -- network_specialist: registers and evaluates centers.
  --   TODO(decision): suspending a center is not a permission yet (catalog module).
  ('network_specialist', 'access.read_org'),
  ('network_specialist', 'access.manage_org'),
  -- case_completion: documents, guarantors, physical receipts; none exist yet.
  --   TODO(decision): nothing granted until those modules add codes.
  -- credit_specialist: scoring and proposing decisions.
  --   TODO(decision): whether it sees the treatment description; not granted for now.
  ('credit_specialist', 'access.view_credit_score'),
  ('credit_specialist', 'access.view_decision_reasons'),
  ('credit_specialist', 'access.view_patient_financials'),
  -- strategy_manager: approves rules, limits and exceptions.
  --   TODO(decision): patient financials and treatment; not granted for now.
  ('strategy_manager', 'access.view_credit_score'),
  ('strategy_manager', 'access.view_decision_reasons'),
  -- accounting: statements and payouts; every payout also needs a second approval.
  --   TODO(decision): patient financials; not granted for now.
  ('accounting', 'settlement.approve'),
  -- collection: installments, calls and promises; never the treatment, which the access
  --   module also enforces in code for anyone holding this role (doc 04 §3, §4).
  -- support: tickets; the ticket module does not exist yet.
  --   TODO(decision): nothing granted until it adds codes.
  -- system_admin: users, roles and technical settings; no medical content.
  ('system_admin', 'identity.request_totp_reset'),
  ('system_admin', 'identity.approve_totp_reset'),
  ('system_admin', 'access.read_roles'),
  ('system_admin', 'access.manage_roles'),
  ('system_admin', 'access.assign_roles'),
  ('system_admin', 'access.read_org'),
  ('system_admin', 'access.read_policies'),
  ('system_admin', 'access.manage_policies'),
  -- ceo: dashboards and reports, read only; the reporting module does not exist yet.
  --   TODO(decision): nothing granted until it adds codes.
  -- auditor: reports and the audit trail, read only.
  ('auditor', 'audit.read'),
  ('auditor', 'access.read_roles'),
  ('auditor', 'access.read_org'),
  ('auditor', 'access.read_policies'),
  -- center_manager: sees the state of every doctor under the center (doc 04 §2).
  --   TODO(decision): treatment details of those doctors' patients; not granted for now.
  ('center_manager', 'access.read_org'),
  -- doctor: only their own patients, and decides what their secretaries may do.
  ('doctor', 'access.read_org'),
  ('doctor', 'access.view_treatment'),
  ('doctor', 'access.manage_secretaries'),
  -- secretary: whatever the doctor grants on top, never more than the doctor has.
  --   TODO(decision): the default set; only the tree for now.
  ('secretary', 'access.read_org')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code
JOIN "permissions" p ON p.code = g.permission_code;--> statement-breakpoint

-- Initial policy values, changed later from the admin panel by two people.
--   TODO(decision): the office and VPN networks; the allow-list starts disabled.
INSERT INTO "access_policy_versions" ("policy_key", "value", "status", "reason", "decided_at") VALUES
  ('internal_panel_ip_allowlist', '{"enabled": false, "cidrs": []}', 'approved', 'مقدار اولیه (مهاجرت 0002)', now()),
  ('audit_retention', '{"months": 24}', 'approved', 'مقدار اولیه (مهاجرت 0002)', now());--> statement-breakpoint

-- Audit trail (doc 04 §7, rule 9). Append-only, hash-chained and partitioned by month.
-- Written only by the audit module with explicit SQL. seq orders the chain; each row's
-- hash covers its content and the previous row's hash, so editing or removing a row
-- breaks every hash after it.
CREATE SEQUENCE "audit_events_seq" AS bigint;--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"actor_account_id" uuid,
	"actor_session_id" uuid,
	"actor_ip" text,
	"actor_roles" text[] DEFAULT '{}' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_seq_idx" ON "audit_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type", "entity_id", "created_at");--> statement-breakpoint

-- Access log (doc 04 §7): who viewed which record or file. Append-only, partitioned.
CREATE TABLE "access_logs" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"ip" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE INDEX "access_logs_entity_idx" ON "access_logs" USING btree ("entity_type", "entity_id", "created_at");--> statement-breakpoint
CREATE INDEX "access_logs_account_idx" ON "access_logs" USING btree ("account_id", "created_at");--> statement-breakpoint

-- Nobody changes or removes a row, not even the owner by mistake (ADR-004).
CREATE FUNCTION public.reject_append_only_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER access_logs_append_only BEFORE UPDATE OR DELETE ON "access_logs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER access_logs_no_truncate BEFORE TRUNCATE ON "access_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "audit_events", "access_logs" FROM sepehr_app;--> statement-breakpoint

-- Monthly partitions (UTC months), named <table>_YYYY_MM. Each new partition also loses
-- UPDATE for sepehr_app, which the default privileges of migration 0000 would grant.
-- Run by sepehr_owner: here, and by `pnpm audit:partitions` (scheduled in task 0-7).
CREATE FUNCTION public.audit_ensure_partitions(first_month date, months integer) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  month_start date;
  parent text;
  part_name text;
  created integer := 0;
BEGIN
  FOR i IN 0 .. months - 1 LOOP
    month_start := (date_trunc('month', first_month) + make_interval(months => i))::date;
    FOREACH parent IN ARRAY ARRAY['audit_events', 'access_logs'] LOOP
      part_name := parent || '_' || to_char(month_start, 'YYYY_MM');
      CONTINUE WHEN to_regclass('public.' || part_name) IS NOT NULL;
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent,
        month_start::text || ' 00:00:00+00',
        (month_start + interval '1 month')::date::text || ' 00:00:00+00'
      );
      EXECUTE format('REVOKE UPDATE ON public.%I FROM sepehr_app', part_name);
      created := created + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint

-- Retention (task 0-5 decision: 24 months, set from the panel): partitions of months
-- that ended before `cutoff` are detached, not dropped. A detached partition is an
-- archive table the application can no longer read or write; nothing is deleted.
CREATE FUNCTION public.audit_detach_partitions_before(cutoff date) RETURNS text[]
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  r record;
  detached text[] := '{}';
BEGIN
  FOR r IN
    SELECT child.relname AS part_name, parent.relname AS parent_name
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = parent.relnamespace
    WHERE n.nspname = 'public' AND parent.relname IN ('audit_events', 'access_logs')
      AND child.relname ~ '_[0-9]{4}_[0-9]{2}$'
      AND (to_date(right(child.relname, 7), 'YYYY_MM') + interval '1 month')::date <= cutoff
    ORDER BY child.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', r.parent_name, r.part_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM sepehr_app', r.part_name);
    detached := detached || r.part_name;
  END LOOP;
  RETURN detached;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.audit_ensure_partitions(date, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.audit_detach_partitions_before(date) FROM PUBLIC;--> statement-breakpoint

-- This month and the next twelve; the maintenance command keeps the window moving.
SELECT public.audit_ensure_partitions((now() AT TIME ZONE 'UTC')::date, 13);
