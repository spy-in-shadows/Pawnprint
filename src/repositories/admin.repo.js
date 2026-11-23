import { prisma } from '../config/db.js';

const JOB_STATUSES = ['queued', 'running', 'completed', 'failed'];

// One query for the page: account and game counts come from correlated subqueries, so the
// cost does not grow with the number of users on the page. Never selects password_hash.
export async function listUsers({ page, pageSize }) {
  const offset = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    prisma.$queryRaw`
      SELECT u.id,
             u.email,
             u.role,
             u.created_at AS "createdAt",
             (SELECT COUNT(*) FROM player_accounts pa WHERE pa.user_id = u.id)::int AS "accountCount",
             (SELECT COUNT(*)
                FROM games g
                JOIN player_accounts pa ON pa.id = g.player_account_id
               WHERE pa.user_id = u.id)::int AS "gameCount"
        FROM users u
       ORDER BY u.id
       LIMIT ${pageSize} OFFSET ${offset}
    `,
    prisma.user.count(),
  ]);
  return { items: rows, total };
}

export async function jobOverview({ recentLimit }) {
  const [grouped, recent] = await Promise.all([
    prisma.analysisJob.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.analysisJob.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: recentLimit,
      select: {
        id: true,
        status: true,
        attempts: true,
        maxGames: true,
        failedGames: true,
        skippedGames: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        playerAccount: {
          select: {
            id: true,
            username: true,
            platform: { select: { name: true } },
            user: { select: { id: true, email: true } },
          },
        },
      },
    }),
  ]);

  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }

  return {
    counts,
    recent: recent.map((job) => ({
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      maxGames: job.maxGames,
      failedGames: job.failedGames,
      skippedGames: job.skippedGames,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      account: {
        id: job.playerAccount.id,
        username: job.playerAccount.username,
        platform: job.playerAccount.platform.name,
      },
      user: { id: job.playerAccount.user.id, email: job.playerAccount.user.email },
    })),
  };
}

export const adminRepo = { listUsers, jobOverview };
export default adminRepo;
