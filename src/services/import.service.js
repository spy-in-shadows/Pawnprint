import { prisma } from '../config/db.js';
import { insertGameWithMoves } from '../repositories/moveBulk.repo.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Creates or retrieves an active import job for the player account.
 * Deduplicates active jobs (queued or running). If a race occurs against
 * the partial unique index, catches P2002 and returns the winner's job.
 *
 * @param {string} userId
 * @param {object} options
 * @param {string} options.accountId
 * @param {number} [options.maxGames=50]
 * @param {Date|string} [options.since]
 * @param {Date|string} [options.until]
 * @returns {Promise<object>}
 */
export async function createImportJob(userId, { accountId, maxGames = 50, since, until } = {}) {
  const account = await prisma.playerAccount.findUnique({
    where: { id: accountId },
  });

  if (!account || account.userId !== userId) {
    throw new NotFoundError('Player account not found');
  }

  if (since && until) {
    const sinceDate = since instanceof Date ? since : new Date(since);
    const untilDate = until instanceof Date ? until : new Date(until);
    if (!Number.isNaN(sinceDate.getTime()) && !Number.isNaN(untilDate.getTime()) && sinceDate > untilDate) {
      throw new ValidationError('since date must be less than or equal to until date');
    }
  }

  const parsedMax = maxGames !== undefined ? parseInt(maxGames, 10) : 50;
  const clampedMax = Number.isNaN(parsedMax) ? 50 : Math.min(500, Math.max(1, parsedMax));

  const existingActiveJob = await prisma.analysisJob.findFirst({
    where: {
      playerAccountId: accountId,
      status: { in: ['queued', 'running'] },
    },
  });

  if (existingActiveJob) {
    return existingActiveJob;
  }

  try {
    const job = await prisma.analysisJob.create({
      data: {
        playerAccountId: accountId,
        status: 'queued',
        maxGames: clampedMax,
        since: since ? new Date(since) : null,
        until: until ? new Date(until) : null,
      },
    });
    return job;
  } catch (err) {
    if (
      err.code === 'P2002' ||
      err.message?.includes('idx_analysis_jobs_active_unique') ||
      err.message?.includes('analysis_jobs_unique_active_per_account')
    ) {
      const winnerJob = await prisma.analysisJob.findFirst({
        where: {
          playerAccountId: accountId,
          status: { in: ['queued', 'running'] },
        },
      });
      if (winnerJob) {
        return winnerJob;
      }
    }
    throw err;
  }
}

/**
 * Retrieves the status and progress of an import job.
 * Enforces ownership check (404 for another user's job).
 *
 * @param {string} userId
 * @param {string} jobId
 * @returns {Promise<object>}
 */
export async function getJobStatus(userId, jobId) {
  const job = await prisma.analysisJob.findUnique({
    where: { id: jobId },
    include: {
      playerAccount: true,
      jobGames: true,
    },
  });

  if (!job || job.playerAccount.userId !== userId) {
    throw new NotFoundError('Import job not found');
  }

  const totalGames = job.jobGames.length;
  const completedGames = job.jobGames.filter((g) => g.status === 'completed').length;
  const failedGamesCount = job.jobGames.filter((g) => g.status === 'failed').length;
  const failedGames = job.failedGames != null && job.failedGames > 0 ? job.failedGames : failedGamesCount;
  const skippedGames = job.skippedGames != null ? job.skippedGames : 0;

  return {
    id: job.id,
    status: job.status,
    totalGames,
    completedGames,
    failedGames,
    skippedGames,
    error: job.error || null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * Ingests an array of ParsedGame objects for a player account.
 * Tracks inserted count, inserted IDs, and newest played date for newly inserted games only.
 *
 * @param {string} accountId
 * @param {Array<object>} games
 * @returns {Promise<{insertedCount: number, insertedGameIds: Array<number>, newestPlayedAt: Date|null}>}
 */
export async function ingestParsedGames(accountId, games) {
  let insertedCount = 0;
  const insertedGameIds = [];
  let newestPlayedAt = null;

  for (const game of games) {
    const result = await insertGameWithMoves(accountId, game);
    if (result.isNew) {
      insertedCount++;
      insertedGameIds.push(result.gameId);

      const playedAt = game.playedAt instanceof Date ? game.playedAt : new Date(game.playedAt);
      if (!Number.isNaN(playedAt.getTime())) {
        if (!newestPlayedAt || playedAt > newestPlayedAt) {
          newestPlayedAt = playedAt;
        }
      }
    }
  }

  return {
    insertedCount,
    insertedGameIds,
    newestPlayedAt,
  };
}

/**
 * Returns IDs of games for the given account with analysis_status='pending'
 * that have moves, ordered by played_at DESC then id DESC, limited.
 * Failed games are never returned.
 *
 * @param {string} accountId
 * @param {number} [limit=50]
 * @returns {Promise<Array<number>>}
 */
export async function getPendingGameIds(accountId, limit = 50) {
  const games = await prisma.game.findMany({
    where: {
      playerAccountId: accountId,
      analysisStatus: 'pending',
      moves: {
        some: {},
      },
    },
    orderBy: [
      { playedAt: 'desc' },
      { id: 'desc' },
    ],
    take: limit,
    select: {
      id: true,
    },
  });

  return games.map((g) => g.id);
}

export const importService = {
  createImportJob,
  getJobStatus,
  ingestParsedGames,
  getPendingGameIds,
};

export default importService;
