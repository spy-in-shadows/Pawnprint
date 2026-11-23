// Golden test for GET /api/v1/games: blunders and accuracyPct for a fixed set of games,
// recorded from the implementation that loaded every move, plus a check that the list
// runs a fixed number of queries and reads no move rows.
process.env.PRISMA_LOG_QUERIES = 'true';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { createApp } = await import('../src/app.js');
const { prisma, pgPool } = await import('../src/config/db.js');
const { generateToken } = await import('../src/services/auth.service.js');
const { seed } = await import('../prisma/seed/index.js');
const { logger } = await import('../src/utils/logger.js');

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('games list aggregates', () => {
  let server;
  let baseUrl;
  let token;
  let gameIds;

  beforeAll(async () => {
    await seed(prisma);
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await prisma.user.deleteMany({ where: { email: { startsWith: 'gameslist_' } } });
    const user = await prisma.user.create({ data: { email: 'gameslist_owner@example.com', passwordHash: 'x' } });
    const other = await prisma.user.create({ data: { email: 'gameslist_other@example.com', passwordHash: 'x' } });
    token = generateToken(user);

    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const win = await prisma.result.findUnique({ where: { code: 'win' } });
    const loss = await prisma.result.findUnique({ where: { code: 'loss' } });
    const phase = await prisma.phase.findUnique({ where: { name: 'middlegame' } });
    const cls = Object.fromEntries(
      (await prisma.classification.findMany()).map((c) => [c.name, c.id])
    );

    const account = await prisma.playerAccount.create({
      data: { userId: user.id, platformId: platform.id, username: 'gameslist_owner' },
    });
    const otherAccount = await prisma.playerAccount.create({
      data: { userId: other.id, platformId: platform.id, username: 'gameslist_other' },
    });

    // Each game: [color, status, moves as [moverColor, classification|null]]
    const specs = [
      ['white', 'analyzed', [['white', 'best'], ['black', 'blunder'], ['white', 'blunder'], ['black', 'good'], ['white', 'good'], ['black', 'best'], ['white', 'mistake']]],
      ['black', 'analyzed', [['white', 'blunder'], ['black', 'best'], ['white', 'best'], ['black', 'blunder'], ['white', 'good'], ['black', 'blunder'], ['white', 'inaccuracy'], ['black', null]]],
      ['white', 'analyzed', [['white', 'best'], ['black', 'best'], ['white', 'best']]],
      ['black', 'analyzed', [['white', 'best']]],
      ['white', 'analyzed', []],
      ['white', 'pending', [['white', 'blunder'], ['black', 'best']]],
      ['black', 'failed', [['white', 'best'], ['black', 'blunder']]],
      ['white', 'analyzed', [['white', null], ['black', null], ['white', 'inaccuracy'], ['black', 'mistake'], ['white', 'blunder']]],
    ];

    gameIds = [];
    for (const [index, [color, status, moves]] of specs.entries()) {
      const game = await prisma.game.create({
        data: {
          playerAccountId: account.id,
          platformId: platform.id,
          externalId: `gameslist_${index}`,
          playedAt: new Date(Date.UTC(2026, 0, 20 - index)),
          color,
          resultId: index % 2 ? loss.id : win.id,
          totalPlies: moves.length,
          analysisStatus: status,
          failureReason: status === 'failed' ? 'bad pgn' : null,
        },
      });
      gameIds.push(game.id);
      for (const [ply, [mover, name]] of moves.entries()) {
        const move = await prisma.move.create({
          data: { gameId: game.id, ply: ply + 1, san: 'e4', uci: 'e2e4', fenBefore: FEN, moverColor: mover, phaseId: phase.id },
        });
        if (name) {
          await prisma.moveClassification.create({
            data: { moveId: move.id, classificationId: cls[name], cpLoss: 0 },
          });
        }
      }
    }

    // Another user's analysed game must not leak into the owner's list or its aggregates.
    const foreign = await prisma.game.create({
      data: {
        playerAccountId: otherAccount.id, platformId: platform.id, externalId: 'gameslist_foreign',
        playedAt: new Date(Date.UTC(2026, 0, 25)), color: 'white', resultId: win.id, totalPlies: 1, analysisStatus: 'analyzed',
      },
    });
    const foreignMove = await prisma.move.create({
      data: { gameId: foreign.id, ply: 1, san: 'e4', uci: 'e2e4', fenBefore: FEN, moverColor: 'white', phaseId: phase.id },
    });
    await prisma.moveClassification.create({ data: { moveId: foreignMove.id, classificationId: cls.blunder, cpLoss: 400 } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'gameslist_' } } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  async function getList(query) {
    const res = await fetch(`${baseUrl}/api/v1/games?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('returns the recorded blunders and accuracy for every game', async () => {
    const body = await getList('page=1&pageSize=20');
    expect(body.total).toBe(8);
    const summary = body.items.map((g) => ({
      ext: g.externalId, color: g.color, status: g.analysisStatus, blunders: g.blunders, accuracyPct: g.accuracyPct,
    }));
    expect(summary).toEqual([
      { ext: 'gameslist_0', color: 'white', status: 'analyzed', blunders: 1, accuracyPct: 50 },
      { ext: 'gameslist_1', color: 'black', status: 'analyzed', blunders: 2, accuracyPct: 25 },
      { ext: 'gameslist_2', color: 'white', status: 'analyzed', blunders: 0, accuracyPct: 100 },
      { ext: 'gameslist_3', color: 'black', status: 'analyzed', blunders: 0, accuracyPct: 0 },
      { ext: 'gameslist_4', color: 'white', status: 'analyzed', blunders: 0, accuracyPct: 0 },
      { ext: 'gameslist_5', color: 'white', status: 'pending', blunders: 0, accuracyPct: null },
      { ext: 'gameslist_6', color: 'black', status: 'failed', blunders: 0, accuracyPct: null },
      { ext: 'gameslist_7', color: 'white', status: 'analyzed', blunders: 1, accuracyPct: 0 },
    ]);
    // Full shape of one item, unchanged by the refactor.
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'accuracyPct', 'analysisStatus', 'blunders', 'color', 'externalId', 'failureReason', 'id',
      'opening', 'opponentRating', 'playedAt', 'playerRating', 'result', 'timeControl', 'totalPlies',
    ]);
    expect(body.items[6].failureReason).toBe('bad pgn');
  });

  it('pagination keeps the same per-game values', async () => {
    const body = await getList('page=2&pageSize=3');
    expect(body.items.map((g) => [g.externalId, g.blunders, g.accuracyPct])).toEqual([
      ['gameslist_3', 0, 0],
      ['gameslist_4', 0, 0],
      ['gameslist_5', 0, null],
    ]);
  });

  it('makes a fixed number of queries regardless of page size and reads no move rows', async () => {
    async function queriesFor(query) {
      const spy = vi.spyOn(logger, 'info');
      try {
        await getList(query);
        return spy.mock.calls.filter(([msg]) => msg === 'db query').map(([, meta]) => meta.query);
      } finally {
        spy.mockRestore();
      }
    }
    const small = await queriesFor('page=1&pageSize=2');
    const large = await queriesFor('page=1&pageSize=8');
    expect(large.length).toBe(small.length);
    // The only statement touching moves is the grouped aggregate; no move columns are selected.
    const moveQueries = large.filter((q) => /"?moves"?/.test(q) && !/"?_prisma_migrations"?/.test(q));
    expect(moveQueries.length).toBe(1);
    expect(moveQueries[0]).toMatch(/GROUP BY/i);
    expect(moveQueries[0]).not.toMatch(/"moves"\."(san|uci|fen_before|ply)"/);
  });
});
