-- 0018 doctors' public profiles and their media (task 2-8; doc 08 §10; ADR-029). Drafted by
-- drizzle-kit for the catalog module's tables, then extended by hand (ADR-003). Expand only:
-- new tables, keys and a permission; nothing existing changes. Files themselves live in S3
-- (private until published); these tables hold their state, never their bytes.

CREATE TABLE "doctor_profile_slugs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"profile_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doctor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"published_version_id" uuid,
	"first_published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"rejection" text,
	"detected_mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"original_key" text NOT NULL,
	"variants" jsonb,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "doctor_profile_slugs" ADD CONSTRAINT "doctor_profile_slugs_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile_versions" ADD CONSTRAINT "doctor_profile_versions_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profile_slugs_slug_key" ON "doctor_profile_slugs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profile_versions_number_key" ON "doctor_profile_versions" USING btree ("profile_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profile_versions_open_key" ON "doctor_profile_versions" USING btree ("profile_id") WHERE "doctor_profile_versions"."status" IN ('draft', 'in_review');--> statement-breakpoint
CREATE INDEX "doctor_profile_versions_in_review_idx" ON "doctor_profile_versions" USING btree ("submitted_at") WHERE "doctor_profile_versions"."status" = 'in_review';--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profiles_doctor_id_key" ON "doctor_profiles" USING btree ("doctor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profiles_slug_key" ON "doctor_profiles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "media_assets_doctor_id_idx" ON "media_assets" USING btree ("doctor_id");--> statement-breakpoint

-- === Keys and checks ======================================================================
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_doctor_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id");--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_published_version_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."doctor_profile_versions"("id");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_doctor_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id");--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 80);--> statement-breakpoint
ALTER TABLE "doctor_profile_slugs" ADD CONSTRAINT "doctor_profile_slugs_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 80);--> statement-breakpoint
ALTER TABLE "doctor_profile_versions" ADD CONSTRAINT "doctor_profile_versions_status_check" CHECK ("status" IN ('draft', 'in_review', 'published', 'rejected'));--> statement-breakpoint
ALTER TABLE "doctor_profile_versions" ADD CONSTRAINT "doctor_profile_versions_number_check" CHECK ("version_no" >= 1);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kind_check" CHECK ("kind" IN ('image', 'video'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_status_check" CHECK (
  ("status" = 'pending' AND "rejection" IS NULL AND "variants" IS NULL)
  OR ("status" = 'ready' AND "rejection" IS NULL AND "variants" IS NOT NULL)
  OR ("status" = 'rejected' AND "rejection" IN ('unsupported_type', 'infected', 'too_long', 'processing_failed')));--> statement-breakpoint
-- Only a ready file is ever public.
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_published_check" CHECK ("published_at" IS NULL OR "status" = 'ready');--> statement-breakpoint

-- === The version lifecycle (rule 8) =======================================================
-- draft → in_review → published | rejected; only a draft's content changes.
CREATE FUNCTION public.doctor_profile_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'in_review')
    OR (OLD.status = 'in_review' AND NEW.status IN ('published', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'profile version % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'profile version % is % and its content cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER doctor_profile_versions_guard BEFORE UPDATE ON "doctor_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION public.doctor_profile_versions_guard();--> statement-breakpoint

-- === The file lifecycle ===================================================================
-- pending → ready | rejected, once; a decided file never goes back.
CREATE FUNCTION public.media_assets_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status = 'pending' AND NEW.status IN ('ready', 'rejected')
  ) THEN
    RAISE EXCEPTION 'media % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.variants IS DISTINCT FROM OLD.variants
      OR NEW.rejection IS DISTINCT FROM OLD.rejection) THEN
    RAISE EXCEPTION 'media % is decided and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER media_assets_guard BEFORE UPDATE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION public.media_assets_guard();--> statement-breakpoint

-- === Timestamps, append-only, no deletes ==================================================
CREATE TRIGGER doctor_profiles_set_updated_at BEFORE UPDATE ON "doctor_profiles"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_profile_versions_set_updated_at BEFORE UPDATE ON "doctor_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER media_assets_set_updated_at BEFORE UPDATE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_profile_slugs_append_only BEFORE UPDATE OR DELETE ON "doctor_profile_slugs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER doctor_profiles_no_delete BEFORE DELETE ON "doctor_profiles"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER doctor_profile_versions_no_delete BEFORE DELETE ON "doctor_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER media_assets_no_delete BEFORE DELETE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- === What the application may change ======================================================
REVOKE UPDATE ON "doctor_profile_slugs" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "doctor_profiles" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("slug", "published_version_id", "first_published_at") ON "doctor_profiles" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "doctor_profile_versions" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "content", "submitted_by", "submitted_at", "decided_by", "decided_at", "decision_reason") ON "doctor_profile_versions" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "media_assets" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "rejection", "variants", "published_at") ON "media_assets" TO sepehr_app;--> statement-breakpoint

-- === Configuration (task 2-8; doc 09 open items 6 and 8) ===================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('catalog.profile_media_policy', 'technical', true),
  ('catalog.profile_video_hosting', 'business', true),
  ('catalog.profile_show_referral_count', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('catalog.profile_media_policy', 'global',
   '{"imageMaxBytes": 10485760, "videoMaxBytes": 104857600, "videoMaxSeconds": 180, "imageWidths": [320, 640, 1280], "signedUrlSeconds": 300}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0018)', now()),
  ('catalog.profile_video_hosting', 'global', '"aparat"',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0018)', now()),
  ('catalog.profile_show_referral_count', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0018)', now());--> statement-breakpoint

-- === Permissions (task 2-8) ===============================================================
INSERT INTO "permissions" ("code") VALUES ('catalog.review_profiles');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'catalog.review_profiles'
FROM "roles" r
WHERE r.code = 'network_specialist' AND r.deleted_at IS NULL;
