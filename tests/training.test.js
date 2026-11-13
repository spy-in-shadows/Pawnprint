import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

describe('Training plan generator and endpoints', () => {
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

  let openingB00;
  let openingC20;
  let phaseOpening;
  let phaseMiddlegame;
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
    openingB00 = await prisma.opening.findFirst({ where: { eco: 'B00' } });
    openingC20 = await prisma.opening.findFirst({ where: { eco: 'C20' } });
    phaseOpening = await prisma.phase.findUnique({ where: { name: 'opening' } });
    phaseMiddlegame = await prisma.phase.findUnique({ where: { name: 'middlegame' } });
    classBlunder = await prisma.classification.findUnique({ where: { name: 'blunder' } });
    motifFork = await prisma.motif.findUnique({ where: { name: 'fork' } });
    motifPin = await prisma.motif.findUnique({ where: { name: 'pin' } });
    motifSkewer = await prisma.motif.findUnique({ where: { name: 'skewer' } });

    userA = await prisma.user.create({
      data: {
        email: `train_user_a_${Date.now()}@test.com`,
        passwordHash: 'hash_a',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: `train_user_b_${Date.now()}@test.com`,
        passwordHash: 'hash_b',
      },
    });
    tokenB = generateToken(userB);

    accountA = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: `train_player_a_${Date.now()}`,
      },
    });

    accountB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: platform.id,
        username: `train_player_b_${Date.now()}`,
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

  it('plan with no weaknesses has zero items and an explanatory message', async () => {
    const res = await fetch(`${baseUrl}/api/v1/training/plans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.plan).toBeDefined();
    expect(data.plan.items).toHaveLength(0);
    expect(data.message).toBeDefined();
    expect(data.message).toContain('import and analyze more games');
  });

  it('generates plan with MOTIF and OPENING_PHASE items, respecting rating window and excluding duplicates/completed', async () => {
    const timestamp = Date.now();

    // 1. Create 2 analyzed games for User A with rating 1600 -> userRating = 1600 (window 1350..1850)
    const resultWin = await prisma.result.findUnique({ where: { code: 'win' } });
    const game1 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: `train_game_1_${timestamp}`,
        playedAt: new Date('2026-01-01'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingC20.id,
        playerRating: 1600,
        totalPlies: 25,
        analysisStatus: 'analyzed',
      },
    });

    // Add 25 moves to game1 with opening phase -> eligible for opening/phase weakness (>= 20 moves)
    for (let ply = 1; ply <= 25; ply++) {
      const move = await prisma.move.create({
        data: {
          gameId: game1.id,
          ply,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moverColor: 'white',
          phaseId: phaseOpening.id,
        },
      });

      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: classBlunder.id,
          cpLoss: 100,
        },
      });

      // Add motif errors: fork (5 times), pin (3 times)
      if (ply <= 5) {
        await prisma.moveMotif.create({
          data: {
            moveId: move.id,
            motifId: motifFork.id,
            kind: 'missed',
          },
        });
      }
      if (ply > 5 && ply <= 8) {
        await prisma.moveMotif.create({
          data: {
            moveId: move.id,
            motifId: motifPin.id,
            kind: 'missed',
          },
        });
      }
    }

    // Add 19 moves with B00 opening (under 20 moves -> ignored by getWeakestOpeningPhases)
    const gameUnder20 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: `train_game_under20_${timestamp}`,
        playedAt: new Date('2026-01-02'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingB00.id,
        playerRating: 1600,
        totalPlies: 19,
        analysisStatus: 'analyzed',
      },
    });
    for (let ply = 1; ply <= 19; ply++) {
      const move = await prisma.move.create({
        data: {
          gameId: gameUnder20.id,
          ply,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moverColor: 'white',
          phaseId: phaseOpening.id,
        },
      });
      await prisma.moveClassification.create({
        data: {
          moveId: move.id,
          classificationId: classBlunder.id,
          cpLoss: 500,
        },
      });
    }

    // 2. Clear existing puzzles so this test has exact control over puzzle dataset
    await prisma.puzzleMotif.deleteMany();
    await prisma.trainingPlanItem.deleteMany();
    await prisma.puzzle.deleteMany();

    // Motif fork puzzles:
    // P1: rating 1600 (within window 1350..1850) -> should be included
    // P2: rating 1700 (within window) -> should be included
    // P3: rating 2200 (outside window) -> should be excluded!
    const puzzleF1 = await prisma.puzzle.create({
      data: {
        lichessId: `p_fork_1_${timestamp}`,
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
        movesUci: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
        rating: 1600,
        motifs: { create: [{ motifId: motifFork.id }] },
      },
    });
    const puzzleF2 = await prisma.puzzle.create({
      data: {
        lichessId: `p_fork_2_${timestamp}`,
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
        movesUci: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
        rating: 1700,
        motifs: { create: [{ motifId: motifFork.id }] },
      },
    });
    const puzzleFOut = await prisma.puzzle.create({
      data: {
        lichessId: `p_fork_out_${timestamp}`,
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
        movesUci: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
        rating: 2200,
        motifs: { create: [{ motifId: motifFork.id }] },
      },
    });

    // Opening phase puzzles (phase_tag = 'opening', rating within window):
    const puzzleO1 = await prisma.puzzle.create({
      data: {
        lichessId: `p_open_1_${timestamp}`,
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
        movesUci: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
        rating: 1650,
        phaseTag: 'opening',
      },
    });

    // Generate Plan 1 for User A
    const resPlan1 = await fetch(`${baseUrl}/api/v1/training/plans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPlan1.status).toBe(201);
    const plan1Data = await resPlan1.json();
    const items1 = plan1Data.plan.items;

    // Must contain MOTIF_WEAKNESS:fork items and OPENING_PHASE_WEAKNESS:C20_OPENING items
    const forkItems = items1.filter((it) => it.reasonCode === 'MOTIF_WEAKNESS:fork');
    const openItems = items1.filter((it) => it.reasonCode === 'OPENING_PHASE_WEAKNESS:C20_OPENING');
    expect(forkItems.length).toBeGreaterThanOrEqual(1);
    expect(openItems.length).toBeGreaterThanOrEqual(1);

    // B00 must be ignored (< 20 moves)
    expect(items1.some((it) => it.reasonCode.includes('B00'))).toBe(false);

    // Outside-window puzzle must not be included
    expect(items1.some((it) => it.puzzleId === puzzleFOut.id)).toBe(false);

    // No puzzle appears twice in the plan
    const puzzleIdsInPlan1 = items1.map((it) => it.puzzleId);
    const uniqueIds = new Set(puzzleIdsInPlan1);
    expect(uniqueIds.size).toBe(puzzleIdsInPlan1.length);

    // 3. Mark puzzleF1 as completed
    const itemF1 = items1.find((it) => it.puzzleId === puzzleF1.id);
    expect(itemF1).toBeDefined();

    const resPatch = await fetch(`${baseUrl}/api/v1/training/plans/${plan1Data.plan.id}/items/${itemF1.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ completed: true }),
    });
    expect(resPatch.status).toBe(200);
    const patchData = await resPatch.json();
    expect(patchData.item.completedAt).not.toBeNull();

    // 4. Generate Plan 2 for User A -> completed puzzleF1 must be EXCLUDED
    const resPlan2 = await fetch(`${baseUrl}/api/v1/training/plans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPlan2.status).toBe(201);
    const plan2Data = await resPlan2.json();
    const items2 = plan2Data.plan.items;
    expect(items2.some((it) => it.puzzleId === puzzleF1.id)).toBe(false);

    // 5. Test GET /training/plans lists plans newest first with items and drill
    const resList = await fetch(`${baseUrl}/api/v1/training/plans`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resList.status).toBe(200);
    const list = await resList.json();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].id).toBe(plan2Data.plan.id); // newest first

    const firstItemWithPuzzle = list[0].items.find((it) => it.puzzle !== null);
    if (firstItemWithPuzzle) {
      expect(firstItemWithPuzzle.puzzle).toHaveProperty('lichessId');
      expect(firstItemWithPuzzle.puzzle).toHaveProperty('fen');
      expect(firstItemWithPuzzle.puzzle).toHaveProperty('movesUci');
      expect(firstItemWithPuzzle.puzzle).toHaveProperty('rating');
      expect(firstItemWithPuzzle.drill).toBeDefined();
      expect(firstItemWithPuzzle.drill.setupMove).toBeDefined();
      expect(firstItemWithPuzzle.drill.solverMoves.length).toBeGreaterThan(0);
    }

    // 6. PATCH on another user's item or plan -> 404
    const resPatchOther = await fetch(
      `${baseUrl}/api/v1/training/plans/${plan1Data.plan.id}/items/${itemF1.id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({ completed: true }),
      }
    );
    expect(resPatchOther.status).toBe(404);
  });
});
