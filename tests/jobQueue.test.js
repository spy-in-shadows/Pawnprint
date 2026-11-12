import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import {
  claimNextJob,
  heartbeat,
  markJobFinished,
  markJobFailed,
  updateGameProgress,
} from '../src/workers/jobQueue.js';

const runTag = `jq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let platformId;
let accountSeq = 0;

// One active job per account is enforced by a partial unique index, so every
// job gets its own account.
async function createJob(fields = {}) {
  accountSeq += 1;
  const user = await prisma.user.create({
    data: { email: `${runTag}_${accountSeq}@example.com`, passwordHash: 'x' },
  });
  const account = await prisma.playerAccount.create({
    data: { userId: user.id, platformId, username: `${runTag}_${accountSeq}` },
  });
  return prisma.analysisJob.create({ data: { playerAccountId: account.id, ...fields } });
}

async function setHeartbeatAgo(jobId, seconds) {
  await pgPool.query(
    `UPDATE analysis_jobs
     SET heartbeat_at = (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2)
     WHERE id = $1`,
    [jobId, seconds],
  );
}

describe('jobQueue', () => {
  beforeAll(async () => {
    await seed(prisma);
    const platform = await prisma.platform.findUnique({ where: { name: 'upload' } });
    platformId = platform.id;
  });

  // The claim query picks any eligible job in the table, so jobs left behind by
  // other test files would be claimed first.
  beforeEach(async () => {
    await pgPool.query(`DELETE FROM analysis_jobs WHERE status IN ('queued', 'running')`);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: runTag } } });
    await closeDb();
  });

  it('claim marks the job running, locked by the worker, with attempts incremented', async () => {
    const job = await createJob();

    const claimed = await claimNextJob('worker-a');

    expect(claimed.id).toBe(job.id);
    expect(claimed.status).toBe('running');
    expect(claimed.lockedBy).toBe('worker-a');
    expect(claimed.attempts).toBe(1);
    expect(claimed.lockedAt).toBeInstanceOf(Date);
    expect(claimed.heartbeatAt).toBeInstanceOf(Date);
    expect(claimed.playerAccountId).toBe(job.playerAccountId);
    expect(claimed.maxGames).toBe(50);
  });

  it('a second claim gets nothing when the only job is already taken', async () => {
    await createJob();

    const first = await claimNextJob('worker-a');
    const second = await claimNextJob('worker-b');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('claims queued jobs oldest first', async () => {
    const newer = await createJob({ createdAt: new Date(Date.now() - 1000) });
    const older = await createJob({ createdAt: new Date(Date.now() - 60_000) });

    const first = await claimNextJob('worker-a');
    const second = await claimNextJob('worker-b');

    expect(first.id).toBe(older.id);
    expect(second.id).toBe(newer.id);
  });

  it('reclaims a running job whose heartbeat is stale', async () => {
    const job = await createJob();
    await claimNextJob('worker-dead');
    await setHeartbeatAgo(job.id, config.jobStaleSeconds + 60);

    const reclaimed = await claimNextJob('worker-b');

    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.lockedBy).toBe('worker-b');
    expect(reclaimed.attempts).toBe(2);
  });

  it('does not reclaim a running job whose heartbeat is fresh', async () => {
    const job = await createJob();
    await claimNextJob('worker-a');
    await setHeartbeatAgo(job.id, Math.floor(config.jobStaleSeconds / 2));

    expect(await claimNextJob('worker-b')).toBeNull();

    const row = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(row.lockedBy).toBe('worker-a');
    expect(row.attempts).toBe(1);
  });

  it('heartbeat returns true while running and false after the job finishes', async () => {
    const job = await createJob();
    await claimNextJob('worker-a');
    await setHeartbeatAgo(job.id, 30);
    const before = await prisma.analysisJob.findUnique({ where: { id: job.id } });

    expect(await heartbeat(job.id)).toBe(true);
    const after = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(after.heartbeatAt.getTime()).toBeGreaterThan(before.heartbeatAt.getTime());

    await markJobFinished(job.id);
    expect(await heartbeat(job.id)).toBe(false);
  });

  it('markJobFinished stores the completed status and counters', async () => {
    const job = await createJob();
    await claimNextJob('worker-a');

    const finished = await markJobFinished(job.id, { failedGames: 2, skippedGames: 5 });

    expect(finished.status).toBe('completed');
    expect(finished.failedGames).toBe(2);
    expect(finished.skippedGames).toBe(5);
    expect(finished.finishedAt).toBeInstanceOf(Date);
  });

  it('updateGameProgress inserts a progress row and then updates it in place', async () => {
    const job = await createJob();
    const result = await prisma.result.findFirst();
    const game = await prisma.game.create({
      data: {
        playerAccountId: job.playerAccountId,
        platformId,
        externalId: `${runTag}_game`,
        playedAt: new Date(),
        color: 'white',
        resultId: result.id,
        totalPlies: 0,
      },
    });

    const pending = await updateGameProgress(job.id, game.id, 'running');
    expect(pending).toEqual({ jobId: job.id, gameId: game.id, status: 'running', error: null });

    const failed = await updateGameProgress(job.id, game.id, 'failed', 'illegal move at ply 7');
    expect(failed).toEqual({
      jobId: job.id,
      gameId: game.id,
      status: 'failed',
      error: 'illegal move at ply 7',
    });
    const rows = await prisma.analysisJobGame.findMany({ where: { jobId: job.id } });
    expect(rows).toHaveLength(1);
  });

  it('markJobFailed stores the error message', async () => {
    const job = await createJob();
    await claimNextJob('worker-a');

    const failed = await markJobFailed(job.id, 'engine crashed three times');

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('engine crashed three times');
    expect(failed.finishedAt).toBeInstanceOf(Date);
    const row = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('failed');
    expect(row.error).toBe('engine crashed three times');
  });
});
