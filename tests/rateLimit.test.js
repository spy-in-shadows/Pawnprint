import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

describe('Rate limiting middleware', () => {
  let app;
  let server;
  let baseUrl;

  let testAuthLimiter;
  let testApiLimiter;

  beforeAll(async () => {
    testAuthLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 20,
    });

    testApiLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 300,
    });

    app = createApp({
      authRateLimiter: testAuthLimiter,
      apiRateLimiter: testApiLimiter,
    });

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
  });

  it('allows 20 login attempts, and the 21st within a minute returns 429 with Retry-After while other routes still work', async () => {
    testAuthLimiter.reset();

    for (let i = 1; i <= 20; i++) {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `user${i}@example.com`, password: 'pw' }),
      });
      // Not rate limited yet (e.g. 401 or 400 or other, but definitely not 429)
      expect(res.status).not.toBe(429);
      expect(Number(res.headers.get('x-ratelimit-remaining'))).toBe(20 - i);
    }

    // 21st attempt: must be blocked with 429
    const res21 = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user21@example.com', password: 'pw' }),
    });

    expect(res21.status).toBe(429);
    expect(res21.headers.get('retry-after')).toBeDefined();
    expect(Number(res21.headers.get('retry-after'))).toBeGreaterThan(0);
    const body21 = await res21.json();
    expect(body21.error).toBeDefined();
    expect(body21.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // Other routes (e.g. /health or /api/v1/health) should still work fine
    const resOther = await fetch(`${baseUrl}/api/v1/health`);
    expect(resOther.status).toBe(200);
  });

  it('window resets when time advances or counter is cleared', async () => {
    testAuthLimiter.reset();

    const shortWindowLimiter = createRateLimiter({
      windowMs: 50,
      max: 2,
    });

    const miniApp = createApp({
      authRateLimiter: shortWindowLimiter,
      apiRateLimiter: testApiLimiter,
    });

    const miniServer = miniApp.listen(0);
    const miniBaseUrl = `http://127.0.0.1:${miniServer.address().port}`;

    try {
      const r1 = await fetch(`${miniBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@test.com', password: 'pw' }),
      });
      expect(r1.status).not.toBe(429);

      const r2 = await fetch(`${miniBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@test.com', password: 'pw' }),
      });
      expect(r2.status).not.toBe(429);

      const r3 = await fetch(`${miniBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@test.com', password: 'pw' }),
      });
      expect(r3.status).toBe(429);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      const r4 = await fetch(`${miniBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@test.com', password: 'pw' }),
      });
      expect(r4.status).not.toBe(429);
    } finally {
      await new Promise((resolve) => miniServer.close(resolve));
    }
  });
});
