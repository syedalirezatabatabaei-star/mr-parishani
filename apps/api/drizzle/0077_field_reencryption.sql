-- 0077 the field re-encryption tool (task 9-3, R4; owner 1405/07/18: run by hand only, two people,
-- a pg_dump first, audited). Hand-written (ADR-003). Add only.
-- Summary: docs/decisions/task-9-3-decisions.md (part 5).

-- Two people allow one run: proposed and approved like every sensitive key, valid until `until`.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('security.field_reencryption', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('security.field_reencryption', 'global', '{"until": null}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: هیچ اجرایی مجاز نیست (مهاجرت 0077)', now());--> statement-breakpoint

-- One row per real run; an approval allows one run only (unique). Counts, never values.
CREATE TABLE "field_reencryption_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"authorization_version_id" uuid NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"backup_file" text NOT NULL,
	"counts" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_reencryption_runs_authorization_key" UNIQUE ("authorization_version_id"),
	CONSTRAINT "field_reencryption_runs_outcome_check" CHECK ("outcome" IN ('running', 'completed', 'failed')),
	CONSTRAINT "field_reencryption_runs_finished_check" CHECK (("outcome" = 'running') = ("finished_at" IS NULL))
);--> statement-breakpoint
-- The tool runs as the schema owner, as a migration does (a manual maintenance step): the
-- application role gets nothing on this table, nor any new right on the encrypted columns.
REVOKE ALL ON "field_reencryption_runs" FROM sepehr_app;
