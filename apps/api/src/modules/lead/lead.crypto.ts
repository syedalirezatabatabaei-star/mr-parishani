import { BlindIndex } from '../../security/blind-index';
import { FieldCrypto } from '../../security/field-crypto';
import { keyRingFromEnv } from '../../security/key-ring';

/**
 * Encryption of persons' national IDs (rule 27), as for centers and doctors:
 * FIELD_ENCRYPTION_KEY encrypts, BLIND_INDEX_KEY (a different key) indexes.
 */
export interface LeadCrypto {
  readonly fieldCrypto: FieldCrypto;
  readonly blindIndex: BlindIndex;
}

export const LEAD_CRYPTO = Symbol('LEAD_CRYPTO');

export const leadCryptoFromEnv = (): LeadCrypto => ({
  fieldCrypto: new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY')),
  blindIndex: new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY')),
});

/** Encryption contexts: bound to the column, as for doctors. */
export const PERSON_NATIONAL_ID = 'persons.national_id';
export const IMPORT_ROW_NATIONAL_ID = 'lead_import_rows.national_id';
