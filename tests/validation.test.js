import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { validate } from '../src/middleware/validate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { seed } from '../prisma/seed/index.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

describe('validate middleware', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/things/:id',
      validate({
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({ name: z.string().min(1), count: z.coerce.number().int() }),
        query: z.object({ flag: z.enum(['a', 'b']).optional() }),
      }),
      (req, res) => res.json({ params: req.params, body: req.body, query: req.validatedQuery })
    );
    app.get('/missing/:id', validate({ params: z.object({ id: z.coerce.number().int() }), paramsNotFound: 'Thing not found' }), (req, res) => res.json({}));
    app.use(errorHandler);
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('replaces body and params with parsed values and stores the query on req.validatedQuery', async () => {
    const res = await fetch(`${base}/things/7?flag=a&extra=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', count: '3', junk: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ params: { id: 7 }, body: { name: 'x', count: 3 }, query: { flag: 'a' } });
  });

  it('lists every failing field of body and query in one 400 message', async () => {
    const res = await fetch(`${base}/things/7?flag=z`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', count: 'many' }),
    });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toMatch(/^Invalid request: /);
    for (const field of ['name:', 'count:', 'flag:']) expect(error.message).toContain(field);
  });

  it('answers malformed params with 400, or 404 when paramsNotFound is given', async () => {
    const bad = await fetch(`${base}/things/abc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('id:');
    const missing = await fetch(`${base}/missing/abc`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { message: 'Thing not found', code: 'NOT_FOUND' } });
  });
});

describe('route validation', () => {
  let server;
  let base;
  let auth;
  let admin;

  beforeAll(async () => {
    await seed(prisma);
    server = await listen(createApp());
    base = `http://127.0.0.1:${server.address().port}`;
    await prisma.user.deleteMany({ where: { email: { startsWith: 'validation_' } } });
    const user = await prisma.user.create({ data: { email: 'validation_user@example.com', passwordHash: 'x' } });
    const adminUser = await prisma.user.create({ data: { email: 'validation_admin@example.com', passwordHash: 'x', role: 'admin' } });
    auth = { Authorization: `Bearer ${generateToken(user)}` };
    admin = { Authorization: `Bearer ${generateToken(adminUser)}` };
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'validation_' } } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  async function call(method, path, { body, headers = auth } = {}) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const expect400 = (result, ...fields) => {
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    for (const field of fields) expect(result.body.error.message).toContain(`${field}:`);
  };

  it('auth register: missing fields, bad email, short password', async () => {
    expect400(await call('POST', '/auth/register', { body: {}, headers: {} }), 'email', 'password');
    expect400(await call('POST', '/auth/register', { body: { email: 'nope', password: 'longenough' }, headers: {} }), 'email');
    expect400(await call('POST', '/auth/register', { body: { email: 'validation_x@example.com', password: 'short' }, headers: {} }), 'password');
  });

  it('auth login: non-string fields are 400, missing ones stay 401', async () => {
    expect400(await call('POST', '/auth/login', { body: { email: 5, password: [] }, headers: {} }), 'email', 'password');
    expect((await call('POST', '/auth/login', { body: {}, headers: {} })).status).toBe(401);
  });

  it('accounts: link body and :id', async () => {
    expect400(await call('POST', '/accounts', { body: {} }), 'platform', 'username');
    expect400(await call('POST', '/accounts', { body: { platform: 'fics', username: 'x' } }), 'platform');
    expect400(await call('POST', '/accounts', { body: { platform: 'lichess', username: '   ' } }), 'username');
    expect((await call('DELETE', '/accounts/abc')).status).toBe(404);
    expect((await call('DELETE', '/accounts/0')).status).toBe(404);
  });

  it('imports: create body and :id', async () => {
    expect400(await call('POST', '/imports', { body: {} }), 'accountId');
    expect400(await call('POST', '/imports', { body: { accountId: 1, maxGames: 'lots', since: 'yesterday' } }), 'maxGames', 'since');
    expect((await call('POST', '/imports', { body: { accountId: -3 } })).status).toBe(404);
    expect((await call('GET', '/imports/xyz')).status).toBe(404);
  });

  it('uploads: non-integer accountId', async () => {
    const form = new FormData();
    form.append('accountId', 'abc');
    form.append('file', new Blob(['[Event "x"]\n\n1. e4 e5 1-0\n']), 'a.pgn');
    const res = await fetch(`${base}/api/v1/uploads/pgn`, { method: 'POST', headers: auth, body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('accountId:');
  });

  it('games: list query and :id', async () => {
    expect400(await call('GET', '/games?accountId=x&opening=Z99&from=never&pageSize=ten'), 'accountId', 'opening', 'from', 'pageSize');
    expect400(await call('GET', '/games?accountId=1&accountId=2'), 'accountId');
    expect((await call('GET', '/games?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await call('GET', '/games?accountId=&opening=&from=')).status).toBe(200);
    expect((await call('GET', '/games/1e3x')).status).toBe(404);
  });

  it('analytics: query filters', async () => {
    for (const path of ['/analytics/openings', '/analytics/phases', '/analytics/time-pressure', '/analytics/trend', '/analytics/motifs']) {
      expect400(await call('GET', `${path}?accountId=-1&to=soon`), 'accountId', 'to');
    }
    expect400(await call('GET', '/analytics/summary?accountId=abc'), 'accountId');
  });

  it('training: item PATCH params and body', async () => {
    expect((await call('PATCH', '/training/plans/x/items/1', { body: { completed: true } })).body.error.message).toBe('Training plan not found');
    expect((await call('PATCH', '/training/plans/1/items/x', { body: { completed: true } })).body.error.message).toBe('Training plan item not found');
    expect400(await call('PATCH', '/training/plans/1/items/1', { body: { completed: 'yes' } }), 'completed');
  });

  it('admin: list query', async () => {
    expect400(await call('GET', '/admin/users?page=first', { headers: admin }), 'page');
    expect((await call('GET', '/admin/users?page=1&pageSize=5', { headers: admin })).status).toBe(200);
  });
});
