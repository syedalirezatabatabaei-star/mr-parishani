/**
 * Port through which other modules learn about a user account without reading the
 * identity module's tables (ADR-002). The identity module provides it under
 * {@link ACCOUNT_DIRECTORY}.
 */
export interface AccountSummary {
  readonly id: string;
  readonly kind: 'patient' | 'staff' | 'center';
  readonly status: 'active' | 'disabled';
  /** Normalized 9XXXXXXXXX: a patient's login key; a staff or center user's, if recorded. */
  readonly mobile: string | null;
  /**
   * Whether `mobile` was proved with a code sent to it (task 4-6): always for a patient (it
   * is their login); for staff and center users, once they verified it themselves.
   */
  readonly mobileVerified: boolean;
  /** A patient's one Person (doc 05), once linked; null otherwise. */
  readonly personId: string | null;
}

export interface AccountDirectory {
  /** The account, or null if it does not exist or was soft-deleted. */
  find(accountId: string): Promise<AccountSummary | null>;
  /**
   * Task 7-3: the name an export's watermark shows: the display name, else the username, else
   * null. Read only.
   */
  nameOf?(accountId: string): Promise<string | null>;
  /**
   * Owner 1405/07/24 (م۱۰): a staff or center account by its username (lowercased, as at
   * login), for the roles page. Never a patient; null when there is none. Read only.
   */
  findStaffByUsername?(username: string): Promise<StaffAccountSummary | null>;
  /**
   * Owner 1405/08/10 (the bell): the active patient accounts of these persons, or of their
   * mobiles; ids only. Read only.
   */
  patientAccountsOf?(personIds: readonly string[], mobiles: readonly string[]): Promise<string[]>;
}

export interface StaffAccountSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly kind: 'staff' | 'center';
  readonly status: 'active' | 'disabled';
}

export const ACCOUNT_DIRECTORY = Symbol('ACCOUNT_DIRECTORY');
