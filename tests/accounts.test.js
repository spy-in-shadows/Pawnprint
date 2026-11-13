import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

describe('Accounts endpoints and ownership', () => {
  let app;
  let server;
  let baseUrl;

  let userA;
  let userB;
  let tokenA;
  let tokenB;

  let lichessPlatform;
  let chesscomPlatform;

  beforeAll(async () => {
    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    await seed(prisma);

    lichessPlatform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    chesscomPlatform = await prisma.platform.findUnique({ where: { name: 'chesscom' } });

    userA = await prisma.user.create({
      data: {
        email: `acc_user_a_${Date.now()}@example.com`,
        passwordHash: 'hash_a',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: `acc_user_b_${Date.now()}@example.com`,
        passwordHash: 'hash_b',
      },
    });
    tokenB = generateToken(userB);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const userIds = [userA?.id, userB?.id].filter(Boolean);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
    await pgPool.end();
  });

  it('unauthenticated requests return 401', async () => {
    const resGet = await fetch(`${baseUrl}/api/v1/accounts`);
    expect(resGet.status).toBe(401);

    const resPost = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'lichess', username: 'player' }),
    });
    expect(resPost.status).toBe(401);

    const resDelete = await fetch(`${baseUrl}/api/v1/accounts/1`, {
      method: 'DELETE',
    });
    expect(resDelete.status).toBe(401);
  });

  it('links an account, lists it, and prevents duplicate linking', async () => {
    const timestamp = Date.now();
    const username = `magnus_${timestamp}`;

    // Link account for user A
    const resLink = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ platform: 'lichess', username }),
    });

    expect(resLink.status).toBe(201);
    const linkedAccount = await resLink.json();
    expect(linkedAccount.username).toBe(username);
    expect(linkedAccount.userId).toBe(userA.id);

    // List accounts for user A
    const resListA = await fetch(`${baseUrl}/api/v1/accounts`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resListA.status).toBe(200);
    const listA = await resListA.json();
    expect(listA.some((acc) => acc.id === linkedAccount.id)).toBe(true);

    // User B should not see user A's linked account
    const resListB = await fetch(`${baseUrl}/api/v1/accounts`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resListB.status).toBe(200);
    const listB = await resListB.json();
    expect(listB.some((acc) => acc.id === linkedAccount.id)).toBe(false);

    // Same user linking the same account twice -> 409
    const resDupUserA = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ platform: 'lichess', username }),
    });
    expect(resDupUserA.status).toBe(409);

    // Another user linking the same username on the same platform -> 409
    const resDupUserB = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ platform: 'lichess', username }),
    });
    expect(resDupUserB.status).toBe(409);
  });

  it('validates platform and username fields on link', async () => {
    // Missing platform
    const resNoPlat = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ username: 'valid_name' }),
    });
    expect(resNoPlat.status).toBe(400);

    // Invalid platform
    const resBadPlat = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ platform: 'invalid_platform', username: 'valid_name' }),
    });
    expect(resBadPlat.status).toBe(400);

    // Missing username
    const resNoUser = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ platform: 'lichess', username: '   ' }),
    });
    expect(resNoUser.status).toBe(400);
  });

  it("deleting another user's account or non-existent account returns 404, valid delete returns 204", async () => {
    const timestamp = Date.now();
    const accountForB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: chesscomPlatform.id,
        username: `hikaru_${timestamp}`,
      },
    });

    // User A attempts to delete User B's account -> 404
    const resDelOther = await fetch(`${baseUrl}/api/v1/accounts/${accountForB.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resDelOther.status).toBe(404);

    // Delete non-existent account -> 404
    const resDelMissing = await fetch(`${baseUrl}/api/v1/accounts/999999999`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resDelMissing.status).toBe(404);

    // Delete invalid non-numeric account ID -> 404
    const resDelInvalid = await fetch(`${baseUrl}/api/v1/accounts/abc`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resDelInvalid.status).toBe(404);

    // User B deletes own account -> 204
    const resDelOwn = await fetch(`${baseUrl}/api/v1/accounts/${accountForB.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resDelOwn.status).toBe(204);

    // Verify it is gone
    const checkDeleted = await prisma.playerAccount.findUnique({
      where: { id: accountForB.id },
    });
    expect(checkDeleted).toBeNull();
  });
});
