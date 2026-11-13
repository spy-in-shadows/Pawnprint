import { prisma } from '../config/db.js';

export async function listUserPlans(userId) {
  return prisma.trainingPlan.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          puzzle: true,
          motif: true,
        },
        orderBy: { id: 'asc' },
      },
    },
  });
}

export async function findPlanById(planId, userId) {
  return prisma.trainingPlan.findFirst({
    where: { id: planId, userId },
    include: {
      items: {
        include: {
          puzzle: true,
          motif: true,
        },
        orderBy: { id: 'asc' },
      },
    },
  });
}

export async function getCompletedPuzzleIds(userId) {
  const completedItems = await prisma.trainingPlanItem.findMany({
    where: {
      plan: { userId },
      completedAt: { not: null },
    },
    select: { puzzleId: true },
  });

  return new Set(completedItems.map((item) => item.puzzleId));
}

export async function getUserRecentRating(userId) {
  const analyzedGames = await prisma.game.findMany({
    where: {
      playerAccount: { userId },
      analysisStatus: 'analyzed',
      playerRating: { not: null },
    },
    orderBy: { playedAt: 'desc' },
    take: 20,
    select: { playerRating: true },
  });

  if (analyzedGames.length === 0) {
    return 1500;
  }

  const sum = analyzedGames.reduce((acc, g) => acc + g.playerRating, 0);
  return Math.round(sum / analyzedGames.length);
}

export async function findPuzzlesForMotif(motifName, { minRating, maxRating, excludePuzzleIds = [], limit = 3 }) {
  const motif = await prisma.motif.findUnique({
    where: { name: motifName },
  });

  if (!motif) {
    return { motifId: null, puzzles: [] };
  }

  const puzzles = await prisma.puzzle.findMany({
    where: {
      motifs: {
        some: { motifId: motif.id },
      },
      rating: {
        gte: minRating,
        lte: maxRating,
      },
      id: {
        notIn: excludePuzzleIds.length > 0 ? excludePuzzleIds : undefined,
      },
    },
    take: limit,
    orderBy: { id: 'asc' },
  });

  return { motifId: motif.id, puzzles };
}

export async function findPuzzlesForPhase(phaseTag, { minRating, maxRating, excludePuzzleIds = [], limit = 3 }) {
  const puzzles = await prisma.puzzle.findMany({
    where: {
      phaseTag: phaseTag ? phaseTag.toLowerCase() : undefined,
      rating: {
        gte: minRating,
        lte: maxRating,
      },
      id: {
        notIn: excludePuzzleIds.length > 0 ? excludePuzzleIds : undefined,
      },
    },
    take: limit,
    orderBy: { id: 'asc' },
  });

  return puzzles;
}

export async function createPlanWithItems(userId, items) {
  return prisma.trainingPlan.create({
    data: {
      userId,
      items: {
        create: items.map((it) => ({
          puzzleId: it.puzzleId,
          motifId: it.motifId || null,
          reasonCode: it.reasonCode,
        })),
      },
    },
    include: {
      items: {
        include: {
          puzzle: true,
          motif: true,
        },
        orderBy: { id: 'asc' },
      },
    },
  });
}

export async function updateItemCompletion(planId, itemId, completed) {
  return prisma.trainingPlanItem.updateMany({
    where: {
      id: itemId,
      planId,
    },
    data: {
      completedAt: completed ? new Date() : null,
    },
  });
}

export const trainingRepo = {
  listUserPlans,
  findPlanById,
  getCompletedPuzzleIds,
  getUserRecentRating,
  findPuzzlesForMotif,
  findPuzzlesForPhase,
  createPlanWithItems,
  updateItemCompletion,
};

export default trainingRepo;
