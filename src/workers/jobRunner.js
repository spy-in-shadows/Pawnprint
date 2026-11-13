import { prisma, pgPool } from '../config/db.js';
import { StockfishClient } from '../chess/stockfishClient.js';
import { lichessClient } from '../ingest/lichessClient.js';
import { chesscomClient } from '../ingest/chesscomClient.js';
import { importService } from '../services/import.service.js';
import { markGameFailed, saveGameAnalysis } from '../repositories/moveBulk.repo.js';
import { logger } from '../utils/logger.js';
import { analyzeGame } from './gameAnalyzer.js';
import { registerEngineVersion } from './engineRegistry.js';
import {
  claimNextJob,
  heartbeat,
  markJobFailed,
  markJobFinished,
  updateGameProgress,
} from './jobQueue.js';
import workerEvents from './events.js';

export const HEARTBEAT_INTERVAL_MS = 25000;
const MAX_ENGINE_ATTEMPTS = 3;
const ENGINE_RETRY_DELAY_MS = 1000;
const IDLE_SLEEP_MS = 1000;
const INGEST_BATCH_SIZE = 25;

const PLATFORM_CLIENTS = {
  lichess: lichessClient,
  chesscom: chesscomClient,
};

// Errors without a flag come from code we do not control. Only Stockfish failures are worth a
// retry; anything else would fail the same way again, so the game is failed instead.
function classifyError(err) {
  if (err?.isDataError) return 'data';
  if (err?.isEngineError) return 'engine';
  return /Stockfish/.test(err?.message ?? '') ? 'engine' : 'data';
}

async function loadAccount(accountId) {
  const account = await prisma.playerAccount.findUnique({
    where: { id: accountId },
    select: { username: true, lastSyncedAt: true, platform: { select: { name: true } } },
  });
  if (!account) throw new Error(`Player account ${accountId} not found`);
  return { platform: account.platform.name, username: account.username, lastSyncedAt: account.lastSyncedAt };
}

async function loadMoves(gameId) {
  return prisma.move.findMany({
    where: { gameId },
    orderBy: { ply: 'asc' },
    select: { ply: true, san: true, uci: true },
  });
}

// GREATEST keeps the cursor from moving backwards when a job imports an older date range. The
// value is passed as an ISO string and converted in SQL because pg would otherwise serialize the
// Date in the host's local zone, while the column holds UTC wall-clock time.
async function advanceCursor(accountId, newestPlayedAt) {
  await pgPool.query(
    `UPDATE player_accounts
     SET last_synced_at = GREATEST(COALESCE(last_synced_at, $2::timestamptz AT TIME ZONE 'UTC'),
                                   $2::timestamptz AT TIME ZONE 'UTC')
     WHERE id = $1`,
    [accountId, newestPlayedAt.toISOString()],
  );
}

export class JobRunner {
  constructor(workerId) {
    this.workerId = workerId;
    this.engine = new StockfishClient();
    this.startCache = new Map();
    this.engineRetryDelayMs = ENGINE_RETRY_DELAY_MS;
    this.log = logger.child({ workerId });
    this.running = false;
    this.stopping = false;
    this.heartbeatTimer = null;
    this._loop = null;
    this._sleepTimer = null;
    this._wake = null;
  }

  // Resolves once the engine is ready; the claim loop keeps running until stop().
  async start() {
    await this.engine.init();
    this.running = true;
    this.stopping = false;
    this._loop = this._run();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    this._clearHeartbeat();
    if (this._sleepTimer) clearTimeout(this._sleepTimer);
    this._wake?.();
    // Quitting first makes an in-flight search fail fast instead of holding shutdown up.
    await this.engine.quit();
    await this._loop;
  }

  async _run() {
    while (this.running) {
      let job = null;
      try {
        job = await claimNextJob(this.workerId);
      } catch (err) {
        this.log.error('Claiming a job failed', { err });
      }
      if (job) {
        await this.processJob(job);
      } else if (this.running) {
        await this._sleep(IDLE_SLEEP_MS);
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._wake = resolve;
      this._sleepTimer = setTimeout(resolve, ms);
    }).finally(() => {
      this._sleepTimer = null;
      this._wake = null;
    });
  }

  _beat(jobId) {
    heartbeat(jobId).catch((err) => this.log.warn('Heartbeat failed', { jobId, err }));
  }

  _startHeartbeat(jobId) {
    this._beat(jobId);
    this.heartbeatTimer = setInterval(() => this._beat(jobId), HEARTBEAT_INTERVAL_MS);
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async _fetchAndIngest(job, account) {
    const client = PLATFORM_CLIENTS[account.platform];
    const result = { insertedCount: 0, newestPlayedAt: null, skippedGames: 0 };
    if (!client) return result;

    const stats = {};
    const games = client.fetchUserGames(account.username, {
      max: job.maxGames,
      since: job.since ?? account.lastSyncedAt,
      until: job.until,
      stats,
    });

    // The cursor follows every game stored by this job, including ones a failed earlier job already
    // inserted; ingestParsedGames only reports the newest newly inserted game, which would leave the
    // cursor behind after a retry.
    const ingest = async (batch) => {
      const { insertedCount } = await importService.ingestParsedGames(job.playerAccountId, batch);
      result.insertedCount += insertedCount;
      for (const game of batch) {
        const playedAt = new Date(game.playedAt);
        if (Number.isNaN(playedAt.getTime())) continue;
        if (!result.newestPlayedAt || playedAt > result.newestPlayedAt) result.newestPlayedAt = playedAt;
      }
    };

    let batch = [];
    for await (const game of games) {
      batch.push(game);
      if (batch.length >= INGEST_BATCH_SIZE) {
        await ingest(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await ingest(batch);

    result.skippedGames = stats.skippedGames ?? 0;
    return result;
  }

  async processJob(job) {
    const jobId = job.id;
    const accountId = job.playerAccountId;
    this._startHeartbeat(jobId);
    workerEvents.emit('job:started', { jobId, accountId, workerId: this.workerId });

    try {
      const engineVersionId = await registerEngineVersion(this.engine);
      const account = await loadAccount(accountId);
      const ingested = await this._fetchAndIngest(job, account);

      const gameIds = await importService.getPendingGameIds(accountId, job.maxGames);
      for (const gameId of gameIds) {
        await updateGameProgress(jobId, gameId, 'pending');
      }

      let failedGames = 0;
      for (const gameId of gameIds) {
        await updateGameProgress(jobId, gameId, 'analyzing');
        const failure = await this._analyzeGame(jobId, gameId, engineVersionId);
        if (failure) {
          failedGames += 1;
          await markGameFailed(gameId, failure);
          await updateGameProgress(jobId, gameId, 'failed', failure);
          continue;
        }
        await updateGameProgress(jobId, gameId, 'done');
        workerEvents.emit('game:done', { jobId, gameId });
      }

      await markJobFinished(jobId, { failedGames, skippedGames: ingested.skippedGames });
      await this._advanceCursor(jobId, accountId, ingested.newestPlayedAt);

      workerEvents.emit('job:finished', {
        jobId,
        accountId,
        insertedGames: ingested.insertedCount,
        analyzedGames: gameIds.length - failedGames,
        failedGames,
        skippedGames: ingested.skippedGames,
      });
    } catch (err) {
      if (this.stopping) {
        // Left as running: once its heartbeat goes stale another worker reclaims it.
        this.log.warn('Job interrupted by shutdown', { jobId });
      } else {
        await this._fail(jobId, accountId, err);
      }
    } finally {
      this._clearHeartbeat();
    }
  }

  // Returns null when the game was analyzed and saved, or the failure reason for a data error.
  // Engine errors are retried on a restarted engine; once the attempts run out they propagate
  // and fail the job. Evals stay in memory until saveGameAnalysis, so a failed game writes nothing.
  async _analyzeGame(jobId, gameId, engineVersionId) {
    const moves = await loadMoves(gameId);
    let rows;
    for (let attempt = 1; !rows; attempt += 1) {
      try {
        if (attempt > 1) await this._restartEngine();
        rows = await analyzeGame({ moves }, this.engine, { engineVersionId, startCache: this.startCache });
      } catch (err) {
        if (this.stopping) throw err;
        const kind = classifyError(err);
        const flagged = Boolean(err?.isDataError || err?.isEngineError);
        this.log.warn('Game analysis failed', { jobId, gameId, attempt, kind, flagged, err });
        if (kind === 'data') return err?.message || 'Game data could not be analyzed';
        if (attempt >= MAX_ENGINE_ATTEMPTS || this.engine.hasCrashedTooManyTimes) throw err;
      }
    }
    await saveGameAnalysis({ gameId, engineVersionId, moves: rows });
    return null;
  }

  async _restartEngine() {
    if (this.engineRetryDelayMs > 0) await this._sleep(this.engineRetryDelayMs);
    if (this.stopping) throw new Error('Worker is stopping');
    await this.engine.init();
    await this.engine.newGame();
  }

  // Runs only after markJobFinished succeeded. A failure here must not turn the completed job
  // into a failed one; the cursor simply stays behind and the next job re-fetches (imports are idempotent).
  async _advanceCursor(jobId, accountId, newestPlayedAt) {
    if (!newestPlayedAt) return;
    try {
      await advanceCursor(accountId, newestPlayedAt);
    } catch (err) {
      this.log.error('Job finished but the sync cursor was not advanced', { jobId, err });
    }
  }

  async _fail(jobId, accountId, err) {
    try {
      await markJobFailed(jobId, err.message);
    } catch (markErr) {
      this.log.error('Marking the job failed did not succeed', { jobId, err: markErr });
    }
    workerEvents.emit('job:failed', { jobId, accountId, error: err.message, err });
  }
}

export default JobRunner;
