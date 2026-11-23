import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createApp } from '../src/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js';
import {
  AppError, ConflictError, DataError, EngineError, NotFoundError, UnauthorizedError, ValidationError,
} from '../src/utils/errors.js';
import { logger } from '../src/utils/logger.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const baseUrl = (server) => `http://127.0.0.1:${server.address().port}`;

describe('createApp', () => {
  let server;
  beforeAll(async () => { server = await listen(createApp()); });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('returns a JSON 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/anything`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: 'Malformed JSON body', code: 'INVALID_JSON' } });
  });
});

describe('errorHandler', () => {
  let server;
  let logError;

  beforeAll(async () => {
    const app = express();
    app.get('/teapot', () => { throw new AppError(418, 'I am a teapot', 'TEAPOT'); });
    app.get('/missing', async () => { throw new NotFoundError('Game not found'); });
    app.get('/invalid', () => { throw new ValidationError('maxGames must be positive'); });
    app.get('/crash', () => { throw new Error('db password is hunter2'); });
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await listen(app);
    logError = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    logError.mockRestore();
    return new Promise((resolve) => server.close(resolve));
  });

  it('uses the status and code of an AppError', async () => {
    const res = await fetch(`${baseUrl(server)}/teapot`);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: { message: 'I am a teapot', code: 'TEAPOT' } });
  });

  it('handles AppError subclasses thrown from async handlers', async () => {
    const missing = await fetch(`${baseUrl(server)}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { message: 'Game not found', code: 'NOT_FOUND' } });

    const invalid = await fetch(`${baseUrl(server)}/invalid`);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('hides the message and stack of an unknown error behind a generic 500', async () => {
    const res = await fetch(`${baseUrl(server)}/crash`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('at ');
    expect(logError).toHaveBeenCalledWith('Request failed', expect.objectContaining({ method: 'GET', url: '/crash' }));
  });
});

describe('error classes', () => {
  it.each([
    [NotFoundError, 404, 'NOT_FOUND'],
    [ValidationError, 400, 'VALIDATION_ERROR'],
    [UnauthorizedError, 401, 'UNAUTHORIZED'],
    [ConflictError, 409, 'CONFLICT'],
  ])('%o carries its HTTP status and code', (ErrorClass, status, code) => {
    const err = new ErrorClass('boom');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status, code, message: 'boom', name: ErrorClass.name });
  });

  it('flags worker errors so the job runner can tell them apart', () => {
    const data = new DataError('illegal move e9');
    const engine = new EngineError('stockfish timed out');
    expect(data).toMatchObject({ name: 'DataError', isDataError: true, message: 'illegal move e9' });
    expect(engine).toMatchObject({ name: 'EngineError', isEngineError: true });
    expect(data).toBeInstanceOf(Error);
    expect(data).not.toBeInstanceOf(AppError);
    expect(engine.isDataError).toBeUndefined();
  });
});

describe('security headers', () => {
  let server;
  beforeAll(async () => { server = await listen(createApp()); });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('sets nosniff and a CSP and hides X-Powered-By on /api/v1/health', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('sets the headers on 404 responses too', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/nope`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });
});

describe('CORS allowlist', () => {
  let server;
  beforeAll(async () => { server = await listen(createApp({ corsOrigins: ['http://localhost:5173'] })); });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('an allowed origin gets Access-Control-Allow-Origin', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/health`, { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('a disallowed origin does not', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/health`, { headers: { Origin: 'http://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preflight for an allowed origin lists the allowed methods and headers', async () => {
    const res = await fetch(`${baseUrl(server)}/api/v1/games`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,PATCH,DELETE');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type,Authorization');
  });

  it('with the default empty list no origin is allowed', async () => {
    const plain = await listen(createApp({ corsOrigins: [] }));
    try {
      const res = await fetch(`${baseUrl(plain)}/api/v1/health`, { headers: { Origin: 'http://localhost:5173' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await new Promise((resolve) => plain.close(resolve));
    }
  });
});
