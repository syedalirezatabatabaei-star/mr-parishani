/**
 * Port to the instrument module (task 4-3): whether an application's physical delivery is
 * done, for its completion (doc 12 §4 items 1–2), without reading the module's tables.
 */
export interface DeliveryStatusPort {
  /**
   * True when a delivery of the application is verified (or archived after) and every
   * instrument of it is verified or held.
   */
  isVerified(creditApplicationId: string): Promise<boolean>;
  /**
   * The application's checked cheques (verified, held, presented or cleared; never one only
   * received, released, bounced or in legal action), for the cheque rule (owner 1405/07/29, ج۵).
   */
  checkedCheques(creditApplicationId: string): Promise<readonly CheckedCheque[]>;
}

export interface CheckedCheque {
  readonly role: 'borrower' | 'guarantor';
  /** Set for a guarantor's cheque. */
  readonly guarantorId: string | null;
  readonly amountRial: bigint;
}

export const DELIVERY_STATUS = Symbol('DELIVERY_STATUS');
