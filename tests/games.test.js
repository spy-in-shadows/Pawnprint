import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

describe('Games endpoints and ownership', () => {
  let app;
  let server;
  let baseUrl;

  let userA;
  let userB;
  let tokenA;
  let tokenB;

  let platform;
  let accountA;
  let accountA2;
  let accountB;

  let resultWin;
  let resultLoss;
  let openingE4;
  let openingD4;
  let timeControlBlitz;
  let phaseOpening;
  let phaseMiddlegame;
  let classBest;
  let classBlunder;
  let motifPin;
  let engineVersion;

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
    resultLoss = await prisma.result.findUnique({ where: { code: 'loss' } });
    openingE4 = await prisma.opening.findFirst({ where: { eco: 'B00' } });
    if (!openingE4) {
      openingE4 = await prisma.opening.create({
        data: { eco: 'B00', name: "King's Pawn" },
      });
    }
    openingD4 = await prisma.opening.findFirst({ where: { eco: 'A40' } });
    if (!openingD4) {
      openingD4 = await prisma.opening.create({
        data: { eco: 'A40', name: "Queen's Pawn" },
      });
    }

    timeControlBlitz = await prisma.timeControl.findFirst({
      where: { category: 'blitz' },
    });
    if (!timeControlBlitz) {
      timeControlBlitz = await prisma.timeControl.create({
        data: { baseSeconds: 180, incrementSeconds: 0, category: 'blitz' },
      });
    }

    phaseOpening = await prisma.phase.findUnique({ where: { name: 'opening' } });
    phaseMiddlegame = await prisma.phase.findUnique({ where: { name: 'middlegame' } });
    classBest = await prisma.classification.findUnique({ where: { name: 'best' } });
    classBlunder = await prisma.classification.findUnique({ where: { name: 'blunder' } });
    motifPin = await prisma.motif.findUnique({ where: { name: 'pin' } });

    engineVersion = await prisma.engineVersion.findFirst();
    if (!engineVersion) {
      engineVersion = await prisma.engineVersion.create({
        data: {
          name: 'Stockfish',
          version: '16',
          defaultDepth: 12,
          threads: 1,
          hashSize: 64,
        },
      });
    }
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
        email: 'user_a@example.com',
        passwordHash: 'hashA',
      },
    });
    tokenA = generateToken(userA);

    userB = await prisma.user.create({
      data: {
        email: 'user_b@example.com',
        passwordHash: 'hashB',
      },
    });
    tokenB = generateToken(userB);

    accountA = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: 'lichess_user_a',
      },
    });

    accountA2 = await prisma.playerAccount.create({
      data: {
        userId: userA.id,
        platformId: platform.id,
        username: 'lichess_user_a2',
      },
    });

    accountB = await prisma.playerAccount.create({
      data: {
        userId: userB.id,
        platformId: platform.id,
        username: 'lichess_user_b',
      },
    });
  });

  it('unauthenticated request returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/games`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('list pagination and total', async () => {
    for (let i = 1; i <= 25; i++) {
      await prisma.game.create({
        data: {
          playerAccountId: accountA.id,
          platformId: platform.id,
          externalId: `game_pagination_${i}`,
          playedAt: new Date(Date.UTC(2026, 0, i)),
          color: 'white',
          resultId: resultWin.id,
          totalPlies: 20,
        },
      });
    }

    const resPage1 = await fetch(`${baseUrl}/api/v1/games?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPage1.status).toBe(200);
    const body1 = await resPage1.json();
    expect(body1.total).toBe(25);
    expect(body1.page).toBe(1);
    expect(body1.pageSize).toBe(10);
    expect(body1.items).toHaveLength(10);

    const resPage3 = await fetch(`${baseUrl}/api/v1/games?page=3&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resPage3.status).toBe(200);
    const body3 = await resPage3.json();
    expect(body3.total).toBe(25);
    expect(body3.page).toBe(3);
    expect(body3.pageSize).toBe(10);
    expect(body3.items).toHaveLength(5);
  });

  it('filters by account, date range and opening', async () => {
    const game1 = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'game_filter_1',
        playedAt: new Date('2026-05-10T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingE4.id,
        totalPlies: 10,
      },
    });

    await prisma.game.create({
      data: {
        playerAccountId: accountA2.id,
        platformId: platform.id,
        externalId: 'game_filter_2',
        playedAt: new Date('2026-05-15T12:00:00Z'),
        color: 'black',
        resultId: resultLoss.id,
        openingId: openingE4.id,
        totalPlies: 10,
      },
    });

    await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'game_filter_3',
        playedAt: new Date('2026-05-20T12:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingD4.id,
        totalPlies: 10,
      },
    });

    // Filter by accountId
    const resAcc = await fetch(`${baseUrl}/api/v1/games?accountId=${accountA.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resAcc.status).toBe(200);
    const bodyAcc = await resAcc.json();
    expect(bodyAcc.total).toBe(2);
    expect(bodyAcc.items.every((g) => g.id === game1.id || g.externalId === 'game_filter_3')).toBe(true);

    // Filter by opening ECO
    const resEco = await fetch(`${baseUrl}/api/v1/games?opening=${openingE4.eco}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resEco.status).toBe(200);
    const bodyEco = await resEco.json();
    expect(bodyEco.total).toBe(2);

    // Filter by date range
    const resDate = await fetch(
      `${baseUrl}/api/v1/games?from=2026-05-09T00:00:00Z&to=2026-05-12T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(resDate.status).toBe(200);
    const bodyDate = await resDate.json();
    expect(bodyDate.total).toBe(1);
    expect(bodyDate.items[0].id).toBe(game1.id);
  });

  it('reversed dates -> 400', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/games?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('detail returns moves in ply order with evals and motifs', async () => {
    const game = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'game_detail_1',
        playedAt: new Date('2026-06-01T10:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        openingId: openingE4.id,
        timeControlId: timeControlBlitz.id,
        playerRating: 1500,
        opponentRating: 1480,
        totalPlies: 2,
        analysisStatus: 'analyzed',
      },
    });

    const move2 = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 2,
        san: 'e5',
        uci: 'e7e5',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        moverColor: 'black',
        clockRemainingMs: 178000,
        timeSpentMs: 2000,
        phaseId: phaseOpening.id,
      },
    });

    const move1 = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moverColor: 'white',
        clockRemainingMs: 180000,
        timeSpentMs: 1000,
        phaseId: phaseOpening.id,
      },
    });

    await prisma.moveEval.create({
      data: {
        moveId: move1.id,
        evalBeforeCp: 20,
        evalAfterCp: 25,
        bestUci: 'e2e4',
        depth: 12,
        engineVersionId: engineVersion.id,
      },
    });

    await prisma.moveMate.create({
      data: {
        moveId: move1.id,
        mateBefore: null,
        mateAfter: null,
      },
    });

    await prisma.moveClassification.create({
      data: {
        moveId: move1.id,
        classificationId: classBest.id,
        cpLoss: 0,
      },
    });

    await prisma.moveMotif.create({
      data: {
        moveId: move1.id,
        motifId: motifPin.id,
        kind: 'allowed',
      },
    });

    const res = await fetch(`${baseUrl}/api/v1/games/${game.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe(game.id);
    expect(body.externalId).toBe('game_detail_1');
    expect(body.color).toBe('white');
    expect(body.result).toBe('win');
    expect(body.opening).toEqual({
      eco: openingE4.eco,
      name: openingE4.name,
    });
    expect(body.timeControl).toEqual({
      baseSeconds: timeControlBlitz.baseSeconds,
      incrementSeconds: timeControlBlitz.incrementSeconds,
      category: timeControlBlitz.category,
    });
    expect(body.playerRating).toBe(1500);
    expect(body.opponentRating).toBe(1480);
    expect(body.analysisStatus).toBe('analyzed');

    expect(body.moves).toHaveLength(2);
    expect(body.moves[0].ply).toBe(1);
    expect(body.moves[1].ply).toBe(2);

    const firstMove = body.moves[0];
    expect(firstMove.san).toBe('e4');
    expect(firstMove.uci).toBe('e2e4');
    expect(firstMove.phase).toBe('opening');
    expect(firstMove.eval).toEqual({
      evalBeforeCp: 20,
      evalAfterCp: 25,
      bestUci: 'e2e4',
      depth: 12,
    });
    expect(firstMove.mate).toEqual({
      mateBefore: null,
      mateAfter: null,
    });
    expect(firstMove.classification).toBe('best');
    expect(firstMove.cpLoss).toBe(0);
    expect(firstMove.motifs).toEqual([{ name: 'pin', kind: 'allowed' }]);

    const secondMove = body.moves[1];
    expect(secondMove.san).toBe('e5');
    expect(secondMove.eval).toBeNull();
    expect(secondMove.mate).toBeNull();
    expect(secondMove.classification).toBeNull();
    expect(secondMove.cpLoss).toBeNull();
    expect(secondMove.motifs).toEqual([]);
  });

  it('not-analyzed game has null evals and null accuracyPct in list', async () => {
    const game = await prisma.game.create({
      data: {
        playerAccountId: accountA.id,
        platformId: platform.id,
        externalId: 'game_pending_1',
        playedAt: new Date('2026-06-02T10:00:00Z'),
        color: 'white',
        resultId: resultWin.id,
        totalPlies: 1,
        analysisStatus: 'pending',
      },
    });

    await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'startpos',
        moverColor: 'white',
        phaseId: phaseOpening.id,
      },
    });

    const resList = await fetch(`${baseUrl}/api/v1/games?accountId=${accountA.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resList.status).toBe(200);
    const listBody = await resList.json();
    const listedGame = listBody.items.find((g) => g.id === game.id);
    expect(listedGame).toBeDefined();
    expect(listedGame.analysisStatus).toBe('pending');
    expect(listedGame.accuracyPct).toBeNull();
    expect(listedGame.blunders).toBe(0);

    const resDetail = await fetch(`${baseUrl}/api/v1/games/${game.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resDetail.status).toBe(200);
    const detailBody = await resDetail.json();
    expect(detailBody.analysisStatus).toBe('pending');
    expect(detailBody.moves[0].eval).toBeNull();
    expect(detailBody.moves[0].mate).toBeNull();
  });

  it("user A gets 404 for user B's game (list excludes it too) and missing game returns same 404", async () => {
    const gameB = await prisma.game.create({
      data: {
        playerAccountId: accountB.id,
        platformId: platform.id,
        externalId: 'game_user_b_private',
        playedAt: new Date('2026-06-03T10:00:00Z'),
        color: 'black',
        resultId: resultWin.id,
        totalPlies: 0,
      },
    });

    // List for user A should not contain gameB
    const resListA = await fetch(`${baseUrl}/api/v1/games`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resListA.status).toBe(200);
    const listBodyA = await resListA.json();
    expect(listBodyA.items.some((g) => g.id === gameB.id)).toBe(false);

    // Detail for user A requesting gameB
    const resOther = await fetch(`${baseUrl}/api/v1/games/${gameB.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resOther.status).toBe(404);
    const bodyOther = await resOther.json();

    // Detail for missing game
    const nonExistentId = 99999999;
    const resMissing = await fetch(`${baseUrl}/api/v1/games/${nonExistentId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resMissing.status).toBe(404);
    const bodyMissing = await resMissing.json();

    expect(bodyOther).toEqual(bodyMissing);
    expect(bodyOther.error.code).toBe('NOT_FOUND');
    expect(bodyOther.error.message).toBe('Game not found');
  });
});
