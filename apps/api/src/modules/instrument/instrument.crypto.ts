import { BlindIndex } from '../../security/blind-index';
import { FieldCrypto } from '../../security/field-crypto';
import { keyRingFromEnv } from '../../security/key-ring';

/**
 * Encryption of cheque and note numbers (rule 27; doc 12 §3), as for national ids:
 * FIELD_ENCRYPTION_KEY encrypts, BLIND_INDEX_KEY (a different key) indexes. Each is a ring
 * (R4, ADR-040): every key reads and finds, the active one writes.
 */
export interface InstrumentCrypto {
  readonly fieldCrypto: FieldCrypto;
  readonly blindIndex: BlindIndex;
}

export const INSTRUMENT_CRYPTO = Symbol('INSTRUMENT_CRYPTO');

export const instrumentCryptoFromEnv = (): InstrumentCrypto => ({
  fieldCrypto: new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY')),
  blindIndex: new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY')),
});

/** The encryption context: bound to the column. */
export const INSTRUMENT_NUMBER = 'instruments.number';
