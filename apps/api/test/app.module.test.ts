import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Public, RequirePermission } from '../src/common/auth/auth.decorators';
import { RouteAccessAudit } from '../src/common/auth/route-access-audit';

@Controller('forgotten')
class ForgottenController {
  @Public()
  @Get('open')
  open() {
    return {};
  }

  @Get('unmarked')
  unmarked() {
    return {};
  }

  @RequirePermission('no.such_permission' as never)
  @Get('unknown')
  unknown() {
    return {};
  }
}

describe('AppModule', () => {
  beforeAll(() => {
    // Postgres, Redis and the queue connect on first use, so none is needed to compile.
    process.env['DATABASE_URL'] ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    process.env['REDIS_URL'] ??= 'redis://127.0.0.1:1';
    process.env['AUTH_SECRET'] ??= randomBytes(32).toString('base64');
    process.env['FIELD_ENCRYPTION_KEY'] ??= randomBytes(32).toString('base64');
    process.env['BLIND_INDEX_KEY'] ??= randomBytes(32).toString('base64');
    process.env['WEB_ORIGINS'] ??= 'https://app.sepehr.test';
  });

  it('compiles, and every endpoint of the API declares its access', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(RouteAccessAudit).unmarkedRoutes()).toEqual([]);
    await moduleRef.close();
  });

  it('ACCEPTANCE: refuses to start with an endpoint lacking a valid access marker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ForgottenController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await expect(app.init()).rejects.toThrow(
      'Endpoints without a valid access marker:\n  ForgottenController.unknown\n  ForgottenController.unmarked',
    );
    await moduleRef.close();
  });
});
