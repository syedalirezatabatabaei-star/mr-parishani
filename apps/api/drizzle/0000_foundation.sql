-- 0000 foundation (task 0-3). Hand-written and reviewed (ADR-003).
-- Runs as sepehr_owner. The roles themselves are created by `db:bootstrap`, which must run
-- first; passwords never appear in a migration.

-- UUIDv7 primary keys (rule 10). Postgres 17 has no built-in uuidv7(); Postgres 18 adds
-- pg_catalog.uuidv7(), which then takes precedence, and a later migration drops this one.
-- 48-bit Unix time in milliseconds, then random bits, with version 7 and the RFC 9562
-- variant: the v4 UUID already has variant 10 and version 0100; setting bits 52 and 53
-- turns the version into 0111.
CREATE FUNCTION public.uuidv7() RETURNS uuid
  LANGUAGE sql
  VOLATILE
  PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;
--> statement-breakpoint

-- Keeps updated_at current on every UPDATE, including explicit SQL in financial modules.
-- Every table with an updated_at column attaches it:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Least privilege for the application role. sepehr_app may read, insert and update, and
-- nothing else: no DELETE (no physical deletes, rule 7), no TRUNCATE, no DDL. Append-only
-- tables (ledger, audit) additionally revoke UPDATE in their own migration (ADR-004).
GRANT USAGE ON SCHEMA public TO sepehr_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE sepehr_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO sepehr_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE sepehr_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sepehr_app;
