import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';

describe('Health endpoint', () => {
  let app;
  let server;
  let baseUrl;

  beforeAll(async () => {
    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  it('GET /health and GET /api/v1/health return 200 with standard health shape when healthy', async () => {
    const resRoot = await fetch(`${baseUrl}/health`);
    expect(resRoot.status).toBe(200);
    const bodyRoot = await resRoot.json();
    expect(bodyRoot.status).toBe('ok');
    expect(bodyRoot.database).toBeDefined();
    expect(bodyRoot.database.pgPool).toBe('connected');
    expect(bodyRoot.database.prisma).toBe('connected');

    const resV1 = await fetch(`${baseUrl}/api/v1/health`);
    expect(resV1.status).toBe(200);
    const bodyV1 = await resV1.json();
    expect(bodyV1.status).toBe('ok');
    expect(bodyV1.database.pgPool).toBe('connected');
    expect(bodyV1.database.prisma).toBe('connected');
  });

  it('returns 503 and does not leak internal error text when pgPool or prisma fails', async () => {
    app.locals.healthOverrides = {
      pgPool: {
        query: async () => {
          throw new Error('FATAL: password authentication failed for user "internal_secret_chess"');
        },
      },
    };

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.database.pgPool).toBe('disconnected');
    expect(JSON.stringify(body)).not.toContain('internal_secret_chess');

    app.locals.healthOverrides = null;
  });
});
