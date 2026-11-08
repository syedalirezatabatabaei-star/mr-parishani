import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  accessIdSchema,
  orgNodeViewSchema,
  permissionListViewSchema,
  assignRoleSchema,
  assignSecretaryRoleSchema,
  createOrgNodeSchema,
  createRoleSchema,
  PERMISSIONS,
  revokeSchema,
  setRolePermissionsSchema,
  myAccessSchema,
  roleAssignmentViewSchema,
  roleViewSchema,
  staffAccountViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  CurrentAuth,
  RequireAnyPermission,
  RequirePermission,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AccessService } from './access.service';

@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** My own permissions and scopes, e.g. for the UI to hide what I cannot use. */
  @SelfService()
  @Get('me')
  @ZodResponse(myAccessSchema)
  async me(@CurrentAuth() auth: AuthContext) {
    const access = await this.access.resolve(auth.accountId);
    return {
      roles: access.roles,
      permissions: [...access.permissions].sort(),
      scopes: access.scopes,
    };
  }

  @RequirePermission('access.read_roles')
  @Get('permissions')
  @ZodResponse(permissionListViewSchema)
  permissions() {
    return PERMISSIONS;
  }

  @RequirePermission('access.read_roles')
  @Get('roles')
  @ZodResponse(z.array(roleViewSchema))
  roles() {
    return this.access.listRoles();
  }

  @RequirePermission('access.manage_roles')
  @Post('roles')
  @ZodResponse(accessIdSchema)
  createRole(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(createRoleSchema)) body: z.output<typeof createRoleSchema>,
  ) {
    return this.access.createRole(actor, body);
  }

  @RequirePermission('access.manage_roles')
  @Put('roles/:id/permissions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setRolePermissions(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(setRolePermissionsSchema)) body: z.output<typeof setRolePermissionsSchema>,
  ) {
    await this.access.setRolePermissions(actor, id, body);
  }

  /** The roles page (owner 1405/07/24, م۱۰): whom to grant, revoke or offboard. */
  @RequireAnyPermission('access.assign_roles', 'identity.request_staff_offboarding')
  @Get('accounts/by-username/:username')
  @ZodResponse(staffAccountViewSchema)
  staffAccount(@Param('username') username: string) {
    return this.access.findStaffAccount(username);
  }

  @RequirePermission('access.assign_roles')
  @Get('accounts/:accountId/assignments')
  @ZodResponse(z.array(roleAssignmentViewSchema))
  assignments(@Param('accountId', new ParseUUIDPipe()) accountId: string) {
    return this.access.listAssignments(accountId);
  }

  @RequirePermission('access.assign_roles')
  @Post('assignments')
  @ZodResponse(accessIdSchema)
  assign(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(assignRoleSchema)) body: z.output<typeof assignRoleSchema>,
  ) {
    return this.access.assignRole(actor, body);
  }

  @RequirePermission('access.assign_roles')
  @Post('assignments/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(revokeSchema)) body: z.output<typeof revokeSchema>,
  ) {
    await this.access.revokeAssignment(actor, id, body.reason);
  }

  /** A doctor granting a role to their own secretary (doc 04 §2). */
  @RequirePermission('access.manage_secretaries')
  @Post('org-nodes/:id/assignments')
  @ZodResponse(accessIdSchema)
  assignSecretary(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(assignSecretaryRoleSchema))
    body: z.output<typeof assignSecretaryRoleSchema>,
  ) {
    return this.access.assignSecretaryRole(actor, access, id, body);
  }

  @RequirePermission('access.read_org')
  @Get('org-nodes')
  @ZodResponse(z.array(orgNodeViewSchema))
  orgNodes(@CurrentAccess() access: EffectiveAccess) {
    return this.access.listOrgNodes(access);
  }

  @RequirePermission('access.read_org')
  @Get('org-nodes/:id')
  @ZodResponse(orgNodeViewSchema)
  async orgNode(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.access.viewOrgNode(actor, access, id);
  }

  @RequirePermission('access.manage_org')
  @Post('org-nodes')
  @ZodResponse(orgNodeViewSchema)
  createOrgNode(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createOrgNodeSchema)) body: z.output<typeof createOrgNodeSchema>,
  ) {
    return this.access.createOrgNode(actor, access, body);
  }
}
