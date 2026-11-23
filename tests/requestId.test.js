import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createApp } from '../src/app.js';
import { requestId } from '../src/middleware/requestId.js';
import { requestLogger } from '../src/middleware/requestLogger.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { logger } from '../src/utils/logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}
const url = (server, path) => `http://127.0.0.1:${server.address().port}${path}`;

describe('request id', () => {
  let lines = [];
  let originalWrite;

  beforeAll(() => {
    originalWrite = process.stdout.write;
    process.stdout.write = (chunk, ...args) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      for (const line of text.split('\n')) {
        if (line.startsWith('{')) {
          try { lines.push(JSON.parse(line)); } catch { /* not a log line */ }
        }
      }
      return originalWrite.call(process.stdout, chunk, ...args);
    };
  });
  afterAll(() => { process.stdout.write = originalWrite; });
  beforeEach(() => { lines = []; });

  const waitForLog = async (predicate) => {
    for (let i = 0; i < 50 && !lines.some(predicate); i += 1) await new Promise((r) => setTimeout(r, 10));
    return lines.find(predicate);
  };

  it('every response gets a fresh X-Request-Id, and the request log line carries it', async () => {
    const server = await listen(createApp());
    try {
      const a = await fetch(url(server, '/api/v1/nope'), { headers: { 'X-Request-Id': 'client-chosen' } });
      const b = await fetch(url(server, '/api/v1/nope'));
      const idA = a.headers.get('x-request-id');
      expect(idA).toMatch(UUID);
      expect(b.headers.get('x-request-id')).toMatch(UUID);
      expect(idA).not.toBe(b.headers.get('x-request-id'));

      const log = await waitForLog((l) => l.msg === 'HTTP request' && l.requestId === idA);
      expect(log).toMatchObject({ status: 404, path: '/api/v1/nope' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rate-limited responses carry an id too', async () => {
    const server = await listen(createApp({ apiRateLimiter: createRateLimiter({ max: 0 }) }));
    try {
      const res = await fetch(url(server, '/api/v1/me'));
      expect(res.status).toBe(429);
      expect(res.headers.get('x-request-id')).toMatch(UUID);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a 500 returns error.requestId, and the error log and logs from inside the handler use the same id', async () => {
    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get('/boom', async (req, res, next) => {
      await new Promise((r) => setTimeout(r, 5));
      logger.info('inside handler');
      next(new Error('database password is hunter2'));
    });
    app.use(errorHandler);
    const server = await listen(app);
    try {
      const res = await fetch(url(server, '/boom'));
      const id = res.headers.get('x-request-id');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR', requestId: id } });

      expect(await waitForLog((l) => l.msg === 'inside handler')).toMatchObject({ requestId: id });
      const errorLog = await waitForLog((l) => l.msg === 'Request failed');
      expect(errorLog.requestId).toBe(id);
      expect(errorLog.err.message).toBe('database password is hunter2');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('log lines outside a request have no requestId', () => {
    logger.info('outside any request');
    expect(lines.find((l) => l.msg === 'outside any request')).not.toHaveProperty('requestId');
  });
});
