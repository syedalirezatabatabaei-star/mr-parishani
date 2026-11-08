import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ACCESS_PORT } from '../../common/auth/access.port';
import { ORG_TREE } from '../../common/auth/org-tree.port';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { AccountMobileCheck } from './account-mobile-check';
import { FieldFilterInterceptor } from './field-filter.interceptor';

/**
 * Permissions, roles, scopes and the center tree (task 0-5, doc 04). Global: the guard of
 * the identity module reaches it through ACCESS_PORT, the catalog module places centers
 * and branches through ORG_TREE (task 2-2).
 */
@Global()
@Module({
  controllers: [AccessController],
  providers: [
    AccessService,
    { provide: ACCESS_PORT, useExisting: AccessService },
    { provide: ORG_TREE, useExisting: AccessService },
    { provide: APP_INTERCEPTOR, useClass: FieldFilterInterceptor },
    // Run daily by the worker (task 4-6); here too, for checks on demand.
    AccountMobileCheck,
  ],
  exports: [ACCESS_PORT, ORG_TREE],
})
export class AccessModule {}
