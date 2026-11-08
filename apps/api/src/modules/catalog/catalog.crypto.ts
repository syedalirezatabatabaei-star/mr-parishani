import { BlindIndex } from '../../security/blind-index';
import { FieldCrypto } from '../../security/field-crypto';
import { keyRingFromEnv } from '../../security/key-ring';

/**
 * Encryption for the catalog's identifiers and Sheba numbers (rule 27): FIELD_ENCRYPTION_KEY
 * encrypts, BLIND_INDEX_KEY (a different key) indexes. The API refuses to start without
 * either.
 */
export interface CatalogCrypto {
  readonly fieldCrypto: FieldCrypto;
  readonly blindIndex: BlindIndex;
}

export const CATALOG_CRYPTO = Symbol('CATALOG_CRYPTO');

export const catalogCryptoFromEnv = (): CatalogCrypto => ({
  fieldCrypto: new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY')),
  blindIndex: new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY')),
});

/** Encryption contexts, bound to the column and the center's node (shared with re-encryption, R4). */
export const centerIdentifierContext = (nodeId: string) => `centers.identifier:${nodeId}`;
export const centerShebaContext = (nodeId: string) => `centers.sheba:${nodeId}`;
export const DOCTOR_NATIONAL_ID = 'doctors.national_id';
