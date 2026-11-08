import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './document';
import { openApiApp } from './preview-app';

/**
 * The committed OpenAPI document (packages/api-client/openapi.json) is the API's own: if a
 * route or a schema changes, `pnpm --filter @sepehr/api openapi` must be run and the
 * client regenerated (CLAUDE.md §5). UPDATE_OPENAPI=1 rewrites the files instead.
 */
const COMMITTED = resolve(__dirname, '../../../../packages/api-client/openapi.json');
const UNTYPED = resolve(__dirname, 'untyped-responses.json');

let app: INestApplication;
let document: ReturnType<typeof buildOpenApiDocument>;

beforeAll(async () => {
  app = await openApiApp();
  document = buildOpenApiDocument(app);
}, 60_000);

afterAll(async () => {
  await app.close();
});

type Operation = {
  operationId: string;
  responses: Record<string, { content?: Record<string, unknown> }>;
};

const operations = () =>
  Object.values(document.paths).flatMap((item) => Object.values(item as Record<string, Operation>));

describe('OpenAPI document', () => {
  it('matches the committed one (run `pnpm --filter @sepehr/api openapi`)', () => {
    const generated = `${JSON.stringify(document, null, 2)}\n`;
    if (process.env['UPDATE_OPENAPI'] === '1') writeFileSync(COMMITTED, generated);
    expect(generated).toBe(readFileSync(COMMITTED, 'utf8'));
  });

  it('lists no component schema: every shape is inlined from Zod, so the tsc and SWC builds agree', () => {
    // SWC gives a `z.output<…>` parameter zod's runtime `output` as its type, which swagger
    // would list as an empty schema that the `openapi` CLI (tsc) never writes (RESUME f10).
    expect(document.components?.schemas ?? {}).toEqual({});
  });

  it('describes request bodies and queries from the Zod schemas', () => {
    const verify = document.paths['/api/v1/auth/otp/verify']?.post;
    expect(verify?.requestBody).toMatchObject({
      content: { 'application/json': { schema: { required: ['mobile', 'code', 'client'] } } },
    });
    const search = document.paths['/api/v1/search/doctors']?.get;
    expect(search?.parameters?.map((p) => ('name' in p ? p.name : ''))).toContain('cityCode');
    const me = document.paths['/api/v1/auth/me']?.get?.responses['200'] as
      { content?: { 'application/json'?: { schema?: { required?: string[] } } } } | undefined;
    expect(me?.content?.['application/json']?.schema?.required).toContain('csrfToken');
  });

  it('every JSON answer has a schema, except those still listed (a list that only shrinks)', () => {
    const untyped = operations()
      .filter((op) =>
        Object.entries(op.responses).some(
          ([code, r]) => Number(code) >= 200 && Number(code) < 300 && code !== '204' && !r.content,
        ),
      )
      .map((op) => op.operationId)
      .sort();
    if (process.env['UPDATE_OPENAPI'] === '1') {
      writeFileSync(UNTYPED, `${JSON.stringify(untyped, null, 2)}\n`);
    }
    // A new route needs its @ZodResponse; a route that gets one leaves the list.
    expect(untyped).toEqual(JSON.parse(readFileSync(UNTYPED, 'utf8')));
  });
});
