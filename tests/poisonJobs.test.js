import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { claimNextJob, sweepPoisonJobs } from '../src/workers/jobQueue.js';

const runTag = `poison_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describe('poison job sweep', () => {
  beforeAll(async () => {
    await seed(prisma);
    const platform = await prisma.platform.findUnique({ where: { name: 'upload' } });
    platformId = platform.id;
  });

  beforeEach(async () => {
    await pgPool.query(`DELETE FROM analysis_jobs WHERE status IN ('queued', 'running')`);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: runTag } } });
    await closeDb();
  });

  it('fails a queued job that has used all 3 attempts and stores an error', async () => {
    const job = await createJob({ attempts: 3 });

    const swept = await sweepPoisonJobs(3);

    expect(swept.map((j) => j.id)).toContain(job.id);
    const row = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.error).toMatch(/3 attempts/);
    expect(row.finishedAt).not.toBeNull();
  });

  it('keeps the previous error text when sweeping', async () => {
    const job = await createJob({ attempts: 3, error: 'engine timeout on ply 40' });

    await sweepPoisonJobs(3);

    const row = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(row.error).toContain('engine timeout on ply 40');
  });

  it('leaves a running job on its last attempt alone while its heartbeat is fresh', async () => {
    const job = await createJob({ attempts: 2 });
    const claimed = await claimNextJob('worker-a');
    expect(claimed.id).toBe(job.id);
    expect(claimed.attempts).toBe(3);

    const swept = await sweepPoisonJobs(3);

    expect(swept.map((j) => j.id)).not.toContain(job.id);
    const row = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('running');
    expect(row.error).toBeNull();
    expect(row.finishedAt).toBeNull();
  });

  it('fails that same job once its heartbeat goes stale', async () => {
    const job = await createJob({ attempts: 2 });
    await claimNextJob('worker-a');
    expect(await sweepPoisonJobs(3)).toEqual([]);

    await setHeartbeatAgo(job.id, config.jobStaleSeconds + 60);
    const swept = await sweepPoisonJobs(3);

    expect(swept.map((j) => j.id)).toEqual([job.id]);
    expect(swept[0].status).toBe('failed');
    expect(swept[0].error).toMatch(/3 attempts/);
    expect(swept[0].finishedAt).toBeInstanceOf(Date);
  });

  it('claimNextJob sweeps poison jobs before claiming', async () => {
    const poisoned = await createJob({ attempts: 3 });

    expect(await claimNextJob('worker-a')).toBeNull();

    const row = await prisma.analysisJob.findUnique({ where: { id: poisoned.id } });
    expect(row.status).toBe('failed');
  });
});
