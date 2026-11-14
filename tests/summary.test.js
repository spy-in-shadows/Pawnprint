import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';
import { refreshAccountSummary } from '../src/services/summary.service.js';

describe('Account summary rollup tables and summary endpoint', () => {
  let app;
  let server;
  let baseUrl;

  let userA;
  let userB;
  let tokenA;
  let tokenB;

  let platform;
  let accountA1;
  let accountA2;
  let accountB;

  let phaseOpening;
  let phaseMiddlegame;
  let phaseEndgame;

  let classBest;
  let classGood;
  let classInaccuracy;
  let classMistake;
  let classBlunder;

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

    platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const phases = await prisma.phase.findMany();
    phaseOpening = phases.find((p) => p.name === 'opening');
    phaseMiddlegame = phases.find((p) => p.name === 'middlegame');
    phaseEndgame = phases.find((p) => p.name === 'endgame');

    const classifications = await prisma.classification.findMany();
    classBest = classifications.find((c) => c.name === 'best');
    classGood = classifications.find((c) => c.name === 'good');
    classInaccuracy = classifications.find((c) => c.name === 'inaccuracy');
    classMistake = classifications.find((c) => c.name === 'mistake');
    classBlunder = classifications.find((c) => c.name === 'blunder');
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(async () => {
    const timestamp = Date.now() + Math.floor(Math.random() * 1000000);

    userA = await prisma.user.create({
      data: {
        email: `summary_user_a_${timestamp}@example.com`,
        passwordHash: 'hash',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: `summary_user_b_${timestamp}@example.com`,
        passwordHash: 'hash',
      },
    });
    tokenB = generateToken(userB);

    accountA1 = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: `player_a1_${timestamp}`,
      },
    });

    accountA2 = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: `player_a2_${timestamp}`,
      },
    });

    accountB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: platform.id,
        username: `player_b_${timestamp}`,
      },
    });
  });

  it('zero row for an empty account', async () => {
    await refreshAccountSummary(accountA1.id);

    const sumRes = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id = $1',
      [accountA1.id]
    );
    expect(sumRes.rowCount).toBe(1);
    const summary = sumRes.rows[0];

    expect(summary.total_games).toBe(0);
    expect(summary.analyzed_games).toBe(0);
    expect(summary.total_moves).toBe(0);
    expect(summary.inaccuracies).toBe(0);
    expect(summary.mistakes).toBe(0);
    expect(summary.blunders).toBe(0);
    expect(summary.avg_cp_loss).toBe(0);
    expect(summary.accuracy_pct).toBe(0);
    expect(summary.last_game_at).toBeNull();
    expect(summary.refreshed_at).toBeInstanceOf(Date);

    const phaseRes = await pgPool.query(
      'SELECT * FROM account_phase_summary WHERE player_account_id = $1 ORDER BY phase_id ASC',
      [accountA1.id]
    );
    expect(phaseRes.rowCount).toBe(3);
    for (const row of phaseRes.rows) {
      expect(row.moves).toBe(0);
      expect(row.blunders).toBe(0);
      expect(row.avg_cp_loss).toBe(0);
    }
  });

  it('refresh computes the hand-built expectations', async () => {
    const playedAt = new Date('2026-06-01T12:00:00Z');

    // Analyzed game for accountA1
    const resultWin = await prisma.result.findUnique({ where: { code: 'win' } });
    const game1 = await prisma.game.create({
      data: {
        playerAccountId: accountA1.id,
        platformId: platform.id,
        externalId: `game_summary_1_${Date.now()}`,
        playedAt,
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 4,
        analysisStatus: 'analyzed',
      },
    });

    // 2 white moves (owner), 2 black moves (opponent)
    // Move 1 (ply 1, white, opening): best, cp_loss 5
    const m1 = await prisma.move.create({
      data: {
        gameId: game1.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'startpos',
        moverColor: 'white',
        phaseId: phaseOpening.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: m1.id,
        classificationId: classBest.id,
        cpLoss: 5,
      },
    });

    // Move 2 (ply 2, black, opening): blunder, cp_loss 300 (opponent move - should be ignored!)
    const m2 = await prisma.move.create({
      data: {
        gameId: game1.id,
        ply: 2,
        san: 'e5',
        uci: 'e7e5',
        fenBefore: 'fen',
        moverColor: 'black',
        phaseId: phaseOpening.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: m2.id,
        classificationId: classBlunder.id,
        cpLoss: 300,
      },
    });

    // Move 3 (ply 3, white, middlegame): mistake, cp_loss 120
    const m3 = await prisma.move.create({
      data: {
        gameId: game1.id,
        ply: 3,
        san: 'Nf3',
        uci: 'g1f3',
        fenBefore: 'fen',
        moverColor: 'white',
        phaseId: phaseMiddlegame.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: m3.id,
        classificationId: classMistake.id,
        cpLoss: 120,
      },
    });

    // Move 4 (ply 4, black, middlegame): good
    const m4 = await prisma.move.create({
      data: {
        gameId: game1.id,
        ply: 4,
        san: 'Nc6',
        uci: 'b8c6',
        fenBefore: 'fen',
        moverColor: 'black',
        phaseId: phaseMiddlegame.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: m4.id,
        classificationId: classGood.id,
        cpLoss: 10,
      },
    });

    // Also create a pending game that is not yet analyzed
    await prisma.game.create({
      data: {
        playerAccountId: accountA1.id,
        platformId: platform.id,
        externalId: `game_pending_${Date.now()}`,
        playedAt: new Date('2026-06-02T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 20,
        analysisStatus: 'pending',
      },
    });

    await refreshAccountSummary(accountA1.id);

    const sumRes = await pgPool.query(
      `SELECT
        total_games,
        analyzed_games,
        total_moves,
        inaccuracies,
        mistakes,
        blunders,
        avg_cp_loss,
        accuracy_pct,
        TO_CHAR(last_game_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_game_at_str
      FROM account_summary WHERE player_account_id = $1`,
      [accountA1.id]
    );
    const summary = sumRes.rows[0];

    expect(summary.total_games).toBe(2);
    expect(summary.analyzed_games).toBe(1);
    expect(summary.total_moves).toBe(2); // only 2 white moves
    expect(summary.inaccuracies).toBe(0);
    expect(summary.mistakes).toBe(1);
    expect(summary.blunders).toBe(0);
    // avgCpLoss = (5 + 120) / 2 = 62.5
    expect(summary.avg_cp_loss).toBe(62.5);
    // accuracyPct = 1 best out of 2 moves = 50.0%
    expect(summary.accuracy_pct).toBe(50.0);
    expect(new Date(summary.last_game_at_str).toISOString()).toBe(playedAt.toISOString());

    // Phase checks
    const phaseRes = await pgPool.query(
      `
      SELECT p.name, aps.*
      FROM account_phase_summary aps
      JOIN phases p ON aps.phase_id = p.id
      WHERE aps.player_account_id = $1
      ORDER BY p.id ASC
      `,
      [accountA1.id]
    );

    const openingRow = phaseRes.rows.find((r) => r.name === 'opening');
    expect(openingRow.moves).toBe(1);
    expect(openingRow.blunders).toBe(0);
    expect(openingRow.avg_cp_loss).toBe(5.0);

    const middlegameRow = phaseRes.rows.find((r) => r.name === 'middlegame');
    expect(middlegameRow.moves).toBe(1);
    expect(middlegameRow.blunders).toBe(0);
    expect(middlegameRow.avg_cp_loss).toBe(120.0);

    const endgameRow = phaseRes.rows.find((r) => r.name === 'endgame');
    expect(endgameRow.moves).toBe(0);
    expect(endgameRow.blunders).toBe(0);
    expect(endgameRow.avg_cp_loss).toBe(0);
  });

  it('idempotent: running twice gives identical rows except refreshed_at', async () => {
    await refreshAccountSummary(accountA1.id);
    const run1 = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id = $1',
      [accountA1.id]
    );
    const phases1 = await pgPool.query(
      'SELECT * FROM account_phase_summary WHERE player_account_id = $1 ORDER BY phase_id ASC',
      [accountA1.id]
    );

    await new Promise((r) => setTimeout(r, 20));

    await refreshAccountSummary(accountA1.id);
    const run2 = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id = $1',
      [accountA1.id]
    );
    const phases2 = await pgPool.query(
      'SELECT * FROM account_phase_summary WHERE player_account_id = $1 ORDER BY phase_id ASC',
      [accountA1.id]
    );

    const { refreshed_at: r1, ...rest1 } = run1.rows[0];
    const { refreshed_at: r2, ...rest2 } = run2.rows[0];
    expect(rest1).toEqual(rest2);
    expect(phases1.rows).toEqual(phases2.rows);
  });

  it('second refresh after adding a game updates the numbers', async () => {
    await refreshAccountSummary(accountA1.id);
    const sum1 = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id = $1',
      [accountA1.id]
    );
    expect(sum1.rows[0].total_games).toBe(0);

    const resultWin = await prisma.result.findUnique({ where: { code: 'win' } });
    const g = await prisma.game.create({
      data: {
        playerAccountId: accountA1.id,
        platformId: platform.id,
        externalId: `game_new_${Date.now()}`,
        playedAt: new Date('2026-07-01T00:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 2,
        analysisStatus: 'analyzed',
      },
    });

    const m = await prisma.move.create({
      data: {
        gameId: g.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'startpos',
        moverColor: 'white',
        phaseId: phaseOpening.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: m.id,
        classificationId: classBlunder.id,
        cpLoss: 400,
      },
    });

    await refreshAccountSummary(accountA1.id);
    const sum2 = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id = $1',
      [accountA1.id]
    );

    expect(sum2.rows[0].total_games).toBe(1);
    expect(sum2.rows[0].analyzed_games).toBe(1);
    expect(sum2.rows[0].total_moves).toBe(1);
    expect(sum2.rows[0].blunders).toBe(1);
    expect(sum2.rows[0].avg_cp_loss).toBe(400);
  });

  it('endpoint returns data and never another user account, and lazy refresh creates the row', async () => {
    // Neither accountA1 nor accountA2 has summary rows yet
    const preCheck = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id IN ($1, $2)',
      [accountA1.id, accountA2.id]
    );
    expect(preCheck.rowCount).toBe(0);

    // GET /api/v1/analytics/summary without accountId -> lazy refreshes both accounts for User A
    const resAll = await fetch(`${baseUrl}/api/v1/analytics/summary`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resAll.status).toBe(200);
    const dataAll = await resAll.json();

    expect(dataAll.accounts).toHaveLength(2);
    const ids = dataAll.accounts.map((a) => a.accountId);
    expect(ids).toContain(accountA1.id);
    expect(ids).toContain(accountA2.id);
    expect(ids).not.toContain(accountB.id);

    const a1Data = dataAll.accounts.find((a) => a.accountId === accountA1.id);
    expect(a1Data).toHaveProperty('totalGames');
    expect(a1Data).toHaveProperty('analyzedGames');
    expect(a1Data).toHaveProperty('totalMoves');
    expect(a1Data).toHaveProperty('inaccuracies');
    expect(a1Data).toHaveProperty('mistakes');
    expect(a1Data).toHaveProperty('blunders');
    expect(a1Data).toHaveProperty('avgCpLoss');
    expect(a1Data).toHaveProperty('accuracyPct');
    expect(a1Data).toHaveProperty('lastGameAt');
    expect(a1Data).toHaveProperty('refreshedAt');
    expect(a1Data.phases).toHaveLength(3);

    // Verify rows now exist in DB (lazy refresh worked)
    const postCheck = await pgPool.query(
      'SELECT * FROM account_summary WHERE player_account_id IN ($1, $2)',
      [accountA1.id, accountA2.id]
    );
    expect(postCheck.rowCount).toBe(2);

    // GET with specific accountId belonging to User A
    const resA1 = await fetch(`${baseUrl}/api/v1/analytics/summary?accountId=${accountA1.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resA1.status).toBe(200);
    const dataA1 = await resA1.json();
    expect(dataA1.accounts).toHaveLength(1);
    expect(dataA1.accounts[0].accountId).toBe(accountA1.id);

    // GET with accountId belonging to User B returns 404
    const resForbidden = await fetch(`${baseUrl}/api/v1/analytics/summary?accountId=${accountB.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resForbidden.status).toBe(404);

    // Unauthenticated request returns 401
    const resNoAuth = await fetch(`${baseUrl}/api/v1/analytics/summary`);
    expect(resNoAuth.status).toBe(401);
  });
});
