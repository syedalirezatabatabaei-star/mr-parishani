import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { ResponseSchemaInterceptor } from './common/response-schema.interceptor';
import { listEnv } from './infra/env';

/**
 * Express `trust proxy` from TRUST_PROXY: a hop count (`1`) or addresses and names
 * (`loopback`, `10.0.0.0/8`). A count must reach Express as a number; as a string it is
 * read as an address and fails at start-up.
 */
export function trustProxySetting(value: string): number | string {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
}

/**
 * HTTP setup shared by main.ts and the tests, so tests exercise the real configuration.
 *
 * TRUST_PROXY is passed to Express's `trust proxy`; without it the client IP is the
 * socket peer, which behind a reverse proxy would make every user share one rate-limit
 * bucket.
 *
 * CORS admits the web apps of WEB_ORIGINS with credentials (the session cookie) and the
 * headers the API reads. It is not a security boundary by itself: the guard still checks
 * the origin and the CSRF token of every state-changing cookie request.
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const trustProxy = process.env['TRUST_PROXY'];
  if (trustProxy) express.set('trust proxy', trustProxySetting(trustProxy));
  // No framework banner: it only tells a scanner what to try.
  express.disable('x-powered-by');
  // Task 9-3 (R9; ASVS 8.2.1, 14.4.4): every answer of the API is data for one caller: never
  // sniffed as another type, never stored by a cache, never framed or embedded elsewhere.
  express.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    next();
  });
  express.use(cookieParser());
  app.enableCors({
    origin: listEnv('WEB_ORIGINS'),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-device-id'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1');
  // Tests check every declared response body against its schema (see the interceptor).
  if (process.env['SEPEHR_CHECK_RESPONSES'] === '1') {
    app.useGlobalInterceptors(new ResponseSchemaInterceptor(app.get(Reflector)));
  }
  app.enableShutdownHooks();
}
