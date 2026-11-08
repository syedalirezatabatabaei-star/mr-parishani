import { Global, Module } from '@nestjs/common';
import { AUDIT_LOG } from '../../common/audit/audit.port';
import { AuditController } from './audit.controller';
import { AuditChainCheck } from './audit-chain-check';
import { AuditService } from './audit.service';
import { FieldReencryptionService } from './field-reencryption.service';
import { FieldReencryptionRegistry } from '../../security/field-reencryption';

/**
 * Audit trail and access log (task 0-5, doc 04 §7). Global: every module records its
 * important changes through the AUDIT_LOG port.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditChainCheck,
    { provide: AUDIT_LOG, useExisting: AuditService },
    // R4 (task 9-3): the modules register their encrypted tables here; the tool runs them.
    FieldReencryptionRegistry,
    FieldReencryptionService,
  ],
  exports: [AUDIT_LOG, AuditChainCheck, FieldReencryptionRegistry, FieldReencryptionService],
})
export class AuditModule {}
