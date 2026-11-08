/**
 * Port through which the identity module links a patient account to the one `Person` of
 * that mobile number (doc 05: one Person per human, never a second record). The module
 * that owns `Person` provides it; identity never reads that module's tables.
 */
export interface PersonDirectory {
  /**
   * The Person with this normalized mobile (9XXXXXXXXX), created if none exists yet. Null
   * while the mobile is pending (task 9-3): added to a Person who already existed and not
   * yet approved, it stands for nobody.
   */
  findOrCreateByMobile(mobile: string): Promise<{ personId: string | null }>;
  /**
   * A verified OTP login with this mobile (task 9-3): the mobile is proved from now on (its
   * first login is kept), then the Person as {@link findOrCreateByMobile} gives it.
   */
  linkLogin(mobile: string, at: Date): Promise<{ personId: string | null }>;
  /**
   * The mobiles of these person_mobiles rows still live, for the notices of a pending
   * mobile's change (task 9-3): the outbox event carries the ids, never the numbers.
   */
  mobilesByIds(ids: readonly string[]): Promise<string[]>;
  /**
   * Whether a patient login with this mobile still stands for the Person its account is
   * linked to (task 9-3): approved and live, on that Person or one merged with them. False
   * while a merge's re-issue of it is pending, and once it is refused: the account then sees
   * nothing of the Person, though the link itself stays.
   */
  standsFor(mobile: string, personId: string): Promise<boolean>;
}

/** Nest injection token for {@link PersonDirectory}. */
export const PERSON_DIRECTORY = 'PersonDirectory';
