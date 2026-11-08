import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DATABASE, type Database } from '../../db/database.module';
import { columnReencryptor, FieldReencryptionRegistry } from '../../security/field-reencryption';
import {
  IMPORT_ROW_NATIONAL_ID,
  LEAD_CRYPTO,
  type LeadCrypto,
  PERSON_NATIONAL_ID,
} from './lead.crypto';

/** The persons' national ids (with their blind index) and the import rows' (R4, task 9-3). */
@Injectable()
export class LeadReencryption implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEAD_CRYPTO) private readonly crypto: LeadCrypto,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  onModuleInit(): void {
    const { fieldCrypto: crypto, blindIndex } = this.crypto;
    this.registry.register(
      columnReencryptor({
        db: this.db,
        table: 'persons',
        crypto,
        blindIndex,
        columns: [
          {
            column: 'national_id_enc',
            context: () => PERSON_NATIONAL_ID,
            index: { column: 'national_id_index', domain: () => 'national_id' },
          },
        ],
      }),
    );
    this.registry.register(
      columnReencryptor({
        db: this.db,
        table: 'lead_import_rows',
        crypto,
        columns: [{ column: 'national_id_enc', context: () => IMPORT_ROW_NATIONAL_ID }],
      }),
    );
  }
}
