import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PaymentProvider, ReceivedEvidence } from '../../common/payment/payment-provider.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { scannerUnavailable } from '../../infra/clamd';
import { detectDocumentType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';

/**
 * The manual receipt (ADR-009): the bank's receipt as a file, scanned first whatever it
 * claims to be, then kept only if its bytes are a PDF, JPEG or PNG (rule 28), in private
 * space under a key the caller made.
 */
@Injectable()
export class ManualReceiptProvider implements PaymentProvider {
  readonly kind = 'manual_receipt' as const;

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  async keepEvidence(storageKey: string, file: Buffer): Promise<ReceivedEvidence> {
    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const scan = await this.scanner.scan(file);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    const mime = detectDocumentType(file);
    if (!mime) throw new BadRequestException({ error: 'unsupported_type' });
    await this.storage.put('private', storageKey, file, mime);
    return {
      storageKey,
      mime,
      sizeBytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
    };
  }
}
