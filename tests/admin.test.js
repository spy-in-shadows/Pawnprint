import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';
import { makeAdmin } from '../scripts/makeAdmin.js';

const run = promisify(execFile);

describe('roles and the admin API', () => {
  let server;
  let baseUrl;
  let admin;
  let regular;
  let adminToken;
  let userToken;

  beforeAll(async () => {
    await seed(prisma);
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await prisma.user.deleteMany({ where: { email: { startsWith: 'admintest_' } } });
    admin = await prisma.user.create({ data: { email: 'admintest_admin@example.com', passwordHash: 'HASH_ADMIN_SECRET', role: 'admin' } });
    regular = await prisma.user.create({ data: { email: 'admintest_user@example.com', passwordHash: 'HASH_USER_SECRET' } });
    adminToken = generateToken(admin);
    userToken = generateToken(regular);

    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const win = await prisma.result.findUnique({ where: { code: 'win' } });
    const account = await prisma.playerAccount.create({ data: { userId: regular.id, platformId: platform.id, username: 'admintest_acct' } });
    await prisma.playerAccount.create({ data: { userId: regular.id, platformId: platform.id, username: 'admintest_acct2' } });
    for (let i = 0; i < 3; i += 1) {
      await prisma.game.create({
        data: {
          playerAccountId: account.id, platformId: platform.id, externalId: `admintest_${i}`,
          playedAt: new Date(), color: 'white', resultId: win.id, totalPlies: 0,
        },
      });
    }
    await prisma.analysisJob.create({ data: { playerAccountId: account.id, status: 'completed' } });
    await prisma.analysisJob.create({ data: { playerAccountId: account.id, status: 'failed', error: 'engine' } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'admintest_' } } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  const get = (path, token) =>
    fetch(`${baseUrl}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

  it('new users get the user role and the database rejects unknown roles', async () => {
    expect(regular.role).toBe('user');
    await expect(
      prisma.$executeRaw`UPDATE users SET role = 'root' WHERE id = ${regular.id}`
    ).rejects.toThrow(/users_role_check/);
  });

  it('/me includes the role from the token', async () => {
    const res = await get('/api/v1/me', adminToken);
    expect((await res.json()).user).toEqual({ id: admin.id, email: admin.email, role: 'admin' });
  });

  for (const path of ['/api/v1/admin/users', '/api/v1/admin/jobs']) {
    it(`${path}: no token 401, user 403, admin 200`, async () => {
      const none = await get(path);
      expect(none.status).toBe(401);
      expect((await none.json()).error.code).toBe('UNAUTHORIZED');

      const forbidden = await get(path, userToken);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({
        error: { message: 'You do not have permission to do this', code: 'FORBIDDEN' },
      });

      const ok = await get(path, adminToken);
      expect(ok.status).toBe(200);
    });
  }

  it('GET /admin/users lists counts and never the password hash', async () => {
    const res = await get('/api/v1/admin/users?pageSize=1000', adminToken);
    const text = await res.text();
    expect(text).not.toContain('HASH_');
    expect(text).not.toMatch(/password/i);
    const body = JSON.parse(text);
    expect(body.pageSize).toBe(100);
    const row = body.items.find((u) => u.id === regular.id);
    expect(row).toEqual({
      id: regular.id, email: regular.email, role: 'user',
      createdAt: regular.createdAt.toISOString(), accountCount: 2, gameCount: 3,
    });
    expect(body.items.find((u) => u.id === admin.id)).toMatchObject({ role: 'admin', accountCount: 0, gameCount: 0 });
  });

  it('GET /admin/users paginates', async () => {
    const res = await get('/api/v1/admin/users?page=1&pageSize=1', adminToken);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('GET /admin/jobs returns counts by status and recent jobs', async () => {
    const body = await (await get('/api/v1/admin/jobs', adminToken)).json();
    expect(Object.keys(body.counts).sort()).toEqual(['completed', 'failed', 'queued', 'running']);
    expect(body.counts.completed).toBeGreaterThanOrEqual(1);
    expect(body.counts.failed).toBeGreaterThanOrEqual(1);
    expect(body.recent.length).toBeLessThanOrEqual(20);
    const job = body.recent.find((j) => j.account.username === 'admintest_acct' && j.status === 'failed');
    expect(job).toMatchObject({ error: 'engine', user: { id: regular.id, email: regular.email }, account: { platform: 'lichess' } });
  });

  it('makeAdmin promotes an existing user and reports a missing one', async () => {
    const missing = await makeAdmin('admintest_nobody@example.com');
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/No user with email admintest_nobody@example.com/);

    const ok = await makeAdmin('  AdminTest_User@Example.com ');
    expect(ok.ok).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: regular.id } })).role).toBe('admin');
    await prisma.user.update({ where: { id: regular.id }, data: { role: 'user' } });
  });

  it('npm run make-admin exits 1 with a clear message for an unknown email', async () => {
    const err = await run('node', ['scripts/makeAdmin.js', 'admintest_ghost@example.com'], { env: process.env })
      .then(() => null, (e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('No user with email admintest_ghost@example.com');
  });
});
