import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

describe('Analytics part 1: openings, phases, time pressure', () => {
  let app;
  let server;
  let baseUrl;

  let userA;
  let userB;
  let tokenA;
  let tokenB;

  let platform;
  let accountA;
  let accountB;

  let resultWin;
  let openingB00;
  let openingC20;
  let tcBlitz;
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
    resultWin = await prisma.result.findUnique({ where: { code: 'win' } });

    openingB00 = await prisma.opening.findFirst({ where: { eco: 'B00' } });
    if (!openingB00) {
      openingB00 = await prisma.opening.create({
        data: { eco: 'B00', name: "King's Pawn" },
      });
    }

    openingC20 = await prisma.opening.findFirst({ where: { eco: 'C20' } });
    if (!openingC20) {
      openingC20 = await prisma.opening.create({
        data: { eco: 'C20', name: "King's Pawn Game" },
      });
    }

    tcBlitz = await prisma.timeControl.findFirst({
      where: { baseSeconds: 180, incrementSeconds: 0 },
    });
    if (!tcBlitz) {
      tcBlitz = await prisma.timeControl.create({
        data: { baseSeconds: 180, incrementSeconds: 0, category: 'blitz' },
      });
    }

    phaseOpening = await prisma.phase.findUnique({ where: { name: 'opening' } });
    phaseMiddlegame = await prisma.phase.findUnique({ where: { name: 'middlegame' } });
    phaseEndgame = await prisma.phase.findUnique({ where: { name: 'endgame' } });

    classBest = await prisma.classification.findUnique({ where: { name: 'best' } });
    classGood = await prisma.classification.findUnique({ where: { name: 'good' } });
    classInaccuracy = await prisma.classification.findUnique({ where: { name: 'inaccuracy' } });
    classMistake = await prisma.classification.findUnique({ where: { name: 'mistake' } });
    classBlunder = await prisma.classification.findUnique({ where: { name: 'blunder' } });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();

    userA = await prisma.user.create({
      data: {
        email: 'user_analytics_a@example.com',
        passwordHash: 'hashA',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: 'user_analytics_b@example.com',
        passwordHash: 'hashB',
      },
    });
    tokenB = generateToken(userB);

    accountA = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: 'analytics_user_a',
      },
    });

    accountB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: platform.id,
        username: 'analytics_user_b',
      },
    });
  });

  it('unauthenticated requests return 401', async () => {
    const res1 = await fetch(`${baseUrl}/api/v1/analytics/openings`);
    expect(res1.status).toBe(401);

    const res2 = await fetch(`${baseUrl}/api/v1/analytics/phases`);
    expect(res2.status).toBe(401);

    const res3 = await fetch(`${baseUrl}/api/v1/analytics/time-pressure`);
    expect(res3.status).toBe(401);
  });

  it('reversed dates return 400', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/analytics/openings?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('empty account returns empty arrays or empty items, not errors', async () => {
    const resOpenings = await fetch(`${baseUrl}/api/v1/analytics/openings`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resOpenings.status).toBe(200);
    expect(await resOpenings.json()).toEqual([]);

    const resPhases = await fetch(`${baseUrl}/api/v1/analytics/phases`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPhases.status).toBe(200);
    expect(await resPhases.json()).toEqual([]);

    const resTp = await fetch(`${baseUrl}/api/v1/analytics/time-pressure`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resTp.status).toBe(200);
    expect(await resTp.json()).toEqual({ items: [], excludedMoves: 0 });
  });

  it('computes exact expected metrics on a hand-built dataset and respects owner, analyzed and date rules', async () => {
    // Seed Dataset Hand-Calculation Proof:
    // Game 1: User A, White, Analyzed, Played 2026-05-10, Opening B00, Base 180s (180,000ms)
    //   - Move 1: ply 1 (White), phase opening, clock 160000ms (>50%), class blunder, cpLoss 250
    //   - Move 2: ply 2 (Black - opponent!), phase opening, clock 170000ms, class best, cpLoss 0 -> MUST BE EXCLUDED!
    //   - Move 3: ply 3 (White), phase opening, clock 100000ms (>50%), class best, cpLoss 10
    //   - Move 4: ply 15 (White), phase middlegame, clock 50000ms (25-50%), class mistake, cpLoss 80
    //   - Move 5: ply 25 (White), phase endgame, clock 25000ms (10-25%), class inaccuracy, cpLoss 40
    //   - Move 6: ply 35 (White), phase endgame, clock 10000ms (<10%), class good, cpLoss 20
    //   - Move 7: ply 37 (White), phase endgame, clock null (excluded from TP), class best, cpLoss 0
    //
    // Game 2: User A, White, PENDING (not analyzed), Played 2026-05-12, Opening B00 -> MUST BE EXCLUDED!
    //   - Move 1: ply 1 (White), class blunder, cpLoss 300
    //
    // Game 3: User B (other user!), White, Analyzed, Played 2026-05-10, Opening B00 -> MUST BE EXCLUDED!
    //   - Move 1: ply 1 (White), class blunder, cpLoss 300
    //
    // Hand Calculations for User A:
    // 1. OPENINGS:
    //    All User A moves are in B00:
    //    - '1-10': moves = 2 (plies 1, 3), blunders = 1 (ply 1), blundersPer100 = 50.0, avgCpLoss = (250+10)/2 = 130.0
    //    - '11-20': moves = 1 (ply 15), blunders = 0, blundersPer100 = 0.0, avgCpLoss = 80.0
    //    - '21-30': moves = 1 (ply 25), blunders = 0, blundersPer100 = 0.0, avgCpLoss = 40.0
    //    - '31+': moves = 2 (plies 35, 37), blunders = 0, blundersPer100 = 0.0, avgCpLoss = (20+0)/2 = 10.0
    //
    // 2. PHASES:
    //    - opening: moves = 2 (plies 1, 3). avgCpLoss = 130.0. best=1, good=0, accuracyPct = (1/2)*100 = 50.0%. blunders=1, mistakes=0, inaccuracies=0
    //    - middlegame: moves = 1 (ply 15). avgCpLoss = 80.0. best=0, good=0, accuracyPct = 0.0%. blunders=0, mistakes=1, inaccuracies=0
    //    - endgame: moves = 3 (plies 25, 35, 37). avgCpLoss = (40+20+0)/3 = 20.0. best=1, good=1, accuracyPct = (2/3)*100 = 66.7%. blunders=0, mistakes=0, inaccuracies=1
    //
    // 3. TIME PRESSURE:
    //    Base = 180,000ms.
    //    - '>50%' (>90,000ms): moves 1 & 3 (160k, 100k) -> moves = 2, blunders = 1, blundersPer100 = 50.0, avgCpLoss = 130.0
    //    - '25-50%' (45,000 to 90,000ms): move 4 (50k) -> moves = 1, blunders = 0, blundersPer100 = 0.0, avgCpLoss = 80.0
    //    - '10-25%' (18,000 to 45,000ms): move 5 (25k) -> moves = 1, blunders = 0, blundersPer100 = 0.0, avgCpLoss = 40.0
    //    - '<10%' (<18,000ms): move 6 (10k) -> moves = 1, blunders = 0, blundersPer100 = 0.0, avgCpLoss = 20.0
    //    - excludedMoves = 1 (move 7 has null clock)

    const game1 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'g1_analyzed',
        playedAt: new Date('2026-05-10T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingB00.id,
        timeControlId: tcBlitz.id,
        totalPlies: 40,
        analysisStatus: 'analyzed',
      },
    });

    const createMoveWithClass = async (gameId, ply, moverColor, phaseId, clockRemainingMs, classId, cpLoss) => {
      const move = await prisma.move.create({
        data: {
          gameId,
          ply,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'startpos',
          moverColor,
          clockRemainingMs,
          phaseId,
        },
      });
      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: classId,
          cpLoss,
        },
      });
      return move;
    };

    // Game 1 moves
    await createMoveWithClass(game1.id, 1, 'white', phaseOpening.id, 160000, classBlunder.id, 250);
    await createMoveWithClass(game1.id, 2, 'black', phaseOpening.id, 170000, classBest.id, 0); // opponent
    await createMoveWithClass(game1.id, 3, 'white', phaseOpening.id, 100000, classBest.id, 10);
    await createMoveWithClass(game1.id, 15, 'white', phaseMiddlegame.id, 50000, classMistake.id, 80);
    await createMoveWithClass(game1.id, 25, 'white', phaseEndgame.id, 25000, classInaccuracy.id, 40);
    await createMoveWithClass(game1.id, 35, 'white', phaseEndgame.id, 10000, classGood.id, 20);
    await createMoveWithClass(game1.id, 37, 'white', phaseEndgame.id, null, classBest.id, 0);

    // Game 2: pending game
    const game2 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'g2_pending',
        playedAt: new Date('2026-05-12T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingB00.id,
        timeControlId: tcBlitz.id,
        totalPlies: 2,
        analysisStatus: 'pending',
      },
    });
    await createMoveWithClass(game2.id, 1, 'white', phaseOpening.id, 160000, classBlunder.id, 300);

    // Game 3: User B game
    const game3 = await prisma.game.create({
      data: {
        playerAccountId: accountB.id,
        platformId: platform.id,
        externalId: 'g3_user_b',
        playedAt: new Date('2026-05-10T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingB00.id,
        timeControlId: tcBlitz.id,
        totalPlies: 2,
        analysisStatus: 'analyzed',
      },
    });
    await createMoveWithClass(game3.id, 1, 'white', phaseOpening.id, 160000, classBlunder.id, 300);

    // Check Openings endpoint
    const resOpenings = await fetch(`${baseUrl}/api/v1/analytics/openings`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resOpenings.status).toBe(200);
    const openingsData = await resOpenings.json();
    expect(openingsData).toHaveLength(4);

    expect(openingsData[0]).toEqual({
      eco: 'B00',
      name: "King's Pawn Opening",
      plyBucket: '1-10',
      moves: 2,
      blunders: 1,
      blundersPer100: 50,
      avgCpLoss: 130,
    });
    expect(openingsData[1]).toEqual({
      eco: 'B00',
      name: "King's Pawn Opening",
      plyBucket: '11-20',
      moves: 1,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 80,
    });
    expect(openingsData[2]).toEqual({
      eco: 'B00',
      name: "King's Pawn Opening",
      plyBucket: '21-30',
      moves: 1,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 40,
    });
    expect(openingsData[3]).toEqual({
      eco: 'B00',
      name: "King's Pawn Opening",
      plyBucket: '31+',
      moves: 2,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 10,
    });

    // Check Phases endpoint
    const resPhases = await fetch(`${baseUrl}/api/v1/analytics/phases`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPhases.status).toBe(200);
    const phasesData = await resPhases.json();
    expect(phasesData).toHaveLength(3);

    expect(phasesData[0]).toEqual({
      phase: 'opening',
      moves: 2,
      avgCpLoss: 130,
      accuracyPct: 50,
      blunders: 1,
      mistakes: 0,
      inaccuracies: 0,
    });
    expect(phasesData[1]).toEqual({
      phase: 'middlegame',
      moves: 1,
      avgCpLoss: 80,
      accuracyPct: 0,
      blunders: 0,
      mistakes: 1,
      inaccuracies: 0,
    });
    expect(phasesData[2]).toEqual({
      phase: 'endgame',
      moves: 3,
      avgCpLoss: 20,
      accuracyPct: 66.7,
      blunders: 0,
      mistakes: 0,
      inaccuracies: 1,
    });

    // Check Time Pressure endpoint
    const resTp = await fetch(`${baseUrl}/api/v1/analytics/time-pressure`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resTp.status).toBe(200);
    const tpData = await resTp.json();
    expect(tpData.excludedMoves).toBe(1);
    expect(tpData.items).toHaveLength(4);

    expect(tpData.items[0]).toEqual({
      bucket: '>50%',
      moves: 2,
      blunders: 1,
      blundersPer100: 50,
      avgCpLoss: 130,
    });
    expect(tpData.items[1]).toEqual({
      bucket: '25-50%',
      moves: 1,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 80,
    });
    expect(tpData.items[2]).toEqual({
      bucket: '10-25%',
      moves: 1,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 40,
    });
    expect(tpData.items[3]).toEqual({
      bucket: '<10%',
      moves: 1,
      blunders: 0,
      blundersPer100: 0,
      avgCpLoss: 20,
    });

    // Date filters test: date after game 1 returns empty
    const resDateFilter = await fetch(
      `${baseUrl}/api/v1/analytics/openings?from=2026-05-15T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resDateFilter.status).toBe(200);
    expect(await resDateFilter.json()).toEqual([]);

    // User B querying analytics sees only their own data
    const resUserB = await fetch(`${baseUrl}/api/v1/analytics/openings`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resUserB.status).toBe(200);
    const userBData = await resUserB.json();
    expect(userBData).toHaveLength(1);
    expect(userBData[0].moves).toBe(1);
    expect(userBData[0].avgCpLoss).toBe(300);
  });
});
