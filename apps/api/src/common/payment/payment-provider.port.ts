/**
 * How a payment reaches the company (ADR-009). Version one has one provider, the manual
 * receipt: the payer uploads the bank's receipt and finance approves it. A gateway later
 * is another implementation; the rest does not change.
 */
export interface ReceivedEvidence {
  /** Where the receipt's file is kept, in private space. */
  readonly storageKey: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PaymentProvider {
  readonly kind: 'manual_receipt';
  /**
   * Keeps the evidence of a payment under `storageKey`: scanned, of a real PDF or image
   * type (rule 28), in private space. Refuses anything else.
   */
  keepEvidence(storageKey: string, file: Buffer): Promise<ReceivedEvidence>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
