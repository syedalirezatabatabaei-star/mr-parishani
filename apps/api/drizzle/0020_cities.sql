-- 0020 the cities (task 2-11; ADR-010: a city is «one record and one flag»). Drafted by
-- drizzle-kit for the config module, then extended by hand (ADR-003). Expand only: a new
-- table, read by the application, filled here. Nothing refers to it yet: centers, holidays
-- and configuration keep their city codes as they are (a reference may follow later).

CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cities_code_key" ON "cities" USING btree ("code") WHERE "cities"."deleted_at" IS NULL;--> statement-breakpoint

-- === Checks =================================================================================
-- The same form as every city code already stored (contracts: lowercase snake_case).
ALTER TABLE "cities" ADD CONSTRAINT "cities_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_name_check" CHECK (length(btrim("name")) BETWEEN 2 AND 100);--> statement-breakpoint

-- === Timestamps, no deletes, read only for the application ================================
CREATE TRIGGER cities_set_updated_at BEFORE UPDATE ON "cities"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER cities_no_delete BEFORE DELETE ON "cities"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE INSERT, UPDATE ON "cities" FROM sepehr_app;--> statement-breakpoint

-- === The cities ============================================================================
-- The pilot runs in Isfahan only (owner decision, task 2-11): the one active city. The others
-- are known, inactive until the network works there (TODO(decision): the next cities).
INSERT INTO "cities" ("code", "name", "active", "sort_order") VALUES
  ('isfahan', 'اصفهان', true, 1),
  ('tehran', 'تهران', false, 2),
  ('karaj', 'کرج', false, 3),
  ('mashhad', 'مشهد', false, 4),
  ('shiraz', 'شیراز', false, 5),
  ('tabriz', 'تبریز', false, 6),
  ('qom', 'قم', false, 7),
  ('ahvaz', 'اهواز', false, 8),
  ('kermanshah', 'کرمانشاه', false, 9),
  ('rasht', 'رشت', false, 10);
