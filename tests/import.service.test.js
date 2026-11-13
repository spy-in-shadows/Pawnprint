import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { prisma, pgPool } from '../src/config/db.js';
import {
  createImportJob,
  getJobStatus,
  ingestParsedGames,
  getPendingGameIds,
} from '../src/services/import.service.js';
import { NotFoundError, ValidationError } from '../src/utils/errors.js';

describe('import.service', () => {
  let user1;
  let user2;
  let platform;
  let account1;
  let account2;

  beforeAll(async () => {
    // Ensure standard platforms and lookups exist
    platform = await prisma.platform.upsert({
      where: { name: 'lichess' },
      update: {},
      create: { name: 'lichess' },
    });

    const timestamp = Date.now();
    user1 = await prisma.user.create({
      data: {
        email: `import_user1_${timestamp}@test.com`,
        passwordHash: 'dummy_hash',
      },
    });

    user2 = await prisma.user.create({
      data: {
        email: `import_user2_${timestamp}@test.com`,
        passwordHash: 'dummy_hash',
      },
    });

    account1 = await prisma.playerAccount.create({
      data: {
        userId: user1.id,
        platformId: platform.id,
        username: `player1_${timestamp}`,
      },
    });

    account2 = await prisma.playerAccount.create({
      data: {
        userId: user2.id,
        platformId: platform.id,
        username: `player2_${timestamp}`,
      },
    });
  });

  afterAll(async () => {
    if (account1?.id || account2?.id) {
      const accountIds = [account1?.id, account2?.id].filter(Boolean);
      await prisma.analysisJob.deleteMany({ where: { playerAccountId: { in: accountIds } } }).catch(() => {});
      await prisma.game.deleteMany({ where: { playerAccountId: { in: accountIds } } }).catch(() => {});
      await prisma.playerAccount.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
    }
    if (user1?.id || user2?.id) {
      const userIds = [user1?.id, user2?.id].filter(Boolean);
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
    await pgPool.end();
  });

  it('dedupe returns the same active job for sequential calls', async () => {
    const job1 = await createImportJob(user1.id, {
      accountId: account1.id,
      maxGames: 25,
    });
    expect(job1).toBeDefined();
    expect(job1.status).toBe('queued');
    expect(job1.maxGames).toBe(25);

    const job2 = await createImportJob(user1.id, {
      accountId: account1.id,
      maxGames: 100,
    });
    expect(job2.id).toBe(job1.id);

    const activeJobs = await prisma.analysisJob.findMany({
      where: {
        playerAccountId: account1.id,
        status: { in: ['queued', 'running'] },
      },
    });
    expect(activeJobs).toHaveLength(1);
  });

  it('Promise.all of two createImportJob calls ends with one active job', async () => {
    // Clear existing active jobs for account1
    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });

    const [jobA, jobB] = await Promise.all([
      createImportJob(user1.id, { accountId: account1.id, maxGames: 40 }),
      createImportJob(user1.id, { accountId: account1.id, maxGames: 40 }),
    ]);

    expect(jobA.id).toBe(jobB.id);

    const activeJobs = await prisma.analysisJob.findMany({
      where: {
        playerAccountId: account1.id,
        status: { in: ['queued', 'running'] },
      },
    });
    expect(activeJobs).toHaveLength(1);
  });

  it('clamps maxGames to range 1..500 with default 50', async () => {
    // Clear active jobs
    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });

    const jobDefault = await createImportJob(user1.id, { accountId: account1.id });
    expect(jobDefault.maxGames).toBe(50);

    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });
    const jobClampedLow = await createImportJob(user1.id, { accountId: account1.id, maxGames: -10 });
    expect(jobClampedLow.maxGames).toBe(1);

    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });
    const jobClampedHigh = await createImportJob(user1.id, { accountId: account1.id, maxGames: 999 });
    expect(jobClampedHigh.maxGames).toBe(500);
  });

  it('rejects invalid or reversed dates with ValidationError and accepts valid ISO dates', async () => {
    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });

    // Invalid since
    await expect(
      createImportJob(user1.id, {
        accountId: account1.id,
        since: 'abc',
      })
    ).rejects.toThrow(ValidationError);

    // Invalid until
    await expect(
      createImportJob(user1.id, {
        accountId: account1.id,
        until: 'abc',
      })
    ).rejects.toThrow(ValidationError);

    // Reversed dates: since > until
    await expect(
      createImportJob(user1.id, {
        accountId: account1.id,
        since: '2023-06-15T00:00:00Z',
        until: '2023-06-01T00:00:00Z',
      })
    ).rejects.toThrow(ValidationError);

    // Valid ISO strings create the job
    const validJob = await createImportJob(user1.id, {
      accountId: account1.id,
      since: '2023-01-01T00:00:00Z',
      until: '2023-02-01T00:00:00Z',
    });
    expect(validJob).toBeDefined();
    expect(validJob.status).toBe('queued');
    expect(new Date(validJob.since)).toEqual(new Date('2023-01-01T00:00:00Z'));
    expect(new Date(validJob.until)).toEqual(new Date('2023-02-01T00:00:00Z'));
  });

  it('rejects with NotFoundError when accessing another user account or job', async () => {
    // User 2 trying to create job for User 1's account
    await expect(
      createImportJob(user2.id, { accountId: account1.id })
    ).rejects.toThrow(NotFoundError);

    // Create a job owned by user 1
    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });
    const job = await createImportJob(user1.id, { accountId: account1.id });

    // User 2 trying to read User 1's job status
    await expect(getJobStatus(user2.id, job.id)).rejects.toThrow(NotFoundError);

    // Non-existent job
    await expect(getJobStatus(user1.id, 99999999)).rejects.toThrow(NotFoundError);
  });

  it('getJobStatus returns correct progress counts and details', async () => {
    await prisma.analysisJob.deleteMany({ where: { playerAccountId: account1.id } });
    const job = await createImportJob(user1.id, { accountId: account1.id });

    const statusInitial = await getJobStatus(user1.id, job.id);
    expect(statusInitial).toMatchObject({
      id: job.id,
      status: 'queued',
      totalGames: 0,
      completedGames: 0,
      failedGames: 0,
      skippedGames: 0,
      error: null,
    });
    expect(statusInitial.createdAt).toBeInstanceOf(Date);
  });

  it('ingestParsedGames is idempotent and tracks newestPlayedAt of new games only', async () => {
    const timestamp = Date.now();
    const game1 = {
      externalId: `ingest_test_${timestamp}_1`,
      white: account1.username,
      black: 'Opponent1',
      resultRaw: '1-0',
      eco: 'C50',
      openingName: 'Italian Game',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date('2023-01-10T12:00:00Z'),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moverColor: 'white', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
        { ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', moverColor: 'black', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
      ],
    };

    const game2 = {
      externalId: `ingest_test_${timestamp}_2`,
      white: 'Opponent2',
      black: account1.username,
      resultRaw: '0-1',
      eco: 'B20',
      openingName: 'Sicilian Defense',
      timeControl: { baseSeconds: 180, incrementSeconds: 2, category: 'blitz' },
      playedAt: new Date('2023-01-20T15:30:00Z'),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moverColor: 'white', phase: 'opening', clockRemainingMs: 180000, timeSpentMs: 0 },
        { ply: 2, san: 'c5', uci: 'c7c5', fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', moverColor: 'black', phase: 'opening', clockRemainingMs: 180000, timeSpentMs: 0 },
      ],
    };

    // First ingestion: inserts both
    const firstResult = await ingestParsedGames(account1.id, [game1, game2]);
    expect(firstResult.insertedCount).toBe(2);
    expect(firstResult.insertedGameIds).toHaveLength(2);
    expect(firstResult.newestPlayedAt).toEqual(new Date('2023-01-20T15:30:00Z'));

    // Second ingestion with same games: 0 inserted (idempotent)
    const secondResult = await ingestParsedGames(account1.id, [game1, game2]);
    expect(secondResult.insertedCount).toBe(0);
    expect(secondResult.insertedGameIds).toHaveLength(0);
    expect(secondResult.newestPlayedAt).toBeNull();
  });

  it('a parseError game is stored failed and not returned by getPendingGameIds, ordering is played_at DESC', async () => {
    const timestamp = Date.now();

    // Game with older timestamp (pending, has moves)
    const gameOld = {
      externalId: `pending_test_${timestamp}_old`,
      white: account1.username,
      black: 'OpponentOld',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date('2023-02-01T10:00:00Z'),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moverColor: 'white', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
        { ply: 2, san: 'e5', uci: 'e7e5', fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', moverColor: 'black', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
      ],
    };

    // Game with newer timestamp (pending, has moves)
    const gameNew = {
      externalId: `pending_test_${timestamp}_new`,
      white: account1.username,
      black: 'OpponentNew',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date('2023-02-15T12:00:00Z'),
      totalPlies: 2,
      parseError: null,
      moves: [
        { ply: 1, san: 'd4', uci: 'd2d4', fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moverColor: 'white', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
        { ply: 2, san: 'd5', uci: 'd7d5', fenBefore: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', moverColor: 'black', phase: 'opening', clockRemainingMs: 300000, timeSpentMs: 0 },
      ],
    };

    // Game with parseError: stored failed
    const gameFailed = {
      externalId: `failed_test_${timestamp}`,
      white: account1.username,
      black: 'OpponentFailed',
      resultRaw: '1-0',
      timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
      playedAt: new Date('2023-02-20T14:00:00Z'),
      totalPlies: 0,
      parseError: 'Illegal move at ply 1',
      moves: [],
    };

    // Ingest all three
    const { insertedGameIds } = await ingestParsedGames(account1.id, [gameOld, gameNew, gameFailed]);
    expect(insertedGameIds).toHaveLength(3);

    const failedGameDb = await prisma.game.findUnique({
      where: { id: insertedGameIds[2] },
    });
    expect(failedGameDb.analysisStatus).toBe('failed');
    expect(failedGameDb.failureReason).toBe('Illegal move at ply 1');

    // Query pending games: must return gameNew, then gameOld (played_at DESC). gameFailed must NEVER be returned!
    const pendingIds = await getPendingGameIds(account1.id, 10);

    expect(pendingIds).toContain(insertedGameIds[0]); // gameOld
    expect(pendingIds).toContain(insertedGameIds[1]); // gameNew
    expect(pendingIds).not.toContain(insertedGameIds[2]); // gameFailed MUST NOT be present

    const indexOfNew = pendingIds.indexOf(insertedGameIds[1]);
    const indexOfOld = pendingIds.indexOf(insertedGameIds[0]);
    // gameNew (played Feb 15) must appear before gameOld (played Feb 1)
    expect(indexOfNew).toBeLessThan(indexOfOld);
  });
});
