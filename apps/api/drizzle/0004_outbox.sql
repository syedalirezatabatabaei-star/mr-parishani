-- 0004 outbox and queues (task 0-7, ADR-005). Hand-written (ADR-003): the tables are
-- partitioned by month and written with explicit SQL only, like the audit trail, so they
-- are not in the Drizzle schema.

-- Domain events, written in the same transaction as the change they describe. The worker
-- relays unpublished rows to BullMQ (job id = event id) and then sets published_at. Rows
-- are never deleted; old months are detached (archived) after the retention.
CREATE TABLE "outbox_events" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	PRIMARY KEY ("id", "created_at"),
	CONSTRAINT "outbox_events_type_check" CHECK ("event_type" ~ '^[a-z]+\.[a-z][a-z_]*$'),
	CONSTRAINT "outbox_events_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z_]*$'),
	CONSTRAINT "outbox_events_attempts_check" CHECK ("attempts" >= 0)
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
-- The relay's work list: only unpublished rows.
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at", "created_at")
  WHERE "published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type", "aggregate_id", "created_at");--> statement-breakpoint

-- One row per (event, consumer) that took effect: written in the consumer's own
-- transaction, so a redelivered event finds it and does nothing. Partitioned by the
-- event's time, which never changes for an event, so the unique key holds across
-- partitions.
CREATE TABLE "processed_events" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"event_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "event_created_at"),
	CONSTRAINT "processed_events_once_key" UNIQUE ("event_id", "consumer", "event_created_at"),
	CONSTRAINT "processed_events_consumer_check" CHECK ("consumer" ~ '^[a-z][a-z0-9_.-]{1,99}$')
) PARTITION BY RANGE ("event_created_at");--> statement-breakpoint

-- The relay may record only publication and retries; the content of an event never
-- changes. processed_events is append-only.
REVOKE UPDATE ON "outbox_events" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("published_at", "attempts", "last_error", "available_at") ON "outbox_events" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "processed_events" FROM sepehr_app;--> statement-breakpoint
CREATE TRIGGER processed_events_append_only BEFORE UPDATE OR DELETE ON "processed_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER outbox_events_no_delete BEFORE DELETE ON "outbox_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Monthly partitions for every partitioned operational table, run by the worker's daily
-- scheduled job as sepehr_app. SECURITY DEFINER, so the worker needs no owner password;
-- in exchange the function does only this and checks what it is asked:
--   - only the four tables below;
--   - at most 24 months ahead;
--   - never detaches the current or the previous month, whatever the cutoff;
--   - never detaches an outbox month that still holds unpublished events.
-- Detached partitions stay as archive tables the application can no longer read.
-- Replaces audit_ensure_partitions / audit_detach_partitions_before (migration 0002),
-- which stay for now (expand/contract). TODO(contract): drop them in a later migration.
CREATE FUNCTION public.maintain_monthly_partitions(parents text[], first_month date, months integer, cutoff date)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed CONSTANT text[] := ARRAY['audit_events', 'access_logs', 'outbox_events', 'processed_events'];
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
      -- Reached only through the parent, whose privileges apply; the default privileges
      -- would otherwise give UPDATE on the partition itself.
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
REVOKE ALL ON FUNCTION public.maintain_monthly_partitions(text[], date, integer, date) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.maintain_monthly_partitions(text[], date, integer, date) TO sepehr_app;--> statement-breakpoint

-- This month and the next twelve (the parents are owned by sepehr_owner, who runs this).
SELECT public.maintain_monthly_partitions(
  ARRAY['outbox_events', 'processed_events'],
  (now() AT TIME ZONE 'UTC')::date, 13, '1970-01-01'
);--> statement-breakpoint

-- Operational settings (task 0-7 decisions), changed from the panel by two people.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('ops.outbox_alert_thresholds', 'technical', true),
  ('ops.queue_alert_thresholds', 'technical', true),
  ('ops.outbox_retention', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('ops.outbox_alert_thresholds', 'global', '{"maxPending": 1000, "maxOldestPendingSeconds": 300}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0004)', now()),
  ('ops.queue_alert_thresholds', 'global', '{"maxWaiting": 5000, "maxFailed": 0}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0004)', now()),
  ('ops.outbox_retention', 'global', '{"months": 6}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0004)', now());
