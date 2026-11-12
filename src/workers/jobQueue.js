import { pgPool } from '../config/db.js';
import config from '../config/env.js';

const MAX_ATTEMPTS = 3;

function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    playerAccountId: row.player_account_id,
    status: row.status,
    attempts: row.attempts,
    maxGames: row.max_games,
    since: row.since,
    until: row.until,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    heartbeatAt: row.heartbeat_at,
    error: row.error,
    failedGames: row.failed_games,
    skippedGames: row.skipped_games,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toJobGame(row) {
  return {
    jobId: row.job_id,
    gameId: row.game_id,
    status: row.status,
    error: row.error,
  };
}

/*
 * Claiming is a single UPDATE whose target row comes from a locking sub-select
 * (row lock with SKIP LOCKED). The sub-select row-locks the candidate it picks, and
 * that lock is held until the surrounding UPDATE commits. A second worker
 * running the same statement at the same moment does not wait on the locked
 * row and does not see it: SKIP LOCKED makes its sub-select pass over it and
 * take the next eligible row, or nothing. Because selection and the status
 * change happen inside one statement under one lock, there is no window in
 * which two workers can both observe the same row as 'queued' and both flip
 * it to 'running'. After the first worker commits, the row no longer matches
 * the WHERE clause (it is running with a fresh heartbeat), so later claims
 * skip it as well. This is why a separate SELECT followed by an UPDATE is
 * never used: between those two statements another worker could claim the
 * same job.
 *
 * The second branch of the WHERE clause handles crashed workers. A live
 * worker refreshes heartbeat_at while it processes a job; a worker that died
 * (killed process, lost connection, host crash) stops doing so and leaves its
 * job stuck in 'running'. Once heartbeat_at is older than jobStaleSeconds the
 * row becomes claimable again and the next worker takes it over, resuming
 * from analysis_job_games so finished games are not redone. attempts is
 * incremented on every claim, so a job that keeps killing its worker is
 * reclaimed at most MAX_ATTEMPTS times before sweepPoisonJobs fails it.
 */
const CLAIM_SQL = `
  UPDATE analysis_jobs
  SET status = 'running',
      locked_by = $1,
      locked_at = (NOW() AT TIME ZONE 'UTC'),
      heartbeat_at = (NOW() AT TIME ZONE 'UTC'),
      attempts = attempts + 1
  WHERE id = (
    SELECT id FROM analysis_jobs
    WHERE (status = 'queued' AND attempts < ${MAX_ATTEMPTS})
       OR (status = 'running' AND attempts < ${MAX_ATTEMPTS}
           AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2))
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *`;

export async function claimNextJob(workerId) {
  await sweepPoisonJobs();
  const { rows } = await pgPool.query(CLAIM_SQL, [workerId, config.jobStaleSeconds]);
  return toJob(rows[0]);
}

export async function heartbeat(jobId) {
  const { rowCount } = await pgPool.query(
    `UPDATE analysis_jobs
     SET heartbeat_at = (NOW() AT TIME ZONE 'UTC')
     WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
  return rowCount > 0;
}

// A running job on its last attempt whose heartbeat is still fresh belongs to
// a live worker and is left alone; it is only swept once that worker stops
// heartbeating.
export async function sweepPoisonJobs(maxAttempts = MAX_ATTEMPTS) {
  const { rows } = await pgPool.query(
    `UPDATE analysis_jobs
     SET status = 'failed',
         error = 'Exceeded ' || $1::int || ' attempts' || COALESCE(': ' || error, ''),
         finished_at = (NOW() AT TIME ZONE 'UTC')
     WHERE attempts >= $1
       AND (
         status = 'queued'
         OR (status = 'running'
             AND (heartbeat_at IS NULL
                  OR heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2)))
       )
     RETURNING *`,
    [maxAttempts, config.jobStaleSeconds],
  );
  return rows.map(toJob);
}

export async function updateGameProgress(jobId, gameId, status, error = null) {
  const { rows } = await pgPool.query(
    `INSERT INTO analysis_job_games (job_id, game_id, status, error)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id, game_id)
     DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error
     RETURNING *`,
    [jobId, gameId, status, error],
  );
  return toJobGame(rows[0]);
}

export async function markJobFinished(jobId, { failedGames = 0, skippedGames = 0 } = {}) {
  const { rows } = await pgPool.query(
    `UPDATE analysis_jobs
     SET status = 'completed',
         finished_at = (NOW() AT TIME ZONE 'UTC'),
         failed_games = $2,
         skipped_games = $3
     WHERE id = $1
     RETURNING *`,
    [jobId, failedGames, skippedGames],
  );
  return toJob(rows[0]);
}

export async function markJobFailed(jobId, message) {
  const { rows } = await pgPool.query(
    `UPDATE analysis_jobs
     SET status = 'failed',
         error = $2,
         finished_at = (NOW() AT TIME ZONE 'UTC')
     WHERE id = $1
     RETURNING *`,
    [jobId, message],
  );
  return toJob(rows[0]);
}
