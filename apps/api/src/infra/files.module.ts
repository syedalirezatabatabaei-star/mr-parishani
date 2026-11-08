import { Global, Module } from '@nestjs/common';
import { MALWARE_SCANNER } from '../common/security/malware-scanner.port';
import { OBJECT_STORAGE } from '../common/storage/object-storage.port';
import { clamdScannerFromEnv } from './clamd';
import { s3StorageFromEnv } from './s3-storage';

/**
 * Object storage (S3_*) and the malware scanner (CLAMAV_*), task 2-8. Global: every module
 * that takes files uses OBJECT_STORAGE and MALWARE_SCANNER. Both are optional at start;
 * without them uploads are refused, never taken unscanned or kept elsewhere (rule 28).
 */
@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE, useFactory: () => s3StorageFromEnv() },
    { provide: MALWARE_SCANNER, useFactory: () => clamdScannerFromEnv() },
  ],
  exports: [OBJECT_STORAGE, MALWARE_SCANNER],
})
export class FilesModule {}
