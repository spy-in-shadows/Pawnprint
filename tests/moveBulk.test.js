import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, pgPool } from '../src/config/db.js';
import {
  insertGameWithMoves,
  saveGameAnalysis,
  markGameFailed,
} from '../src/repositories/moveBulk.repo.js';

describe('moveBulk repository (transactional bulk ingestion and analysis storage)', () => {
  let testUser;
  let testAccount;
  let platform;
  let engineVersion;

  beforeAll(async () => {
    platform = await prisma.platform.upsert({
      where: { name: 'lichess' },
      update: {},
      create: { name: 'lichess' },
    });

    engineVersion = await prisma.engineVersion.upsert({
      where: {
        name_version_defaultDepth_threads_hashSize: {
          name: 'Stockfish',
          version: '16',
          defaultDepth: 12,
          threads: 1,
          hashSize: 64,
        },
      },
      update: {},
      create: {
        name: 'Stockfish',
        version: '16',
        defaultDepth: 12,
        threads: 1,
        hashSize: 64,
      },
    });

    const rand = Math.floor(Math.random() * 1000000);
    testUser = await prisma.user.create({
      data: {
        email: `bulk_test_${rand}@example.com`,
        passwordHash: 'dummy_hash',
      },
    });

    testAccount = await prisma.playerAccount.create({
      data: {
        userId: testUser.id,
        platformId: platform.id,
        username: `hero_player_${rand}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('re-inserting the same game is idempotent (isNew false)', async () => {
    const externalId = `idempotent_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'RivalPlayer',
      whiteElo: 1800,
      blackElo: 1750,
      resultRaw: '1-0',
      eco: 'C50',
      openingName: 'Italian Game',
      timeControl: { baseSeconds: 180, incrementSeconds: 2, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 2,
      parseError: null,
      moves: [
        {
          ply: 1,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moverColor: 'white',
          phase: 'opening',
          clockRemainingMs: 180000,
          timeSpentMs: 2000,
        },
        {
          ply: 2,
          san: 'e5',
          uci: 'e7e5',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
          moverColor: 'black',
          phase: 'opening',
          clockRemainingMs: 179000,
          timeSpentMs: 3000,
        },
      ],
    };

    // First insert: isNew should be true
    const res1 = await insertGameWithMoves(testAccount.id, parsedGame);
    expect(res1.isNew).toBe(true);
    expect(typeof res1.gameId).toBe('number');

    // Second insert: isNew should be false with the exact same gameId
    const res2 = await insertGameWithMoves(testAccount.id, parsedGame);
    expect(res2.isNew).toBe(false);
    expect(res2.gameId).toBe(res1.gameId);

    // Verify row counts in database
    const gameCount = await prisma.game.count({
      where: { platformId: platform.id, externalId },
    });
    expect(gameCount).toBe(1);

    const moveCount = await prisma.move.count({
      where: { gameId: res1.gameId },
    });
    expect(moveCount).toBe(2);
  });

  it('moves inserted with exactly one INSERT statement (spy on the pool/client)', async () => {
    const externalId = `spy_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Opponent',
      whiteElo: 2000,
      blackElo: 1950,
      resultRaw: '1-0',
      eco: null,
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 4,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'fen1', moverColor: 'white', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 1000 },
        { ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'fen2', moverColor: 'black', phase: 'opening', clockRemainingMs: 299000, timeSpentMs: 1000 },
        { ply: 3, san: 'Nf3', uci: 'g1f3', fenBefore: 'fen3', moverColor: 'white', phase: 'opening', clockRemainingMs: 298000, timeSpentMs: 2000 },
        { ply: 4, san: 'Nc6', uci: 'b8c6', fenBefore: 'fen4', moverColor: 'black', phase: 'opening', clockRemainingMs: 297000, timeSpentMs: 2000 },
      ],
    };

    // Spy on client.query and clean up afterward
    const origConnect = pgPool.connect.bind(pgPool);
    const queryStatements = [];
    const patchedClients = [];

    const spy = vi.spyOn(pgPool, 'connect').mockImplementation(async () => {
      const client = await origConnect();
      const origQuery = client.query;
      patchedClients.push({ client, origQuery });
      client.query = async (...args) => {
        if (typeof args[0] === 'string') {
          queryStatements.push(args[0]);
        }
        return origQuery.apply(client, args);
      };
      return client;
    });

    try {
      const res = await insertGameWithMoves(testAccount.id, parsedGame);
      expect(res.isNew).toBe(true);

      const moveInsertQueries = queryStatements.filter((q) =>
        q.includes('INSERT INTO moves')
      );
      // Exactly one bulk statement must be issued for all moves
      expect(moveInsertQueries).toHaveLength(1);
      expect(moveInsertQueries[0]).toContain('UNNEST');
    } finally {
      for (const { client, origQuery } of patchedClients) {
        client.query = origQuery;
      }
      spy.mockRestore();
    }
  });

  it('rollback leaves zero rows when a later step fails', async () => {
    const externalId = `rollback_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Opponent',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 180, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 2,
      parseError: null,
      moves: [
        {
          ply: 1,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'start',
          moverColor: 'white',
          phase: 'opening',
          clockRemainingMs: 180000,
          timeSpentMs: 1000,
        },
      ],
    };

    // Mock pgPool.connect so that the move insertion query throws an unexpected error
    const origConnect = pgPool.connect.bind(pgPool);
    const patchedClients = [];
    const spy = vi.spyOn(pgPool, 'connect').mockImplementation(async () => {
      const client = await origConnect();
      const origQuery = client.query;
      patchedClients.push({ client, origQuery });
      client.query = async (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('INSERT INTO moves')) {
          throw new Error('simulated_network_crash_during_bulk_insert');
        }
        return origQuery.apply(client, args);
      };
      return client;
    });

    try {
      await expect(
        insertGameWithMoves(testAccount.id, parsedGame)
      ).rejects.toThrow('simulated_network_crash_during_bulk_insert');

      // Verify that transaction rollback left zero game and zero move rows
      const game = await prisma.game.findFirst({
        where: { platformId: platform.id, externalId },
      });
      expect(game).toBeNull();
    } finally {
      for (const { client, origQuery } of patchedClients) {
        client.query = origQuery;
      }
      spy.mockRestore();
    }
  });

  it('saveGameAnalysis twice creates no duplicates and sets the status', async () => {
    const externalId = `analysis_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Opponent',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'fen1', moverColor: 'white', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 1000 },
        { ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'fen2', moverColor: 'black', phase: 'opening', clockRemainingMs: 299000, timeSpentMs: 1000 },
      ],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);

    const initialGame = await prisma.game.findUnique({ where: { id: gameId } });
    expect(initialGame.analysisStatus).toBe('pending');

    const analysisMoves = [
      {
        ply: 1,
        evalBeforeCp: 20,
        evalAfterCp: 25,
        bestUci: 'e2e4',
        depth: 12,
        mateBefore: null,
        mateAfter: null,
        cpLoss: 0,
        classification: 'best',
        motifs: [],
      },
      {
        ply: 2,
        evalBeforeCp: 25,
        evalAfterCp: 180,
        bestUci: 'e7e5',
        depth: 12,
        mateBefore: null,
        mateAfter: null,
        cpLoss: 155,
        classification: 'blunder',
        motifs: [{ name: 'fork', kind: 'allowed' }],
      },
    ];

    // First save
    await saveGameAnalysis({ gameId, engineVersionId: engineVersion.id, moves: analysisMoves });

    const analyzedGame = await prisma.game.findUnique({ where: { id: gameId } });
    expect(analyzedGame.analysisStatus).toBe('analyzed');

    const evalsCount1 = await prisma.moveEval.count({
      where: { move: { gameId } },
    });
    const classCount1 = await prisma.moveClassification.count({
      where: { move: { gameId } },
    });
    expect(evalsCount1).toBe(2);
    expect(classCount1).toBe(2);

    // Second save (idempotency check)
    await saveGameAnalysis({ gameId, engineVersionId: engineVersion.id, moves: analysisMoves });

    const evalsCount2 = await prisma.moveEval.count({
      where: { move: { gameId } },
    });
    const classCount2 = await prisma.moveClassification.count({
      where: { move: { gameId } },
    });
    expect(evalsCount2).toBe(evalsCount1);
    expect(classCount2).toBe(classCount1);
  });

  it('mate rows only where mates exist', async () => {
    const externalId = `mate_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Opponent',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 3,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'fen1', moverColor: 'white', phase: 'opening', clockRemainingMs: null, timeSpentMs: null },
        { ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'fen2', moverColor: 'black', phase: 'opening', clockRemainingMs: null, timeSpentMs: null },
        { ply: 3, san: 'Qh5#', uci: 'd1h5', fenBefore: 'fen3', moverColor: 'white', phase: 'opening', clockRemainingMs: null, timeSpentMs: null },
      ],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);

    const analysisMoves = [
      {
        ply: 1,
        evalBeforeCp: 20,
        evalAfterCp: 25,
        bestUci: 'e2e4',
        depth: 12,
        mateBefore: null,
        mateAfter: null,
        cpLoss: 0,
        classification: 'best',
      },
      {
        ply: 2,
        evalBeforeCp: 25,
        evalAfterCp: 20000,
        bestUci: 'g8f6',
        depth: 12,
        mateBefore: null,
        mateAfter: 1, // Forced mate in 1
        cpLoss: 300,
        classification: 'blunder',
      },
      {
        ply: 3,
        evalBeforeCp: 20000,
        evalAfterCp: 20000,
        bestUci: 'd1h5',
        depth: 12,
        mateBefore: 1,
        mateAfter: 0, // Mate delivered
        cpLoss: 0,
        classification: 'best',
      },
    ];

    await saveGameAnalysis({ gameId, engineVersionId: engineVersion.id, moves: analysisMoves });

    const mateRows = await prisma.moveMate.findMany({
      where: { move: { gameId } },
      include: { move: true },
    });

    // Only plies 2 and 3 should have mate rows
    expect(mateRows).toHaveLength(2);
    const matePlies = mateRows.map((r) => r.move.ply).sort();
    expect(matePlies).toEqual([2, 3]);
  });

  it('null clocks accepted', async () => {
    const externalId = `null_clock_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Opponent',
      resultRaw: '1/2-1/2',
      timeControl: { baseSeconds: 1800, incrementSeconds: 0, category: 'classical' },
      playedAt: new Date(),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'd4', uci: 'd2d4', fenBefore: 'fen1', moverColor: 'white', phase: 'opening', clockRemainingMs: null, timeSpentMs: null },
        { ply: 2, san: 'd5', uci: 'd7d5', fenBefore: 'fen2', moverColor: 'black', phase: 'opening', clockRemainingMs: null, timeSpentMs: null },
      ],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);

    const moves = await prisma.move.findMany({
      where: { gameId },
      orderBy: { ply: 'asc' },
    });

    expect(moves).toHaveLength(2);
    expect(moves[0].clockRemainingMs).toBeNull();
    expect(moves[0].timeSpentMs).toBeNull();
    expect(moves[1].clockRemainingMs).toBeNull();
    expect(moves[1].timeSpentMs).toBeNull();
  });

  it('uploaded game with no username match gets color white', async () => {
    const externalId = `unmatched_user_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: 'AnonymousWhite',
      black: 'AnonymousBlack',
      resultRaw: '0-1',
      timeControl: { baseSeconds: 600, incrementSeconds: 0, category: 'rapid' },
      playedAt: new Date(),
      totalPlies: 0,
      parseError: null,
      moves: [],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);
    const game = await prisma.game.findUnique({ where: { id: gameId } });

    expect(game.color).toBe('white');
  });

  it('inserts failed game when parseError is present and no moves exist', async () => {
    const externalId = `failed_game_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Rival',
      resultRaw: '*',
      timeControl: { baseSeconds: 180, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 0,
      parseError: 'Corrupted PGN syntax before move 1',
      moves: [],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);
    const game = await prisma.game.findUnique({ where: { id: gameId } });

    expect(game.analysisStatus).toBe('failed');
    expect(game.failureReason).toBe('Corrupted PGN syntax before move 1');
  });

  it('markGameFailed updates analysis_status and failure_reason', async () => {
    const externalId = `mark_failed_${Date.now()}`;
    const parsedGame = {
      externalId,
      white: testAccount.username,
      black: 'Rival',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 180, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date(),
      totalPlies: 0,
      parseError: null,
      moves: [],
    };

    const { gameId } = await insertGameWithMoves(testAccount.id, parsedGame);
    await markGameFailed(gameId, 'Engine crash during evaluation');

    const game = await prisma.game.findUnique({ where: { id: gameId } });
    expect(game.analysisStatus).toBe('failed');
    expect(game.failureReason).toBe('Engine crash during evaluation');
  });
});
