import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import config from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { hashToken } from '../src/services/session.service.js';

const EMAIL = 'sessiontest_user@example.com';
const PASSWORD = 'session-pass-123';
const FETCH = { 'X-Requested-With': 'fetch' };

function refreshCookie(res) {
  const line = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  if (!line) return null;
  const [pair, ...attrs] = line.split(';').map((p) => p.trim());
  return { value: decodeURIComponent(pair.slice('refresh_token='.length)), attrs: attrs.map((a) => a.toLowerCase()), line };
}

describe('access and refresh tokens', () => {
  let server;
  let baseUrl;
  let userId;

  beforeAll(async () => {
    server = await new Promise((resolve) => {
      const s = createApp({ corsOrigins: ['http://localhost:5173'] }).listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await prisma.user.deleteMany({ where: { email: { startsWith: 'sessiontest_' } } });
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(201);
    userId = (await res.json()).user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'sessiontest_' } } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  async function login() {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return { body: await res.json(), cookie: refreshCookie(res) };
  }

  const refresh = (value, headers = FETCH) =>
    fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST', headers: { ...headers, ...(value ? { Cookie: `refresh_token=${value}` } : {}) },
    });
  const logout = (value, headers = FETCH) =>
    fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST', headers: { ...headers, ...(value ? { Cookie: `refresh_token=${value}` } : {}) },
    });

  it('login returns a short-lived access token and sets the refresh cookie with the right flags', async () => {
    const { body, cookie } = await login();
    expect(typeof body.token).toBe('string');
    expect(body.user).toEqual({ id: userId, email: EMAIL, role: 'user' });
    expect(body).not.toHaveProperty('refreshToken');

    const payload = jwt.decode(body.token);
    expect(payload.role).toBe('user');
    // Lifetime follows ACCESS_TOKEN_TTL (default 15m).
    if (!process.env.ACCESS_TOKEN_TTL) expect(payload.exp - payload.iat).toBe(15 * 60);

    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.attrs).toEqual(expect.arrayContaining(['httponly', 'samesite=strict', 'path=/api/v1/auth', `max-age=${config.refreshTokenTtlDays * 24 * 3600}`]));
    if (config.nodeEnv !== 'production') expect(cookie.attrs).not.toContain('secure');

    // Only the hash is stored.
    const rows = await prisma.refreshToken.findMany({ where: { userId } });
    expect(rows.some((r) => r.tokenHash === cookie.value)).toBe(false);
    expect(rows.some((r) => r.tokenHash === hashToken(cookie.value))).toBe(true);
  });

  it('each login starts a new family', async () => {
    const a = await login();
    const b = await login();
    const [ra, rb] = await Promise.all([
      prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(a.cookie.value) } }),
      prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(b.cookie.value) } }),
    ]);
    expect(ra.familyId).not.toBe(rb.familyId);
  });

  it('refresh returns a new access token and rotates the cookie', async () => {
    const { cookie } = await login();
    const res = await refresh(cookie.value);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.user).toEqual({ id: userId, email: EMAIL, role: 'user' });
    const next = refreshCookie(res);
    expect(next.value).not.toBe(cookie.value);

    const old = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(cookie.value) } });
    const rotated = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(next.value) } });
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedById).toBe(rotated.id);
    expect(rotated.familyId).toBe(old.familyId);
    expect(rotated.revokedAt).toBeNull();

    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
  });

  it('reusing an old refresh token returns 401 and revokes the whole family', async () => {
    const { cookie } = await login();
    const first = await refresh(cookie.value);
    const second = refreshCookie(first);

    const reuse = await refresh(cookie.value);
    expect(reuse.status).toBe(401);
    expect((await reuse.json()).error.code).toBe('UNAUTHORIZED');

    const family = (await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(cookie.value) } })).familyId;
    const live = await prisma.refreshToken.count({ where: { familyId: family, revokedAt: null } });
    expect(live).toBe(0);

    // The newest token from that family no longer works either.
    expect((await refresh(second.value)).status).toBe(401);
  });

  it('logout revokes the token, clears the cookie and a later refresh returns 401', async () => {
    const { cookie } = await login();
    const res = await logout(cookie.value);
    expect(res.status).toBe(204);
    const cleared = refreshCookie(res);
    expect(cleared.value).toBe('');
    expect(cleared.line.toLowerCase()).toContain('path=/api/v1/auth');
    expect((await refresh(cookie.value)).status).toBe(401);
  });

  it('logout without a cookie is still 204', async () => {
    expect((await logout(null)).status).toBe(204);
  });

  it('unknown and expired refresh tokens return 401', async () => {
    expect((await refresh('not-a-real-token')).status).toBe(401);
    expect((await refresh(null)).status).toBe(401);

    const { cookie } = await login();
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(cookie.value) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await refresh(cookie.value);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe('Refresh token expired');
  });

  it('refresh and logout without X-Requested-With: fetch return 403', async () => {
    const { cookie } = await login();
    for (const call of [refresh, logout]) {
      const res = await call(cookie.value, {});
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    }
    // The token was not consumed by the rejected calls.
    expect((await refresh(cookie.value)).status).toBe(200);
  });

  it('refresh checks the Origin header when present', async () => {
    const { cookie } = await login();
    const evil = await refresh(cookie.value, { ...FETCH, Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);

    const own = await refresh(cookie.value, { ...FETCH, Origin: baseUrl });
    expect(own.status).toBe(200);
    const listed = await refresh(refreshCookie(own).value, { ...FETCH, Origin: 'http://localhost:5173' });
    expect(listed.status).toBe(200);
  });

  it('an expired access token returns 401', async () => {
    const expired = jwt.sign(
      { sub: userId, email: EMAIL, role: 'user', iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const res = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${expired}` } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({ message: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  });

  it('refresh tokens are deleted with their user', async () => {
    const user = await prisma.user.create({ data: { email: 'sessiontest_gone@example.com', passwordHash: 'x' } });
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: 'sessiontest_hash', familyId: 'f', expiresAt: new Date(Date.now() + 1000) },
    });
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.refreshToken.count({ where: { tokenHash: 'sessiontest_hash' } })).toBe(0);
  });
});
