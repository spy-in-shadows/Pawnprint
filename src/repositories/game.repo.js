import { prisma } from '../config/db.js';

const MAX_INT32 = 2147483647;

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
        moves: {
          select: {
            moverColor: true,
            classification: {
              select: {
                classification: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const items = games.map((game) => {
    let blunders = 0;
    let accuracyPct = null;

    if (game.analysisStatus === 'analyzed') {
      const ownerMoves = game.moves.filter((m) => m.moverColor === game.color);
      const totalOwnerMoves = ownerMoves.length;

      let bestOrGoodCount = 0;
      for (const move of ownerMoves) {
        const className = move.classification?.classification?.name;
        if (className === 'blunder') {
          blunders += 1;
        }
        if (className === 'best' || className === 'good') {
          bestOrGoodCount += 1;
        }
      }

      accuracyPct =
        totalOwnerMoves > 0 ? (bestOrGoodCount / totalOwnerMoves) * 100 : 0;
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
