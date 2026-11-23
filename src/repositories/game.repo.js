import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

const MAX_INT32 = 2147483647;

// Per-game counts of the owner's moves (moves whose mover_color is the game's color) for one page of
// games, in a single grouped query: total owner moves (classified or not), blunders, and best/good.
async function ownerMoveStats(gameIds) {
  const stats = new Map();
  if (gameIds.length === 0) return stats;

  const rows = await prisma.$queryRaw`
    SELECT m.game_id AS "gameId",
           COUNT(*)::int AS "total",
           COUNT(*) FILTER (WHERE c.name = 'blunder')::int AS "blunders",
           COUNT(*) FILTER (WHERE c.name IN ('best', 'good'))::int AS "bestOrGood"
    FROM moves m
    JOIN games g ON g.id = m.game_id AND m.mover_color = g.color
    LEFT JOIN move_classifications mc ON mc.move_id = m.id
    LEFT JOIN classifications c ON c.id = mc.classification_id
    WHERE m.game_id IN (${Prisma.join(gameIds)})
    GROUP BY m.game_id
  `;
  for (const row of rows) {
    stats.set(row.gameId, { total: row.total, blunders: row.blunders, bestOrGood: row.bestOrGood });
  }
  return stats;
}

export async function list({
  userId,
  accountId,
  from,
  to,
  opening,
  page = 1,
  pageSize = 20,
}) {
  const safePage = Math.max(1, Number(page) || 1);
  // Page size is capped at 100: it bounds the game ids passed to the aggregate query below.
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const skip = (safePage - 1) * safePageSize;

  const where = {
    playerAccount: {
      userId,
      ...(accountId ? { id: accountId } : {}),
    },
    ...(from || to
      ? {
          playedAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
    ...(opening
      ? {
          opening: {
            eco: opening,
          },
        }
      : {}),
  };

  const [total, games] = await Promise.all([
    prisma.game.count({ where }),
    prisma.game.findMany({
      where,
      skip,
      take: safePageSize,
      orderBy: { playedAt: 'desc' },
      include: {
        result: true,
        opening: true,
        timeControl: true,
      },
    }),
  ]);

  const stats = await ownerMoveStats(
    games.filter((game) => game.analysisStatus === 'analyzed').map((game) => game.id)
  );

  const items = games.map((game) => {
    let blunders = 0;
    let accuracyPct = null;

    if (game.analysisStatus === 'analyzed') {
      const gameStats = stats.get(game.id);
      blunders = gameStats?.blunders ?? 0;
      const totalOwnerMoves = gameStats?.total ?? 0;
      accuracyPct =
        totalOwnerMoves > 0 ? (gameStats.bestOrGood / totalOwnerMoves) * 100 : 0;
    }

    return {
      id: game.id,
      externalId: game.externalId,
      playedAt: game.playedAt,
      color: game.color,
      result: game.result.code,
      opening: game.opening
        ? {
            eco: game.opening.eco,
            name: game.opening.name,
          }
        : null,
      timeControl: game.timeControl
        ? {
            baseSeconds: game.timeControl.baseSeconds,
            incrementSeconds: game.timeControl.incrementSeconds,
            category: game.timeControl.category,
          }
        : null,
      playerRating: game.playerRating,
      opponentRating: game.opponentRating,
      totalPlies: game.totalPlies,
      analysisStatus: game.analysisStatus,
      failureReason: game.failureReason,
      blunders,
      accuracyPct,
    };
  });

  return {
    items,
    page: safePage,
    pageSize: safePageSize,
    total,
  };
}

export async function getDetail({ userId, gameId }) {
  const numericId = Number(gameId);
  if (!Number.isInteger(numericId) || numericId <= 0 || numericId > MAX_INT32) {
    return null;
  }

  const game = await prisma.game.findFirst({
    where: {
      id: numericId,
      playerAccount: {
        userId,
      },
    },
    include: {
      result: true,
      opening: true,
      timeControl: true,
      moves: {
        orderBy: { ply: 'asc' },
        include: {
          phase: true,
          eval: true,
          mate: true,
          classification: {
            include: {
              classification: true,
            },
          },
          motifs: {
            include: {
              motif: true,
            },
          },
        },
      },
    },
  });

  if (!game) {
    return null;
  }

  const moves = game.moves.map((m) => {
    const classificationName = m.classification?.classification?.name ?? null;
    const cpLoss = m.classification?.cpLoss ?? null;

    const evalData = m.eval
      ? {
          evalBeforeCp: m.eval.evalBeforeCp,
          evalAfterCp: m.eval.evalAfterCp,
          bestUci: m.eval.bestUci,
          depth: m.eval.depth,
        }
      : null;

    const mateData = m.mate
      ? {
          mateBefore: m.mate.mateBefore,
          mateAfter: m.mate.mateAfter,
        }
      : null;

    const motifs = (m.motifs || []).map((mm) => ({
      name: mm.motif.name,
      kind: mm.kind,
    }));

    return {
      ply: m.ply,
      san: m.san,
      uci: m.uci,
      fenBefore: m.fenBefore,
      moverColor: m.moverColor,
      clockRemainingMs: m.clockRemainingMs,
      timeSpentMs: m.timeSpentMs,
      phase: m.phase.name,
      eval: evalData,
      mate: mateData,
      classification: classificationName,
      cpLoss,
      motifs,
    };
  });

  return {
    id: game.id,
    externalId: game.externalId,
    playedAt: game.playedAt,
    color: game.color,
    result: game.result.code,
    opening: game.opening
      ? {
          eco: game.opening.eco,
          name: game.opening.name,
        }
      : null,
    timeControl: game.timeControl
      ? {
          baseSeconds: game.timeControl.baseSeconds,
          incrementSeconds: game.timeControl.incrementSeconds,
          category: game.timeControl.category,
        }
      : null,
    playerRating: game.playerRating,
    opponentRating: game.opponentRating,
    totalPlies: game.totalPlies,
    analysisStatus: game.analysisStatus,
    failureReason: game.failureReason,
    moves,
  };
}

export const gameRepo = {
  list,
  getDetail,
};

export default gameRepo;
