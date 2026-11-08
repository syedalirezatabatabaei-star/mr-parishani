import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/auth.decorators';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AuditService } from './audit.service';

const listQuerySchema = z.object({
  entityType: z.string().regex(/^[a-z][a-z_]{1,62}$/),
  entityId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** One event of the trail; `seq` is a bigint, as text. */
const auditEventViewSchema = z.object({
  seq: z.string(),
  id: z.uuid(),
  createdAt: z.string(),
  actorAccountId: z.uuid().nullable(),
  actorRoles: z.array(z.string()),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  onBehalfOfDoctorId: z.uuid().nullable(),
  ip: z.string().nullable(),
  sessionId: z.string().nullable(),
});

const chainVerificationSchema = z.object({
  ok: z.boolean(),
  checked: z.int(),
  brokenAt: z.string().nullable(),
});

/** Read-only access to the audit trail, for auditors (doc 04 §3). */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('audit.read')
  @Get('events')
  @ZodResponse(z.array(auditEventViewSchema))
  list(@Query(new ZodBody(listQuerySchema)) query: z.output<typeof listQuerySchema>) {
    return this.audit.list(query);
  }

  /** Recomputes the hash chain; `ok: false` names the first row that was tampered with. */
  @RequirePermission('audit.read')
  @Get('verify')
  @ZodResponse(chainVerificationSchema)
  verify() {
    return this.audit.verify();
  }
}
