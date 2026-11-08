import { HttpStatus, type INestApplication, type Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodBody } from '../common/zod-body.pipe';
import { ZOD_RESPONSE } from '../common/zod-response';

/**
 * The OpenAPI document of the API (CLAUDE.md §5: packages/api-client is generated from it).
 *
 * @nestjs/swagger finds the routes, methods, path parameters and status codes. The shapes
 * come from the same Zod schemas of @sepehr/contracts that validate each request: a
 * `ZodBody` pipe on `@Body` or `@Query` gives the request's schema, `@ZodResponse` the
 * success body's. So the document cannot drift from what the API checks.
 */

type Json = Record<string, unknown>;
type Operation = Json & {
  operationId?: string;
  parameters?: Json[];
  requestBody?: Json;
  responses?: Record<string, Json>;
};

/** A Zod schema as JSON Schema (2020-12, as OpenAPI 3.1 uses). */
export function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    // A transform (say, to a Date) cannot be described; the JSON on the wire still can.
    unrepresentable: 'any',
  }) as Json;
  delete out['$schema'];
  return out;
}

const operationId = (controller: string, method: string) => `${controller}_${method}`;

interface RouteArg {
  readonly index: number;
  readonly data?: unknown;
  readonly pipes?: readonly unknown[];
}

const zodOf = (arg: RouteArg) =>
  arg.pipes?.find((p): p is ZodBody<z.ZodType> => p instanceof ZodBody)?.schema ?? null;

function controllersOf(app: INestApplication): Type[] {
  const found = new Set<Type>();
  // Typed here: the container's module type does not resolve through @nestjs/core's exports.
  const modules = [...app.get<ModulesContainer>(ModulesContainer).values()] as unknown as {
    controllers: Map<unknown, { metatype: unknown }>;
  }[];
  for (const module of modules) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype;
      if (typeof metatype === 'function') found.add(metatype as Type);
    }
  }
  return [...found];
}

function operationsById(document: OpenAPIObject): Map<string, Operation> {
  const byId = new Map<string, Operation>();
  for (const item of Object.values(document.paths)) {
    for (const op of Object.values(item as Record<string, unknown>)) {
      const operation = op as Operation;
      if (operation.operationId) byId.set(operation.operationId, operation);
    }
  }
  return byId;
}

/** Describes one route's arguments and success body from its Zod schemas. */
function describe(operation: Operation, controller: Type, method: string): void {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
    string,
    RouteArg
  >;
  for (const [key, arg] of Object.entries(args)) {
    const type: RouteParamtypes = Number(key.split(':')[0]);
    const schema = zodOf(arg);
    if (type === RouteParamtypes.BODY && schema) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(schema, 'input') } },
      };
    } else if (type === RouteParamtypes.QUERY && schema) {
      const object = jsonSchema(schema, 'input');
      const properties = (object['properties'] ?? {}) as Record<string, Json>;
      const required = new Set((object['required'] ?? []) as string[]);
      operation.parameters = [
        ...(operation.parameters ?? []).filter((p) => p['in'] !== 'query'),
        ...Object.entries(properties).map(([name, property]) => ({
          name,
          in: 'query',
          required: required.has(name),
          schema: property,
          ...(property['type'] === 'array' ? { style: 'form', explode: true } : {}),
        })),
      ];
    } else if (
      type === RouteParamtypes.PARAM &&
      typeof arg.data === 'string' &&
      !operation.parameters?.some((p) => p['in'] === 'path' && p['name'] === arg.data)
    ) {
      // A path parameter checked by a Zod pipe (e.g. a configuration key) that the explorer
      // did not list; the known gap of RESUME question 9.
      operation.parameters = [
        ...(operation.parameters ?? []),
        {
          name: arg.data,
          in: 'path',
          required: true,
          schema: schema ? jsonSchema(schema, 'input') : { type: 'string' },
        },
      ];
    } else if (type === RouteParamtypes.HEADERS && typeof arg.data === 'string') {
      operation.parameters = [
        ...(operation.parameters ?? []),
        { name: arg.data, in: 'header', required: false, schema: { type: 'string' } },
      ];
    } else if (type === RouteParamtypes.FILE) {
      const field = typeof arg.data === 'string' ? arg.data : 'file';
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { [field]: { type: 'string', format: 'binary' } },
              required: [field],
            },
          },
        },
      };
    }
  }
  // Path ids are UUIDs where ParseUUIDPipe checks them.
  for (const arg of Object.values(args)) {
    if (!arg.pipes?.some((p) => p?.constructor?.name === 'ParseUUIDPipe')) continue;
    const parameter = operation.parameters?.find(
      (p) => p['in'] === 'path' && p['name'] === arg.data,
    );
    if (parameter) parameter['schema'] = { type: 'string', format: 'uuid' };
  }

  const responseSchema = Reflect.getMetadata(
    ZOD_RESPONSE,
    (controller.prototype as Record<string, object>)[method] ?? {},
  ) as z.ZodType | undefined;
  if (responseSchema && operation.responses) {
    const code = Object.keys(operation.responses).find(
      (c) => Number(c) >= 200 && Number(c) < 300 && c !== String(HttpStatus.NO_CONTENT),
    );
    if (code) {
      operation.responses[code] = {
        ...operation.responses[code],
        content: { 'application/json': { schema: jsonSchema(responseSchema, 'output') } },
      };
    }
  }
}

/** Keys in a fixed order, so the committed document changes only when the API does. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted((value as Json)[k])]),
  );
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Sepehr Salamati API')
      .setDescription('Generated from the NestJS routes and the Zod schemas of @sepehr/contracts.')
      .setVersion('1')
      .build(),
    { operationIdFactory: operationId },
  );
  document.openapi = '3.1.0';
  const operations = operationsById(document);
  for (const controller of controllersOf(app)) {
    for (const method of Object.getOwnPropertyNames(controller.prototype)) {
      const operation = operations.get(operationId(controller.name, method));
      if (operation) describe(operation, controller, method);
    }
  }
  dropUnreferencedSchemas(document);
  return sorted(document) as OpenAPIObject;
}

/**
 * Component schemas no operation points to. Under SWC (the tests) a parameter typed
 * `z.output<…>` gets zod's runtime function `output` as its design type, which @nestjs/swagger
 * takes for a class and lists as an empty schema; under tsc (the `openapi` CLI, from dist) the
 * same parameter is `Object` and nothing is listed. Every shape here comes from Zod and is
 * inlined, so a listed schema nobody references is noise from the compiler, not the API, and
 * dropping it makes both builds give one document (RESUME f10).
 */
function dropUnreferencedSchemas(document: OpenAPIObject): void {
  const components = document.components;
  if (!components?.schemas) return;
  const body = JSON.stringify(document.paths);
  components.schemas = Object.fromEntries(
    Object.entries(components.schemas).filter(([name]) =>
      body.includes(`"#/components/schemas/${name}"`),
    ),
  );
}
