-- 0056 bank statements imported, and the slip each row suggests (task 6-3; doc 15 §2; owner
-- 1405/07/15). Hand-written (ADR-003). Expand only: three new tables; nothing is posted and
-- no payment changes (approval is task 6-2's path).

-- === One import per file (its hash): the same file again is the same import ==============
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_key" text NOT NULL,
	"column_map" jsonb NOT NULL,
	"rows_count" integer NOT NULL,
	"total_rial" bigint NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_imports_rows_check" CHECK ("rows_count" >= 0 AND "total_rial" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_imports_file_key" ON "bank_statement_imports" ("entity_id", "file_sha256");--> statement-breakpoint
CREATE TRIGGER bank_statement_imports_append_only BEFORE UPDATE OR DELETE ON "bank_statement_imports"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "bank_statement_imports" FROM sepehr_app;--> statement-breakpoint

-- === Each row as read, the slip it suggests, and its review =============================
CREATE TABLE "bank_statement_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"import_id" uuid NOT NULL REFERENCES "bank_statement_imports" ("id"),
	"row_no" integer NOT NULL,
	"paid_on" date,
	"amount_rial" bigint,
	"bank_ref" text,
	"bank_ref_norm" text,
	"description" text,
	"match_kind" text NOT NULL,
	-- The payments module's own slip (same module): a suggestion, never a decision.
	"suggested_payment_id" uuid REFERENCES "payments" ("id"),
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_rows_kind_check"
	  CHECK ("match_kind" IN ('exact', 'probable', 'none', 'invalid')),
	CONSTRAINT "bank_statement_rows_amount_check" CHECK ("amount_rial" IS NULL OR "amount_rial" > 0),
	CONSTRAINT "bank_statement_rows_suggestion_check"
	  CHECK (("match_kind" IN ('exact', 'probable')) = ("suggested_payment_id" IS NOT NULL)),
	CONSTRAINT "bank_statement_rows_review_check"
	  CHECK (("reviewed_at" IS NULL) = ("review_note" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_rows_key" ON "bank_statement_rows" ("import_id", "row_no");--> statement-breakpoint
CREATE INDEX "bank_statement_rows_kind_idx" ON "bank_statement_rows" ("import_id", "match_kind");--> statement-breakpoint
CREATE FUNCTION public.bank_statement_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['reviewed_by', 'reviewed_at', 'review_note'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'bank statement row % keeps what it read and suggested', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'bank statement row % is already reviewed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bank_statement_rows_guard BEFORE UPDATE ON "bank_statement_rows"
  FOR EACH ROW EXECUTE FUNCTION public.bank_statement_rows_guard();--> statement-breakpoint
CREATE TRIGGER bank_statement_rows_no_delete BEFORE DELETE ON "bank_statement_rows"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "bank_statement_rows" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("reviewed_by", "reviewed_at", "review_note") ON "bank_statement_rows" TO sepehr_app;--> statement-breakpoint

-- === The last mapping, offered for the next file (append-only; newest wins) ===============
CREATE TABLE "bank_statement_column_maps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL,
	"column_map" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "bank_statement_column_maps_idx" ON "bank_statement_column_maps" ("entity_id", "created_at" DESC);--> statement-breakpoint
CREATE TRIGGER bank_statement_column_maps_append_only BEFORE UPDATE OR DELETE ON "bank_statement_column_maps"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "bank_statement_column_maps" FROM sepehr_app;
