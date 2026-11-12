import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { claimNextJob, markJobFinished } from '../src/workers/jobQueue.js';

const JOB_COUNT = 40;
const WORKER_IDS = ['worker-1', 'worker-2', 'worker-3'];
const MAX_ROUNDS = 3;

const runTag = `cc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let platformId;
let seedSeq = 0;

const randomDelay = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 6)));

// One user with `count` accounts and one queued job per account; the partial
// unique index allows only one active job per account.
async function seedJobs(count, jobFields = {}) {
  seedSeq += 1;
  const user = await prisma.user.create({
    data: { email: `${runTag}_${seedSeq}@example.com`, passwordHash: 'x' },
  });
  const usernames = Array.from({ length: count }, (_, i) => `${runTag}_${seedSeq}_${i}`);
  await prisma.playerAccount.createMany({
    data: usernames.map((username) => ({ userId: user.id, platformId, username })),
  });
  const accounts = await prisma.playerAccount.findMany({ where: { userId: user.id } });
  await prisma.analysisJob.createMany({
    data: accounts.map((account) => ({ playerAccountId: account.id, ...jobFields })),
  });
  const jobs = await prisma.analysisJob.findMany({
    where: { playerAccountId: { in: accounts.map((a) => a.id) } },
  });
  return jobs.map((job) => job.id);
}

async function runWorker(workerId) {
  const claimed = [];
  for (;;) {
    const job = await claimNextJob(workerId);
    if (!job) return claimed;
    claimed.push(job.id);
    await randomDelay();
    await markJobFinished(job.id);
  }
}

describe('claim concurrency', () => {
  beforeAll(async () => {
    await seed(prisma);
    const platform = await prisma.platform.findUnique({ where: { name: 'upload' } });
    platformId = platform.id;
  });

  // The claim query takes any eligible job, so active jobs left by other test
  // files would leak into these counts.
  beforeEach(async () => {
    await pgPool.query(`DELETE FROM analysis_jobs WHERE status IN ('queued', 'running')`);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: runTag } } });
    await closeDb();
  });

  it('three workers claim 40 jobs with no job claimed twice', async () => {
    // Only worker participation depends on scheduling luck, so only that is
    // retried; every round must satisfy the disjointness checks.
    let perWorker;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      await pgPool.query(`DELETE FROM analysis_jobs WHERE status IN ('queued', 'running')`);
      const jobIds = await seedJobs(JOB_COUNT);
      expect(jobIds).toHaveLength(JOB_COUNT);

      perWorker = await Promise.all(WORKER_IDS.map((id) => runWorker(id)));

      const allClaims = perWorker.flat();
      expect(allClaims).toHaveLength(JOB_COUNT);
      expect(new Set(allClaims).size).toBe(JOB_COUNT);
      expect([...allClaims].sort((a, b) => a - b)).toEqual([...jobIds].sort((a, b) => a - b));

      const rows = await prisma.analysisJob.findMany({ where: { id: { in: jobIds } } });
      for (const row of rows) {
        expect(row.attempts).toBe(1);
        expect(row.status).toBe('completed');
      }
      const claimedBy = new Map(perWorker.flatMap((ids, i) => ids.map((id) => [id, WORKER_IDS[i]])));
      for (const row of rows) {
        expect(row.lockedBy).toBe(claimedBy.get(row.id));
      }

      if (perWorker.every((ids) => ids.length > 0)) break;
    }

    for (const ids of perWorker) {
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  it('three workers racing for a single job: exactly one gets it', async () => {
    const [jobId] = await seedJobs(1);

    const results = await Promise.all(WORKER_IDS.map((id) => claimNextJob(id)));

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(jobId);
    expect(winners[0].attempts).toBe(1);
  });

  it('a stale running job is reclaimed by exactly one of three racing workers', async () => {
    const [jobId] = await seedJobs(1, { status: 'running', attempts: 1, lockedBy: 'dead-worker' });
    await pgPool.query(
      `UPDATE analysis_jobs
       SET locked_at = (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2),
           heartbeat_at = (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2)
       WHERE id = $1`,
      [jobId, config.jobStaleSeconds + 60],
    );

    const results = await Promise.all(WORKER_IDS.map((id) => claimNextJob(id)));

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(jobId);
    expect(winners[0].attempts).toBe(2);
    expect(WORKER_IDS).toContain(winners[0].lockedBy);

    const row = await prisma.analysisJob.findUnique({ where: { id: jobId } });
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('running');
    expect(row.lockedBy).toBe(winners[0].lockedBy);
  });
});
