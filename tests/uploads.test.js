import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

describe('Uploads and Imports endpoints', () => {
  let app;
  let server;
  let baseUrl;

  let userA;
  let userB;
  let tokenA;
  let tokenB;

  let lichessPlatform;
  let accountA;
  let accountB;

  const validTwoGamesPgn = `[Event "Live Chess 1"]
[Site "Chess.com"]
[Date "2026.01.01"]
[Round "?"]
[White "PlayerA"]
[Black "Opponent1"]
[Result "1-0"]
[ECO "C20"]
[WhiteElo "1500"]
[BlackElo "1480"]
[TimeControl "300+0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "Live Chess 2"]
[Site "Chess.com"]
[Date "2026.01.02"]
[Round "?"]
[White "Opponent2"]
[Black "PlayerA"]
[Result "0-1"]
[ECO "B20"]
[WhiteElo "1510"]
[BlackElo "1505"]
[TimeControl "180+2"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 0-1
`;

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

    userA = await prisma.user.create({
      data: {
        email: `uploader_a_${Date.now()}@example.com`,
        passwordHash: 'hash_a',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: `uploader_b_${Date.now()}@example.com`,
        passwordHash: 'hash_b',
      },
    });
    tokenB = generateToken(userB);

    accountA = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: lichessPlatform.id,
        username: `user_a_lichess_${Date.now()}`,
      },
    });

    accountB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: lichessPlatform.id,
        username: `user_b_lichess_${Date.now()}`,
      },
    });
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

  it('rejects unauthenticated upload requests with 401', async () => {
    const formData = new FormData();
    const blob = new Blob([validTwoGamesPgn], { type: 'text/plain' });
    formData.append('file', blob, 'games.pgn');

    const res = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      body: formData,
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing file or empty file with 400', async () => {
    // Missing file
    const emptyForm = new FormData();
    const resNoFile = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: emptyForm,
    });
    expect(resNoFile.status).toBe(400);

    // Empty file
    const formEmptyFile = new FormData();
    const emptyBlob = new Blob([''], { type: 'text/plain' });
    formEmptyFile.append('file', emptyBlob, 'empty.pgn');

    const resEmpty = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: formEmptyFile,
    });
    expect(resEmpty.status).toBe(400);
  });

  it('rejects garbage text without valid games with 400', async () => {
    const garbageForm = new FormData();
    const blob = new Blob(['not a pgn at all, just random text'], { type: 'text/plain' });
    garbageForm.append('file', blob, 'random.pgn');

    const res = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: garbageForm,
    });
    expect(res.status).toBe(400);
  });

  it('uploads valid PGN, creates upload account automatically, returns 202 with insertedCount and job', async () => {
    const form = new FormData();
    const blob = new Blob([validTwoGamesPgn], { type: 'text/plain' });
    form.append('file', blob, 'games.pgn');

    const res = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.insertedCount).toBe(2);
    expect(body.skippedCount).toBe(0);
    expect(body.job).toBeDefined();
    expect(body.job.id).toBeDefined();
    expect(body.job.status).toBe('queued');

    // Auto-created upload account check
    const uploadAccount = await prisma.playerAccount.findUnique({
      where: { id: body.job.playerAccountId },
      include: { platform: true },
    });
    expect(uploadAccount.platform.name).toBe('upload');
    expect(uploadAccount.userId).toBe(userA.id);

    // Uploading identical PGN second time should result in 0 inserted and 2 skipped
    const resSecond = await fetch(`${baseUrl}/api/v1/uploads/pgn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });

    expect(resSecond.status).toBe(202);
    const bodySecond = await resSecond.json();
    expect(bodySecond.insertedCount).toBe(0);
    expect(bodySecond.skippedCount).toBe(2);
  });

  it('POST /imports creates a job and dedupes active job on second call', async () => {
    // First call: creates queued job
    const res1 = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        accountId: accountA.id,
        maxGames: 20,
      }),
    });

    expect(res1.status).toBe(202);
    const job1 = await res1.json();
    expect(job1.id).toBeDefined();
    expect(job1.status).toBe('queued');

    // Second call: returns the same active job
    const res2 = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        accountId: accountA.id,
        maxGames: 50,
      }),
    });

    expect(res2.status).toBe(202);
    const job2 = await res2.json();
    expect(job2.id).toBe(job1.id);
  });

  it('POST /imports validates accountId (missing, non-numeric, string conversion, out-of-range)', async () => {
    // Missing accountId -> 400
    const resMissing = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({}),
    });
    expect(resMissing.status).toBe(400);

    // Non-numeric accountId -> 400
    const resNonNumeric = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: 'x' }),
    });
    expect(resNonNumeric.status).toBe(400);

    // Non-integer float -> 400
    const resFloat = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: 1.5 }),
    });
    expect(resFloat.status).toBe(400);

    // Boolean -> 400
    const resBool = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: true }),
    });
    expect(resBool.status).toBe(400);

    // Object -> 400
    const resObj = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: {} }),
    });
    expect(resObj.status).toBe(400);

    // Out-of-range accountId (overflow int4) -> 404
    const resOutOfRange = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: 99999999999 }),
    });
    expect(resOutOfRange.status).toBe(404);

    // Negative / non-positive integer -> 404
    const resNegative = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: 0 }),
    });
    expect(resNegative.status).toBe(404);

    // Foreign user's account ID as a string -> 404
    const resForeign = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: String(accountB.id) }),
    });
    expect(resForeign.status).toBe(404);

    // Numeric string accountId converted to integer -> 202
    const resNumericString = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ accountId: String(accountA.id) }),
    });
    expect(resNumericString.status).toBe(202);
    const bodyNumericString = await resNumericString.json();
    expect(bodyNumericString.playerAccountId).toBe(accountA.id);
  });

  it('POST /imports validates dates (reversed dates -> 400)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        accountId: accountA.id,
        since: '2026-02-01',
        until: '2026-01-01',
      }),
    });

    expect(res.status).toBe(400);
  });

  it("GET /imports/:id returns job status for owner, 404 for another user's job", async () => {
    // Create job for user A
    const resCreate = await fetch(`${baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        accountId: accountA.id,
        maxGames: 10,
      }),
    });
    const jobA = await resCreate.json();

    // Owner fetches status -> 200
    const resOwner = await fetch(`${baseUrl}/api/v1/imports/${jobA.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resOwner.status).toBe(200);
    const statusData = await resOwner.json();
    expect(statusData.id).toBe(jobA.id);
    expect(statusData.status).toBeDefined();
    expect(statusData.completedGames).toBeDefined();

    // User B fetches status for User A's job -> 404
    const resOther = await fetch(`${baseUrl}/api/v1/imports/${jobA.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resOther.status).toBe(404);
  });

  it('GET /imports/:id returns 404 for malformed or out-of-range job id', async () => {
    const resNonNumeric = await fetch(`${baseUrl}/api/v1/imports/abc`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resNonNumeric.status).toBe(404);

    const resOutOfRange = await fetch(`${baseUrl}/api/v1/imports/99999999999`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resOutOfRange.status).toBe(404);

    const resZero = await fetch(`${baseUrl}/api/v1/imports/0`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resZero.status).toBe(404);

    const resNegative = await fetch(`${baseUrl}/api/v1/imports/-1`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resNegative.status).toBe(404);

    const resFloat = await fetch(`${baseUrl}/api/v1/imports/1.5`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resFloat.status).toBe(404);
  });
});
