import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../src/config/db.js';
import {
  BENCH_USER_EMAIL,
  setupBenchmarkAccount,
  cleanupBenchmarkData,
  generateSyntheticGame,
  createPrng,
  formatReportMarkdown,
} from '../scripts/benchmarkInsert.js';
import { insertGameWithMoves } from '../src/repositories/moveBulk.repo.js';

describe('benchmarkInsert cleanup and report formatting', () => {
  const realEmail = 'real_user_benchmark99@example.com';
  const realUsername = 'benchmark99';

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: {
        email: {
          in: [realEmail, BENCH_USER_EMAIL],
        },
      },
    });
  });

  it('scopes cleanup strictly to the benchmark user without deleting benchmark99', async () => {
    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const result = await prisma.result.findUnique({ where: { code: 'win' } });

    const realUser = await prisma.user.create({
      data: {
        email: realEmail,
        passwordHash: 'test_password_hash',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: realUsername,
          },
        },
      },
      include: { playerAccounts: true },
    });

    const realAccount = realUser.playerAccounts[0];

    const realGame = await prisma.game.create({
      data: {
        playerAccountId: realAccount.id,
        platformId: platform.id,
        externalId: 'real_game_bench99_test_1',
        playedAt: new Date(),
        color: 'white',
        resultId: result.id,
        totalPlies: 0,
        analysisStatus: 'pending',
      },
    });

    const { user: benchUser, account: benchAccount } = await setupBenchmarkAccount();

    const syntheticGame = generateSyntheticGame(0, 10, createPrng(42), 'bench_scope_test');
    await insertGameWithMoves(benchAccount.id, syntheticGame);

    const benchGamesBefore = await prisma.game.findMany({
      where: { playerAccountId: benchAccount.id },
    });
    expect(benchGamesBefore.length).toBeGreaterThan(0);

    await cleanupBenchmarkData();

    const benchUserAfter = await prisma.user.findUnique({
      where: { email: BENCH_USER_EMAIL },
    });
    expect(benchUserAfter).toBeNull();

    const benchGamesAfter = await prisma.game.findMany({
      where: { playerAccountId: benchAccount.id },
    });
    expect(benchGamesAfter).toHaveLength(0);

    const realUserAfter = await prisma.user.findUnique({
      where: { email: realEmail },
    });
    expect(realUserAfter).not.toBeNull();

    const realAccountAfter = await prisma.playerAccount.findUnique({
      where: { id: realAccount.id },
    });
    expect(realAccountAfter).not.toBeNull();
    expect(realAccountAfter.username).toBe(realUsername);

    const realGameAfter = await prisma.game.findUnique({
      where: { id: realGame.id },
    });
    expect(realGameAfter).not.toBeNull();
  });

  it('derives speedup text dynamically without fixed multipliers', () => {
    const mockMachine = {
      cpu: 'Mock CPU (8 cores)',
      ram: '16.0 GB',
      node: 'v20.0.0',
      postgres: 'PostgreSQL 16',
      os: 'Darwin 24.0.0',
    };

    const mockResults = [
      {
        strategy: 'prisma-row',
        label: 'Prisma create (per-row)',
        games: 1000,
        plies: 40,
        totalPlies: 40000,
        durationMs: 41550,
        movesPerSec: 963,
        isEstimated: true,
        sampleCount: 500,
        sampleDurationMs: 20770,
      },
      {
        strategy: 'prisma-many',
        label: 'Prisma createMany',
        games: 1000,
        plies: 40,
        totalPlies: 40000,
        durationMs: 5090,
        movesPerSec: 7851,
        isEstimated: false,
      },
      {
        strategy: 'unnest',
        label: 'pg UNNEST (insertGameWithMoves)',
        games: 1000,
        plies: 40,
        totalPlies: 40000,
        durationMs: 3220,
        movesPerSec: 12405,
        isEstimated: false,
      },
    ];

    const markdown = formatReportMarkdown(mockMachine, mockResults);
    expect(markdown).toContain('8.2x');
    expect(markdown).toContain('12.9x');
    expect(markdown).not.toContain('~2x');

    const customResults = [
      {
        ...mockResults[0],
        movesPerSec: 1000,
      },
      {
        ...mockResults[1],
        movesPerSec: 5000,
      },
    ];

    const customMarkdown = formatReportMarkdown(mockMachine, customResults);
    expect(customMarkdown).toContain('5.0x');
    expect(customMarkdown).not.toContain('8.2x');
  });
});
