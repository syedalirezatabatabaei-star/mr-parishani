-- 0001 identity (task 0-4). Drafted by drizzle-kit, reviewed and extended by hand (ADR-003):
-- CHECK constraints, the kind/login-key rule and the updated_at triggers are hand-written.

CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"parent_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"client" text NOT NULL,
	"stage" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"device_id" text,
	"device_label" text,
	"ip" text,
	"authenticated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "totp_reset_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"target_account_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mobile" text,
	"username" text,
	"display_name" text,
	"person_id" uuid,
	"password_hash" text,
	"totp_secret_encrypted" text,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_user_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_target_account_id_user_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_requested_by_user_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_decided_by_user_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "totp_reset_requests_target_idx" ON "totp_reset_requests" USING btree ("target_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_patient_mobile_key" ON "user_accounts" USING btree ("mobile") WHERE "user_accounts"."kind" = 'patient' AND "user_accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_username_key" ON "user_accounts" USING btree ("username") WHERE "user_accounts"."deleted_at" IS NULL;--> statement-breakpoint

-- Allowed values of the enum-like text columns.
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_kind_check" CHECK ("kind" IN ('patient', 'staff', 'center'));--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_status_check" CHECK ("status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_check" CHECK ("client" IN ('web', 'mobile'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_stage_check" CHECK ("stage" IN ('mfa_pending', 'active'));--> statement-breakpoint
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint

-- Each kind has its own login key: patients a normalized mobile and no password;
-- staff and center users a username.
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_login_key_check" CHECK (
  ("kind" = 'patient' AND "mobile" ~ '^9[0-9]{9}$' AND "password_hash" IS NULL)
  OR ("kind" IN ('staff', 'center') AND "username" IS NOT NULL)
);--> statement-breakpoint

-- Maker-checker: nobody requests a reset of their own TOTP or approves their own request.
ALTER TABLE "totp_reset_requests" ADD CONSTRAINT "totp_reset_requests_two_people_check" CHECK (
  "requested_by" <> "target_account_id"
  AND ("decided_by" IS NULL OR ("decided_by" <> "requested_by" AND "decided_by" <> "target_account_id"))
);--> statement-breakpoint

CREATE TRIGGER user_accounts_set_updated_at BEFORE UPDATE ON "user_accounts"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER refresh_tokens_set_updated_at BEFORE UPDATE ON "refresh_tokens"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER totp_reset_requests_set_updated_at BEFORE UPDATE ON "totp_reset_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
