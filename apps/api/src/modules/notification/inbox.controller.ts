import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { inboxReadSchema, inboxSchema } from '@sepehr/contracts';
import { z } from 'zod';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { CurrentAuth, SelfService, type AuthContext } from '../../common/auth/auth.decorators';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { InboxService, type InboxViewer } from './inbox.service';

/** The bell of every signed-in account, its own items only (owner 1405/08/10). */
@Controller('me/inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
  ) {}

  private async viewer(auth: AuthContext): Promise<InboxViewer> {
    const roles = auth.kind === 'patient' ? [] : (await this.access.resolve(auth.accountId)).roles;
    return { accountId: auth.accountId, kind: auth.kind, roles };
  }

  @SelfService()
  @Get()
  @ZodResponse(inboxSchema)
  async list(@CurrentAuth() auth: AuthContext) {
    return this.inbox.list(await this.viewer(auth));
  }

  @SelfService()
  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ ok: z.literal(true) }))
  async read(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(inboxReadSchema)) body: z.output<typeof inboxReadSchema>,
  ) {
    await this.inbox.markRead(await this.viewer(auth), body);
    return { ok: true as const };
  }
}
