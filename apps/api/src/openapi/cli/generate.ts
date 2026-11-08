/**
 * `pnpm --filter @sepehr/api openapi`: writes the OpenAPI document of the API to
 * packages/api-client/openapi.json, from which the client is generated (CLAUDE.md §5).
 * Preview mode: the module graph is read, nothing is started or connected, so no database,
 * Redis or secret is needed.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApiApp } from '../preview-app';
import { buildOpenApiDocument } from '../document';

async function main(): Promise<void> {
  const app = await openApiApp();
  try {
    const target = resolve(__dirname, '../../../../../packages/api-client/openapi.json');
    writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
    console.log(`OpenAPI document written: ${target}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('OpenAPI generation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
