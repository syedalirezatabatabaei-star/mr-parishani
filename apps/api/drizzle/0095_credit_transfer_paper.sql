-- 0095 (owner 1405/07/27, ADR-047): a credit transfer is asked with the number of the paper the
-- borrower signed, and approved only with that paper received; its cap is what the purse holds.
-- Add only: one nullable column (set when the transfer is made; the app role may not update it,
-- as 0043 grants UPDATE by column), one append-only table for the receipt, and a new version
-- of wallet.credit_transfer_limits. The guard of credit_transfers is not touched. The flag
-- wallet.credit_transfer_enabled stays off. No ledger row: a transfer posts nothing.
ALTER TABLE "credit_transfers" ADD COLUMN "paper_document_number" text;--> statement-breakpoint
ALTER TABLE "credit_transfers" ADD CONSTRAINT "credit_transfers_paper_document_number_check"
  CHECK ("paper_document_number" IS NULL OR length(trim("paper_document_number")) BETWEEN 1 AND 64);--> statement-breakpoint
CREATE TABLE "credit_transfer_paper_receipts" (
	"transfer_id" uuid PRIMARY KEY NOT NULL REFERENCES "credit_transfers"("id"),
	"received_by" uuid NOT NULL REFERENCES "user_accounts"("id"),
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TRIGGER credit_transfer_paper_receipts_append_only
  BEFORE UPDATE OR DELETE ON "credit_transfer_paper_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_transfer_paper_receipts_no_truncate
  BEFORE TRUNCATE ON "credit_transfer_paper_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "credit_transfer_paper_receipts" FROM sepehr_app;--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('wallet.credit_transfer_limits', 'global', '{"maxAmountRial": null, "maxPerPurse": 2}', now(), 'approved',
   'سقف مبلغ = موجودی کیف مبدأ، سقف تعداد ۲؛ تصمیم مالک ۱۴۰۵/۰۷/۲۷ (ADR-047، مهاجرت 0095)', now());
