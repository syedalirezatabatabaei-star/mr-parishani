-- 0011 doctors and secretaries (task 2-3; doc 08 §2; ADR-023). Drafted by drizzle-kit for the
-- catalog module's tables and the org_nodes indexes, then extended by hand (ADR-003). Expand
-- only: every existing row stays valid, and the old one-node-per-account index is replaced by
-- one that still holds for every kind but a doctor (one doctor node per workplace).

CREATE TABLE "doctor_secretaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doctor_treatment_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"field_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doctor_workplaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_path" text NOT NULL,
	"center_id" uuid,
	"branch_id" uuid,
	"city_code" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"medical_council_number" text NOT NULL,
	"national_id_enc" text,
	"national_id_index" text,
	"national_id_last4" text,
	"account_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "org_nodes_account_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_secretaries_node_id_key" ON "doctor_secretaries" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "doctor_secretaries_workplace_id_idx" ON "doctor_secretaries" USING btree ("workplace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_treatment_fields_key" ON "doctor_treatment_fields" USING btree ("doctor_id","field_code") WHERE "doctor_treatment_fields"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_workplaces_node_id_key" ON "doctor_workplaces" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_workplaces_branch_key" ON "doctor_workplaces" USING btree ("doctor_id","branch_id") WHERE "doctor_workplaces"."deleted_at" IS NULL AND "doctor_workplaces"."branch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_workplaces_private_key" ON "doctor_workplaces" USING btree ("doctor_id") WHERE "doctor_workplaces"."deleted_at" IS NULL AND "doctor_workplaces"."branch_id" IS NULL;--> statement-breakpoint
CREATE INDEX "doctor_workplaces_doctor_id_idx" ON "doctor_workplaces" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "doctor_workplaces_city_code_idx" ON "doctor_workplaces" USING btree ("city_code");--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_medical_council_number_key" ON "doctors" USING btree ("medical_council_number") WHERE "doctors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_national_id_index_key" ON "doctors" USING btree ("national_id_index") WHERE "doctors"."deleted_at" IS NULL AND "doctors"."national_id_index" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_account_id_key" ON "doctors" USING btree ("account_id") WHERE "doctors"."deleted_at" IS NULL AND "doctors"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_nodes_doctor_account_key" ON "org_nodes" USING btree ("account_id","parent_id") WHERE "org_nodes"."kind" = 'doctor' AND "org_nodes"."account_id" IS NOT NULL AND "org_nodes"."parent_id" IS NOT NULL AND "org_nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_nodes_doctor_root_account_key" ON "org_nodes" USING btree ("account_id") WHERE "org_nodes"."kind" = 'doctor' AND "org_nodes"."account_id" IS NOT NULL AND "org_nodes"."parent_id" IS NULL AND "org_nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_nodes_account_id_key" ON "org_nodes" USING btree ("account_id") WHERE "org_nodes"."account_id" IS NOT NULL AND "org_nodes"."deleted_at" IS NULL AND "org_nodes"."kind" <> 'doctor';--> statement-breakpoint

-- === Integrity ===========================================================================
ALTER TABLE "doctor_treatment_fields" ADD CONSTRAINT "doctor_treatment_fields_doctor_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id");--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_doctor_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id");--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id");--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");--> statement-breakpoint
ALTER TABLE "doctor_secretaries" ADD CONSTRAINT "doctor_secretaries_workplace_id_fk" FOREIGN KEY ("workplace_id") REFERENCES "public"."doctor_workplaces"("id");--> statement-breakpoint
ALTER TABLE "doctor_secretaries" ADD CONSTRAINT "doctor_secretaries_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id");--> statement-breakpoint

ALTER TABLE "doctors" ADD CONSTRAINT "doctors_name_check" CHECK (length("name") BETWEEN 2 AND 200);--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_medical_council_number_check" CHECK ("medical_council_number" ~ '^[1-9][0-9]{2,7}$');--> statement-breakpoint
-- Encrypted only (FieldCrypto and blind index, `v1.` form), as for centers (rule 27).
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_national_id_check" CHECK (
  ("national_id_enc" IS NULL AND "national_id_index" IS NULL AND "national_id_last4" IS NULL)
  OR ("national_id_enc" LIKE 'v1.%' AND "national_id_index" LIKE 'v1.%' AND "national_id_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "doctor_treatment_fields" ADD CONSTRAINT "doctor_treatment_fields_code_check" CHECK ("field_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_place_check" CHECK (("center_id" IS NULL) = ("branch_id" IS NULL));--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD CONSTRAINT "doctor_workplaces_city_code_check" CHECK ("city_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "doctor_secretaries" ADD CONSTRAINT "doctor_secretaries_name_check" CHECK (length("name") BETWEEN 2 AND 200);--> statement-breakpoint

-- A doctor's account is attached once; detaching it is not built yet.
CREATE FUNCTION public.doctors_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'the account of doctor % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER doctors_guard_change BEFORE UPDATE ON "doctors"
  FOR EACH ROW EXECUTE FUNCTION public.doctors_guard_change();--> statement-breakpoint

-- === Never physically deleted (rule 7) ====================================================
CREATE TRIGGER doctors_set_updated_at BEFORE UPDATE ON "doctors"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_treatment_fields_set_updated_at BEFORE UPDATE ON "doctor_treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_workplaces_set_updated_at BEFORE UPDATE ON "doctor_workplaces"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_secretaries_set_updated_at BEFORE UPDATE ON "doctor_secretaries"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctors_no_delete BEFORE DELETE ON "doctors"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER doctor_treatment_fields_no_delete BEFORE DELETE ON "doctor_treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER doctor_workplaces_no_delete BEFORE DELETE ON "doctor_workplaces"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER doctor_secretaries_no_delete BEFORE DELETE ON "doctor_secretaries"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- A doctor's creator and creation never change.
REVOKE UPDATE ON "doctors" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name", "medical_council_number", "national_id_enc", "national_id_index",
  "national_id_last4", "account_id", "deleted_at") ON "doctors" TO sepehr_app;--> statement-breakpoint
-- A workplace's doctor, node, path and place never change.
REVOKE UPDATE ON "doctor_workplaces" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at") ON "doctor_workplaces" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "doctor_secretaries" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name", "deleted_at") ON "doctor_secretaries" TO sepehr_app;--> statement-breakpoint

-- === «Done by X on behalf of doctor Y» (doc 08 §2) ========================================
-- The provider profile a secretary or center manager acted for. Hashed only when set, so
-- the chain of earlier rows is unchanged.
ALTER TABLE "audit_events" ADD COLUMN "on_behalf_of_doctor_id" uuid;--> statement-breakpoint

-- === Permissions (task 2-3) ================================================================
INSERT INTO "permissions" ("code") VALUES
  ('catalog.read_doctors'),
  ('catalog.manage_doctors');--> statement-breakpoint
-- The doctor role also caps the secretary of a doctor without an account (task 2-3
-- decision), so what it holds here is what such a secretary can ever get.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('network_specialist', 'catalog.read_doctors'),
  ('network_specialist', 'catalog.manage_doctors'),
  ('network_manager', 'catalog.read_doctors'),
  ('center_manager', 'catalog.read_doctors'),
  ('center_manager', 'catalog.manage_doctors'),
  ('doctor', 'catalog.read_doctors'),
  ('doctor', 'catalog.manage_doctors'),
  ('auditor', 'catalog.read_doctors'),
  ('ceo', 'catalog.read_doctors')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
