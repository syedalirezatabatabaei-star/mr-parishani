import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DATABASE, type Database } from '../../db/database.module';
import { columnReencryptor, FieldReencryptionRegistry } from '../../security/field-reencryption';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import { totpContext } from './staff-auth.service';

/** The staff's TOTP secrets, each bound to its account (R4, task 9-3). */
@Injectable()
export class IdentityReencryption implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      columnReencryptor({
        db: this.db,
        table: 'user_accounts',
        crypto: this.secrets.fieldCrypto,
        columns: [
          {
            column: 'totp_secret_encrypted',
            context: (row) => totpContext(row['id'] as string),
          },
        ],
      }),
    );
  }
}
