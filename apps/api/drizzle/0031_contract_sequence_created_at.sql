-- 0031 (task 4-1): the created_at every table carries (schema conventions), on the
-- contract number sequences of 0030. Expand only: one new column with a default.
ALTER TABLE "contract_number_sequences" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;