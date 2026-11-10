import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createApp } from '../src/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js';
import {
  AppError, ConflictError, DataError, EngineError, NotFoundError, UnauthorizedError, ValidationError,
} from '../src/utils/errors.js';

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
  let consoleError;

  beforeAll(async () => {
    const app = express();
    app.get('/teapot', () => { throw new AppError(418, 'I am a teapot', 'TEAPOT'); });
    app.get('/missing', async () => { throw new NotFoundError('Game not found'); });
    app.get('/invalid', () => { throw new ValidationError('maxGames must be positive'); });
    app.get('/crash', () => { throw new Error('db password is hunter2'); });
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await listen(app);
    consoleError = console.error;
    console.error = () => {};
  });

  afterAll(() => {
    console.error = consoleError;
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
