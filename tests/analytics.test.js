import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';
import { getWeakestOpeningPhases, getWeakestMotifs } from '../src/repositories/analytics.repo.js';

describe('Analytics part 1 & part 2: openings, phases, time pressure, trend, motifs, weak spots', () => {
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
  let motifFork;
  let motifPin;
  let motifSkewer;

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

    motifFork = await prisma.motif.findUnique({ where: { name: 'fork' } });
    motifPin = await prisma.motif.findUnique({ where: { name: 'pin' } });
    motifSkewer = await prisma.motif.findUnique({ where: { name: 'skewer' } });
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

    const res4 = await fetch(`${baseUrl}/api/v1/analytics/trend`);
    expect(res4.status).toBe(401);

    const res5 = await fetch(`${baseUrl}/api/v1/analytics/motifs`);
    expect(res5.status).toBe(401);
  });

  it('reversed dates return 400', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/analytics/openings?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const resTrend = await fetch(
      `${baseUrl}/api/v1/analytics/trend?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resTrend.status).toBe(400);

    const resMotifs = await fetch(
      `${baseUrl}/api/v1/analytics/motifs?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resMotifs.status).toBe(400);
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

    const resTrend = await fetch(`${baseUrl}/api/v1/analytics/trend`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resTrend.status).toBe(200);
    expect(await resTrend.json()).toEqual([]);

    const resMotifs = await fetch(`${baseUrl}/api/v1/analytics/motifs`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resMotifs.status).toBe(200);
    expect(await resMotifs.json()).toEqual([]);
  });

  it('computes exact expected metrics on a hand-built dataset and respects owner, analyzed and date rules', async () => {
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

  it('trend rolling window on 10 days of hand-computed values', async () => {
    // Hand-Computed 10-day dataset:
    // Days 1..10 (2026-01-01 to 2026-01-10), each day 1 game with 2 moves:
    // Day 1:  best, best     -> 100% -> rolling (1): 100.0%
    // Day 2:  best, mistake  -> 50%  -> rolling (1..2): (100+50)/2 = 75.0%
    // Day 3:  mistake, mistake -> 0% -> rolling (1..3): (100+50+0)/3 = 50.0%
    // Day 4:  good, good     -> 100% -> rolling (1..4): (100+50+0+100)/4 = 62.5%
    // Day 5:  best, good     -> 100% -> rolling (1..5): (100+50+0+100+100)/5 = 70.0%
    // Day 6:  mistake, good  -> 50%  -> rolling (1..6): (100+50+0+100+100+50)/6 = 66.7%
    // Day 7:  best, best     -> 100% -> rolling (1..7): (100+50+0+100+100+50+100)/7 = 71.4%
    // Day 8:  best, best     -> 100% -> rolling (2..8): (50+0+100+100+50+100+100)/7 = 71.4%
    // Day 9:  mistake, mistake -> 0% -> rolling (3..9): (0+100+100+50+100+100+0)/7 = 64.3%
    // Day 10: good, good     -> 100% -> rolling (4..10): (100+100+50+100+100+0+100)/7 = 78.6%

    const accuracies = [
      [classBest, classBest],      // Day 1: 100%
      [classBest, classMistake],   // Day 2: 50%
      [classMistake, classMistake],// Day 3: 0%
      [classGood, classGood],      // Day 4: 100%
      [classBest, classGood],      // Day 5: 100%
      [classMistake, classGood],   // Day 6: 50%
      [classBest, classBest],      // Day 7: 100%
      [classBest, classBest],      // Day 8: 100%
      [classMistake, classMistake],// Day 9: 0%
      [classGood, classGood],      // Day 10: 100%
    ];

    const expectedRolling = [100.0, 75.0, 50.0, 62.5, 70.0, 66.7, 71.4, 71.4, 64.3, 78.6];
    const expectedAcc = [100, 50, 0, 100, 100, 50, 100, 100, 0, 100];
    const expectedCpLoss = [0, 50, 100, 0, 0, 50, 0, 0, 100, 0];

    for (let i = 0; i < 10; i++) {
      const dayNum = String(i + 1).padStart(2, '0');
      const game = await prisma.game.create({
        data: {
          playerAccountId: accountA.id,
          platformId: platform.id,
          externalId: `trend_game_${dayNum}`,
          playedAt: new Date(`2026-01-${dayNum}T12:00:00Z`),
          color: 'white',
          resultId: resultWin.id,
          totalPlies: 2,
          analysisStatus: 'analyzed',
        },
      });

      for (let p = 1; p <= 2; p++) {
        const move = await prisma.move.create({
          data: {
            gameId: game.id,
            ply: p,
            san: 'e4',
            uci: 'e2e4',
            fenBefore: 'fen',
            moverColor: 'white',
            phaseId: phaseOpening.id,
          },
        });
        await prisma.moveClassification.create({
          data: {
            moveId: move.id,
            classificationId: accuracies[i][p - 1].id,
            cpLoss: accuracies[i][p - 1].id === classMistake.id ? 100 : 0,
          },
        });
      }
    }

    const res = await fetch(`${baseUrl}/api/v1/analytics/trend`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const trendData = await res.json();
    expect(trendData).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      const dayNum = String(i + 1).padStart(2, '0');
      expect(trendData[i].day).toBe(`2026-01-${dayNum}`);
      expect(trendData[i].games).toBe(1);
      expect(trendData[i].accuracyPct).toBe(expectedAcc[i]);
      expect(trendData[i].avgCpLoss).toBe(expectedCpLoss[i]);
      expect(trendData[i].rollingAccuracyPct).toBe(expectedRolling[i]);
    }

    // Gap test: Day 30 has a game played on 2026-01-30 (>6 days after 2026-01-10)
    // Its 7-day rolling window must only include days between 2026-01-24 and 2026-01-30,
    // so it must not include any of the earlier days (Day 1..10).
    const gameAfterGap = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'trend_game_gap_30',
        playedAt: new Date('2026-01-30T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 1,
        analysisStatus: 'analyzed',
      },
    });
    const moveGap = await prisma.move.create({
      data: {
        gameId: gameAfterGap.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'fen',
        moverColor: 'white',
        phaseId: phaseOpening.id,
      },
    });
    await prisma.moveClassification.create({
      data: {
        moveId: moveGap.id,
        classificationId: classMistake.id,
        cpLoss: 60,
      },
    });

    const resGap = await fetch(`${baseUrl}/api/v1/analytics/trend`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resGap.status).toBe(200);
    const gapTrendData = await resGap.json();
    expect(gapTrendData).toHaveLength(11);
    const lastDay = gapTrendData[10];
    expect(lastDay.day).toBe('2026-01-30');
    expect(lastDay.accuracyPct).toBe(0);
    expect(lastDay.avgCpLoss).toBe(60);
    // If it were ROWS BETWEEN 6 PRECEDING, it would include previous 6 played days (averaging ~60-70%).
    // With RANGE BETWEEN INTERVAL '6 days' PRECEDING, it only includes Jan 30 itself -> 0.0%.
    expect(lastDay.rollingAccuracyPct).toBe(0);

    // Filter test: from day 8 to day 10
    const resFiltered = await fetch(
      `${baseUrl}/api/v1/analytics/trend?from=2026-01-08T00:00:00Z&to=2026-01-10T23:59:59Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resFiltered.status).toBe(200);
    const filteredData = await resFiltered.json();
    expect(filteredData).toHaveLength(3);
    expect(filteredData[0].day).toBe('2026-01-08');
    expect(filteredData[2].day).toBe('2026-01-10');
  });

  it('motifs rates for a hand-built dataset, separate kinds and filters', async () => {
    // Hand-built Motifs Dataset for User A:
    // Game 1: 4 owner moves (white), played 2026-02-01
    //   - move 1: fork, kind = allowed
    //   - move 2: fork, kind = allowed
    //   - move 3: pin, kind = missed
    //   - move 4: no motif
    // Game 2: 1 opponent move (black), 1 owner move (white), played 2026-02-05
    //   - opponent move: pin, kind = allowed -> MUST BE EXCLUDED!
    //   - owner move: skewer, kind = allowed
    //
    // Total owner moves = 4 + 1 = 5 moves.
    // Error counts:
    //   - fork (allowed): 2 errors -> errorsPer100Moves = (2/5)*100 = 40.0
    //   - pin (missed): 1 error -> errorsPer100Moves = (1/5)*100 = 20.0
    //   - skewer (allowed): 1 error -> errorsPer100Moves = (1/5)*100 = 20.0

    const game1 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'motif_g1',
        playedAt: new Date('2026-02-01T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 4,
        analysisStatus: 'analyzed',
      },
    });

    const m1 = await prisma.move.create({
      data: { gameId: game1.id, ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
    });
    await prisma.moveMotif.create({ data: { moveId: m1.id, motifId: motifFork.id, kind: 'allowed' } });

    const m2 = await prisma.move.create({
      data: { gameId: game1.id, ply: 3, san: 'd4', uci: 'd2d4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
    });
    await prisma.moveMotif.create({ data: { moveId: m2.id, motifId: motifFork.id, kind: 'allowed' } });

    const m3 = await prisma.move.create({
      data: { gameId: game1.id, ply: 5, san: 'Nf3', uci: 'g1f3', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
    });
    await prisma.moveMotif.create({ data: { moveId: m3.id, motifId: motifPin.id, kind: 'missed' } });

    await prisma.move.create({
      data: { gameId: game1.id, ply: 7, san: 'c4', uci: 'c2c4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
    });

    // Game 2:
    const game2 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'motif_g2',
        playedAt: new Date('2026-02-05T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 2,
        analysisStatus: 'analyzed',
      },
    });

    // Opponent move with motif (should be excluded)
    const mOpp = await prisma.move.create({
      data: { gameId: game2.id, ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'fen', moverColor: 'black', phaseId: phaseOpening.id },
    });
    await prisma.moveMotif.create({ data: { moveId: mOpp.id, motifId: motifPin.id, kind: 'allowed' } });

    // Owner move
    const mOwner = await prisma.move.create({
      data: { gameId: game2.id, ply: 3, san: 'd4', uci: 'd2d4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
    });
    await prisma.moveMotif.create({ data: { moveId: mOwner.id, motifId: motifSkewer.id, kind: 'allowed' } });

    const res = await fetch(`${baseUrl}/api/v1/analytics/motifs`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const motifsData = await res.json();

    expect(motifsData).toHaveLength(3);
    expect(motifsData[0]).toEqual({
      motif: 'fork',
      kind: 'allowed',
      errorCount: 2,
      totalMoves: 5,
      errorsPer100Moves: 40,
    });

    const pinAllowed = motifsData.find((m) => m.motif === 'pin' && m.kind === 'allowed');
    expect(pinAllowed).toBeUndefined(); // Opponent's pin must not appear

    const pinMissed = motifsData.find((m) => m.motif === 'pin' && m.kind === 'missed');
    expect(pinMissed).toEqual({
      motif: 'pin',
      kind: 'missed',
      errorCount: 1,
      totalMoves: 5,
      errorsPer100Moves: 20,
    });

    const skewerAllowed = motifsData.find((m) => m.motif === 'skewer' && m.kind === 'allowed');
    expect(skewerAllowed).toEqual({
      motif: 'skewer',
      kind: 'allowed',
      errorCount: 1,
      totalMoves: 5,
      errorsPer100Moves: 20,
    });

    // Test filter: only Game 2 (from 2026-02-04)
    const resFiltered = await fetch(
      `${baseUrl}/api/v1/analytics/motifs?from=2026-02-04T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resFiltered.status).toBe(200);
    const filteredData = await resFiltered.json();
    expect(filteredData).toHaveLength(1);
    expect(filteredData[0].motif).toBe('skewer');
    expect(filteredData[0].totalMoves).toBe(1);
    expect(filteredData[0].errorsPer100Moves).toBe(100);
  });

  it('getWeakestOpeningPhases respects minMoves (19 moves excluded, 20 included) and ordering', async () => {
    // Combination 1: B00 + opening with 19 moves (avgCpLoss = 150) -> EXCLUDED (below minMoves=20)
    // Combination 2: B00 + middlegame with 20 moves (avgCpLoss = 100, errorCount = 5) -> INCLUDED
    // Combination 3: C20 + opening with 25 moves (avgCpLoss = 120, errorCount = 10) -> INCLUDED
    // Combination 4: C20 + endgame with 30 moves (avgCpLoss = 80, errorCount = 2) -> INCLUDED (but limit = 2)
    //
    // Expected top 2:
    // 1. C20 + opening (avgCpLoss = 120)
    // 2. B00 + middlegame (avgCpLoss = 100)

    const gameB00 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'weak_g_b00',
        playedAt: new Date('2026-03-01T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingB00.id,
        totalPlies: 50,
        analysisStatus: 'analyzed',
      },
    });

    // 19 moves in B00 opening (high cpLoss 150, but only 19 moves)
    for (let ply = 1; ply <= 19; ply++) {
      const move = await prisma.move.create({
        data: { gameId: gameB00.id, ply, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
      });
      await prisma.moveClassification.create({
        data: { moveId: move.id, classificationId: classBlunder.id, cpLoss: 150 },
      });
    }

    // 20 moves in B00 middlegame (cpLoss 100, 5 blunders, 15 best)
    for (let ply = 20; ply <= 39; ply++) {
      const isBlunder = ply < 25;
      const move = await prisma.move.create({
        data: { gameId: gameB00.id, ply, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseMiddlegame.id },
      });
      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: isBlunder ? classBlunder.id : classBest.id,
          cpLoss: isBlunder ? 400 : 0, // avg = (5*400)/20 = 100
        },
      });
    }

    const gameC20 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'weak_g_c20',
        playedAt: new Date('2026-03-02T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingC20.id,
        totalPlies: 60,
        analysisStatus: 'analyzed',
      },
    });

    // 25 moves in C20 opening (cpLoss 120, 10 blunders)
    for (let ply = 1; ply <= 25; ply++) {
      const isBlunder = ply <= 10;
      const move = await prisma.move.create({
        data: { gameId: gameC20.id, ply, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
      });
      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: isBlunder ? classBlunder.id : classBest.id,
          cpLoss: isBlunder ? 300 : 0, // avg = (10*300)/25 = 120
        },
      });
    }

    // 30 moves in C20 endgame (cpLoss 80)
    for (let ply = 26; ply <= 55; ply++) {
      const isBlunder = ply <= 27;
      const move = await prisma.move.create({
        data: { gameId: gameC20.id, ply, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseEndgame.id },
      });
      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: isBlunder ? classBlunder.id : classBest.id,
          cpLoss: isBlunder ? 1200 : 0, // avg = (2*1200)/30 = 80
        },
      });
    }

    const weakest = await getWeakestOpeningPhases({ userId: userA.id, limit: 2, minMoves: 20 });
    expect(weakest).toHaveLength(2);

    // 19-move B00 opening must NOT appear
    expect(weakest.find((w) => w.eco === 'B00' && w.phase === 'opening')).toBeUndefined();

    // Top 1: C20 opening (avgCpLoss 120, moves 25, errorCount 10)
    expect(weakest[0].eco).toBe('C20');
    expect(weakest[0].phase).toBe('opening');
    expect(weakest[0].moves).toBe(25);
    expect(weakest[0].avgCpLoss).toBe(120);
    expect(weakest[0].errorCount).toBe(10);

    // Top 2: B00 middlegame (avgCpLoss 100, moves 20, errorCount 5)
    expect(weakest[1].eco).toBe('B00');
    expect(weakest[1].phase).toBe('middlegame');
    expect(weakest[1].moves).toBe(20);
    expect(weakest[1].avgCpLoss).toBe(100);
    expect(weakest[1].errorCount).toBe(5);
  });

  it('getWeakestMotifs combining kinds and respects limit', async () => {
    // Motifs across kinds:
    // fork: 3 allowed + 2 missed = 5 total errors
    // pin: 4 allowed + 0 missed = 4 total errors
    // skewer: 1 allowed + 1 missed = 2 total errors

    const game = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'wm_game',
        playedAt: new Date('2026-04-01T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 20,
        analysisStatus: 'analyzed',
      },
    });

    const addMoveMotif = async (ply, motifId, kind) => {
      const move = await prisma.move.create({
        data: { gameId: game.id, ply, san: 'e4', uci: 'e2e4', fenBefore: 'fen', moverColor: 'white', phaseId: phaseOpening.id },
      });
      await prisma.moveMotif.create({
        data: { moveId: move.id, motifId, kind },
      });
    };

    // Fork (5)
    await addMoveMotif(1, motifFork.id, 'allowed');
    await addMoveMotif(2, motifFork.id, 'allowed');
    await addMoveMotif(3, motifFork.id, 'allowed');
    await addMoveMotif(4, motifFork.id, 'missed');
    await addMoveMotif(5, motifFork.id, 'missed');

    // Pin (4)
    await addMoveMotif(6, motifPin.id, 'allowed');
    await addMoveMotif(7, motifPin.id, 'allowed');
    await addMoveMotif(8, motifPin.id, 'allowed');
    await addMoveMotif(9, motifPin.id, 'allowed');

    // Skewer (2)
    await addMoveMotif(10, motifSkewer.id, 'allowed');
    await addMoveMotif(11, motifSkewer.id, 'missed');

    // Test with limit = 2
    const top2 = await getWeakestMotifs({ userId: userA.id, limit: 2 });
    expect(top2).toHaveLength(2);
    expect(top2[0]).toEqual({ motif: 'fork', errorCount: 5 });
    expect(top2[1]).toEqual({ motif: 'pin', errorCount: 4 });

    // Test with limit = 3
    const top3 = await getWeakestMotifs({ userId: userA.id, limit: 3 });
    expect(top3).toHaveLength(3);
    expect(top3[2]).toEqual({ motif: 'skewer', errorCount: 2 });
  });
});
