-- 0005 ledger skeleton (task 1-1; doc 02 §1–2; ADR-004, ADR-007, ADR-017). Hand-written
-- (ADR-003: explicit SQL in financial modules); the ledger tables are not in the Drizzle
-- schema and are written only by the ledger module's postJournal().

-- Legal entities (ADR-007). In version one every document belongs to aramesh; sepehr is
-- the intermediary with no income of its own (CLAUDE.md §1).
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "legal_entities_code_key" UNIQUE ("code"),
	CONSTRAINT "legal_entities_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,30}$')
);--> statement-breakpoint
CREATE TRIGGER legal_entities_set_updated_at BEFORE UPDATE ON "legal_entities"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE INSERT, UPDATE ON "legal_entities" FROM sepehr_app;--> statement-breakpoint
INSERT INTO "legal_entities" ("code", "name") VALUES
  ('aramesh', 'آرامش ثروت'),
  ('sepehr', 'سپهر سلامتی');--> statement-breakpoint

-- An account of the ledger (doc 02 §2–3): a logical code such as purse.available, per
-- owner (a borrower's purse, a doctor's payable) or for the company as a whole. Only the
-- name may change after creation; a balance is never stored here (rule 4).
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"currency" text DEFAULT 'IRR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_check" CHECK ("code" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "ledger_accounts_kind_check" CHECK ("kind" IN ('asset', 'liability', 'income', 'expense', 'memo')),
	CONSTRAINT "ledger_accounts_owner_check" CHECK (
	  ("owner_type" = 'company' AND "owner_id" IS NULL)
	  OR ("owner_type" IN ('borrower', 'doctor', 'center') AND "owner_id" IS NOT NULL)
	),
	-- Rials only (rule 1); a second currency would be a decision, not a value.
	CONSTRAINT "ledger_accounts_currency_check" CHECK ("currency" = 'IRR')
);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_owner_code_key" ON "ledger_accounts"
  ("entity_id", "code", "owner_type", "owner_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE TRIGGER ledger_accounts_set_updated_at BEFORE UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE UPDATE ON "ledger_accounts" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name") ON "ledger_accounts" TO sepehr_app;--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_delete BEFORE DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- One financial event (doc 02 §1.2): two or more entries whose debits equal their credits.
-- Append-only (ADR-004): a correction is a reversal document, never an edit (rule 3).
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"case_id" uuid,
	"credit_application_id" uuid,
	-- Rule 5: required and unique; the same key returns the same document.
	"idempotency_key" text NOT NULL,
	-- SHA-256 of the request: the same key with different content is refused.
	"request_hash" text NOT NULL,
	"reverses_journal_entry_id" uuid REFERENCES "journal_entries" ("id"),
	"created_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_idempotency_key_key" UNIQUE ("idempotency_key"),
	-- A document is reversed at most once.
	CONSTRAINT "journal_entries_reverses_key" UNIQUE ("reverses_journal_entry_id"),
	CONSTRAINT "journal_entries_event_type_check" CHECK ("event_type" ~ '^[a-z]+\.[a-z][a-z_]*$'),
	CONSTRAINT "journal_entries_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
	CONSTRAINT "journal_entries_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "journal_entries_reversal_reason_check" CHECK ("reverses_journal_entry_id" IS NULL OR "reason" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "journal_entries_case_idx" ON "journal_entries" ("case_id", "occurred_at") WHERE "case_id" IS NOT NULL;--> statement-breakpoint

-- The entries of a document, partitioned by month. amount_rial is a positive bigint of
-- rials (rule 1); the direction carries the sign.
CREATE TABLE "ledger_entries" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entries" ("id"),
	"account_id" uuid NOT NULL REFERENCES "ledger_accounts" ("id"),
	"direction" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "created_at"),
	CONSTRAINT "ledger_entries_direction_check" CHECK ("direction" IN ('debit', 'credit')),
	CONSTRAINT "ledger_entries_amount_check" CHECK ("amount_rial" > 0)
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" ("account_id", "created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" ("journal_entry_id");--> statement-breakpoint

-- Append-only for everyone (ADR-004, rule 3): the application lacks UPDATE and DELETE,
-- and the triggers stop even the schema owner.
REVOKE UPDATE ON "journal_entries", "ledger_entries" FROM sepehr_app;--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON "journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Entries are written together with their document, in the document's own transaction:
-- nothing can be appended to an existing document later. now() is the start of the
-- transaction, the same inside savepoints, so both rows must carry it.
CREATE FUNCTION public.ledger_entries_same_transaction() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.created_at <> now() OR NOT EXISTS (
    SELECT 1 FROM public.journal_entries j
    WHERE j.id = NEW.journal_entry_id AND j.created_at = now()
  ) THEN
    RAISE EXCEPTION 'entries can only be written with their journal entry, in its transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_same_transaction BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public.ledger_entries_same_transaction();--> statement-breakpoint

-- The second line of defense behind postJournal (doc 02 §1.2, invariant 1): at commit,
-- every document written in the transaction has at least two entries, equal debits and
-- credits, and only accounts of its own legal entity. An unbalanced document cannot be
-- committed, whatever the code does.
CREATE FUNCTION public.journal_entries_check_balanced() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  entries integer;
  debits numeric;
  credits numeric;
  foreign_accounts integer;
  journal_entity text;
BEGIN
  SELECT entity_id INTO journal_entity FROM public.journal_entries WHERE id = NEW.id;
  SELECT count(*),
         coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0),
         coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0),
         count(*) FILTER (WHERE a.entity_id <> journal_entity)
    INTO entries, debits, credits, foreign_accounts
  FROM public.ledger_entries e
  JOIN public.ledger_accounts a ON a.id = e.account_id
  WHERE e.journal_entry_id = NEW.id;
  IF entries < 2 OR debits <> credits OR foreign_accounts > 0 THEN
    RAISE EXCEPTION 'journal entry % is not balanced (entries %, debits %, credits %, foreign accounts %)',
      NEW.id, entries, debits, credits, foreign_accounts
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.journal_entries_check_balanced();--> statement-breakpoint

-- Monthly partitions for ledger_entries too, through the same guarded function; a ledger
-- month is never detached (balances are sums over every entry, rule 4).
CREATE OR REPLACE FUNCTION public.maintain_monthly_partitions(parents text[], first_month date, months integer, cutoff date)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed CONSTANT text[] := ARRAY['audit_events', 'access_logs', 'outbox_events', 'processed_events', 'ledger_entries'];
  never_detached CONSTANT text[] := ARRAY['ledger_entries'];
  latest_cutoff CONSTANT date := (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date;
  month_start date;
  parent_name text;
  part_name text;
  r record;
  pending boolean;
  created integer := 0;
  detached text[] := '{}';
  kept text[] := '{}';
BEGIN
  IF parents IS NULL OR NOT parents <@ allowed THEN
    RAISE EXCEPTION 'only % may be maintained', allowed USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF months < 1 OR months > 24 THEN
    RAISE EXCEPTION 'months must be between 1 and 24' USING ERRCODE = 'check_violation';
  END IF;
  IF cutoff > latest_cutoff THEN
    RAISE EXCEPTION 'cutoff % would archive the current or the previous month', cutoff
      USING ERRCODE = 'check_violation';
  END IF;

  FOREACH parent_name IN ARRAY parents LOOP
    FOR i IN 0 .. months - 1 LOOP
      month_start := (date_trunc('month', first_month) + make_interval(months => i))::date;
      part_name := parent_name || '_' || to_char(month_start, 'YYYY_MM');
      CONTINUE WHEN to_regclass('public.' || part_name) IS NOT NULL;
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_name,
        month_start::text || ' 00:00:00+00',
        (month_start + interval '1 month')::date::text || ' 00:00:00+00'
      );
      EXECUTE format('REVOKE UPDATE ON public.%I FROM sepehr_app', part_name);
      created := created + 1;
    END LOOP;
  END LOOP;

  FOR r IN
    SELECT child.relname AS part_name, parent.relname AS parent_name
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = parent.relnamespace
    WHERE n.nspname = 'public' AND parent.relname = ANY (parents)
      AND NOT parent.relname = ANY (never_detached)
      AND child.relname ~ '_[0-9]{4}_[0-9]{2}$'
      AND (to_date(right(child.relname, 7), 'YYYY_MM') + interval '1 month')::date <= cutoff
    ORDER BY child.relname
  LOOP
    IF r.parent_name = 'outbox_events' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE published_at IS NULL)', r.part_name)
        INTO pending;
      IF pending THEN
        kept := kept || r.part_name;
        CONTINUE;
      END IF;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', r.parent_name, r.part_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM sepehr_app', r.part_name);
    detached := detached || r.part_name;
  END LOOP;

  RETURN jsonb_build_object('created', created, 'detached', to_jsonb(detached), 'keptPending', to_jsonb(kept));
END
$$;
--> statement-breakpoint
SELECT public.maintain_monthly_partitions(
  ARRAY['ledger_entries'], (now() AT TIME ZONE 'UTC')::date, 13, '1970-01-01'
);--> statement-breakpoint

-- Reading the ledger (no endpoint writes to it; modules post through the LEDGER port).
-- Auditors and accounting read; more roles when their modules need it.
INSERT INTO "permissions" ("code") VALUES ('ledger.read');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'ledger.read' FROM "roles" r
WHERE r.code IN ('auditor', 'accounting') AND r.deleted_at IS NULL;
