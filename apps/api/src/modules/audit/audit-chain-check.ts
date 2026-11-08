import { Inject, Injectable, Logger } from '@nestjs/common';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { AuditService } from './audit.service';

/** The notice's code (no dots: notice codes are plain words, task 7-1). */
export const AUDIT_CHAIN_NOTICE = 'audit_chain_broken';

/**
 * Task 9-3 (R6; ASVS 7.3.3, 8.1.4): the audit trail's hash chain checked every night, not only
 * when someone asks (`GET /audit/verify`). A break opens a notice for who may read the trail;
 * a whole chain closes it. The message has the row's sequence number only, nothing personal.
 */
@Injectable()
export class AuditChainCheck {
  private readonly logger = new Logger(AuditChainCheck.name);

  constructor(
    private readonly audit: AuditService,
    @Inject(ADMIN_NOTICES) private readonly notices: AdminNotices,
  ) {}

  async run(now = new Date()): Promise<{ ok: boolean; checked: number }> {
    const result = await this.audit.verify();
    if (result.ok) {
      await this.notices.resolve(AUDIT_CHAIN_NOTICE, now);
    } else {
      this.logger.error(`audit hash chain broken at sequence ${String(result.brokenAt)}`);
      await this.notices.raise(
        AUDIT_CHAIN_NOTICE,
        'audit.read',
        `زنجیره درهم‌سازی سابقه ممیزی از ردیف ${String(result.brokenAt)} شکسته است.`,
        now,
      );
    }
    return { ok: result.ok, checked: result.checked };
  }
}
