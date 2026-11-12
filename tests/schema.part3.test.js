import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('schema part 3 - puzzles, training plans and analysis jobs', () => {
  let platform;
  let result;
  let motif;

  beforeAll(async () => {
    platform = await prisma.platform.upsert({
      where: { name: 'lichess' },
      update: {},
      create: { name: 'lichess' },
    });
    result = await prisma.result.upsert({
      where: { code: 'win' },
      update: {},
      create: { code: 'win' },
    });
    motif = await prisma.motif.upsert({
      where: { name: 'pin' },
      update: {},
      create: { name: 'pin' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createTestAccount(tag) {
    const timestamp = `${Date.now()}_${tag}`;
    const user = await prisma.user.create({
      data: {
        email: `schema3_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: `player_${timestamp}`,
          },
        },
      },
      include: {
        playerAccounts: true,
      },
    });
    return user.playerAccounts[0];
  }

  it('rejects a second queued or running job for the same account', async () => {
    const account = await createTestAccount('dup_active_job');

    const firstJob = await prisma.analysisJob.create({
      data: {
        playerAccountId: account.id,
        status: 'queued',
      },
    });
    expect(firstJob.id).toBeDefined();

    // Second queued job for the same account must fail
    await expect(
      prisma.analysisJob.create({
        data: {
          playerAccountId: account.id,
          status: 'queued',
        },
      })
    ).rejects.toThrow();

    // A running job for the same account must also fail
    await expect(
      prisma.analysisJob.create({
        data: {
          playerAccountId: account.id,
          status: 'running',
        },
      })
    ).rejects.toThrow();
  });

  it('allows a new job after the first is marked completed', async () => {
    const account = await createTestAccount('completed_job');

    const firstJob = await prisma.analysisJob.create({
      data: {
        playerAccountId: account.id,
        status: 'queued',
      },
    });

    await prisma.analysisJob.update({
      where: { id: firstJob.id },
      data: { status: 'completed' },
    });

    const secondJob = await prisma.analysisJob.create({
      data: {
        playerAccountId: account.id,
        status: 'queued',
      },
    });
    expect(secondJob.id).toBeDefined();
    expect(secondJob.status).toBe('queued');
  });

  it('verifies AnalysisJobGame composite key works', async () => {
    const account = await createTestAccount('job_game');
    const timestamp = Date.now();

    const game = await prisma.game.create({
      data: {
        playerAccountId: account.id,
        platformId: platform.id,
        externalId: `game_job_${timestamp}`,
        playedAt: new Date(),
        color: 'white',
        resultId: result.id,
        totalPlies: 30,
      },
    });

    const job = await prisma.analysisJob.create({
      data: {
        playerAccountId: account.id,
        status: 'queued',
      },
    });

    const jobGame = await prisma.analysisJobGame.create({
      data: {
        jobId: job.id,
        gameId: game.id,
        status: 'pending',
      },
    });

    expect(jobGame.jobId).toBe(job.id);
    expect(jobGame.gameId).toBe(game.id);

    // Duplicate (jobId, gameId) should fail
    await expect(
      prisma.analysisJobGame.create({
        data: {
          jobId: job.id,
          gameId: game.id,
          status: 'analyzed',
        },
      })
    ).rejects.toThrow();
  });

  it('enforces puzzles.lichessId uniqueness', async () => {
    const timestamp = Date.now();
    const lichessId = `puz_${timestamp}`;

    const puzzle = await prisma.puzzle.create({
      data: {
        lichessId,
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        movesUci: 'f1b5 a7a6',
        rating: 1500,
        phaseTag: 'opening',
      },
    });
    expect(puzzle.id).toBeDefined();

    await expect(
      prisma.puzzle.create({
        data: {
          lichessId,
          fen: '8/8/8/8/8/8/8/8 w - - 0 1',
          movesUci: 'a1a2',
          rating: 1600,
        },
      })
    ).rejects.toThrow();
  });

  it('supports training plans, training plan items, and cascade deletes', async () => {
    const timestamp = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `plan_user_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
      },
    });

    const puzzle = await prisma.puzzle.create({
      data: {
        lichessId: `puz_plan_${timestamp}`,
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        movesUci: 'f1b5 a7a6',
        rating: 1400,
        motifs: {
          create: {
            motifId: motif.id,
          },
        },
      },
      include: {
        motifs: true,
      },
    });
    expect(puzzle.motifs).toHaveLength(1);

    const plan = await prisma.trainingPlan.create({
      data: {
        userId: user.id,
        items: {
          create: {
            puzzleId: puzzle.id,
            motifId: motif.id,
            reasonCode: 'blunder_freq',
          },
        },
      },
      include: {
        items: true,
      },
    });
    expect(plan.items).toHaveLength(1);

    // Delete user cascades to training plan and items
    await prisma.user.delete({
      where: { id: user.id },
    });

    const planAfter = await prisma.trainingPlan.findUnique({ where: { id: plan.id } });
    const itemAfter = await prisma.trainingPlanItem.findUnique({ where: { id: plan.items[0].id } });
    expect(planAfter).toBeNull();
    expect(itemAfter).toBeNull();

    // Delete puzzle cascades to puzzle_motifs
    await prisma.puzzle.delete({
      where: { id: puzzle.id },
    });
    const motifLinks = await prisma.puzzleMotif.findMany({ where: { puzzleId: puzzle.id } });
    expect(motifLinks).toHaveLength(0);
  });
});
