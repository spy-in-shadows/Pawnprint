import * as trainingRepo from '../repositories/training.repo.js';
import * as analyticsRepo from '../repositories/analytics.repo.js';
import { prepareDrill } from './drill.js';
import { NotFoundError } from '../utils/errors.js';

export function toPlanDto(plan) {
  if (!plan) return null;

  return {
    id: plan.id,
    userId: plan.userId,
    createdAt: plan.createdAt,
    items: (plan.items || []).map((item) => {
      let drill = null;
      if (item.puzzle) {
        try {
          drill = prepareDrill(item.puzzle);
        } catch {
          drill = null;
        }
      }

      return {
        id: item.id,
        planId: item.planId,
        puzzleId: item.puzzleId,
        motifId: item.motifId,
        reasonCode: item.reasonCode,
        completedAt: item.completedAt,
        puzzle: item.puzzle
          ? {
              id: item.puzzle.id,
              lichessId: item.puzzle.lichessId,
              fen: item.puzzle.fen,
              movesUci: item.puzzle.movesUci,
              rating: item.puzzle.rating,
              phaseTag: item.puzzle.phaseTag,
            }
          : null,
        drill,
      };
    }),
  };
}

export async function listPlans(userId) {
  const plans = await trainingRepo.listUserPlans(userId);
  return plans.map(toPlanDto);
}

export async function generatePlan(userId) {
  const userRating = await trainingRepo.getUserRecentRating(userId);
  const minRating = userRating - 250;
  const maxRating = userRating + 250;

  const [weakestMotifs, weakestOpeningPhases] = await Promise.all([
    analyticsRepo.getWeakestMotifs({ userId, limit: 3 }),
    analyticsRepo.getWeakestOpeningPhases({ userId, limit: 2, minMoves: 20 }),
  ]);

  if (weakestMotifs.length === 0 && weakestOpeningPhases.length === 0) {
    const plan = await trainingRepo.createPlanWithItems(userId, []);
    return {
      plan: toPlanDto(plan),
      message: 'import and analyze more games to identify weaknesses',
    };
  }

  const completedPuzzleIds = await trainingRepo.getCompletedPuzzleIds(userId);
  const selectedPuzzleIds = new Set(completedPuzzleIds);

  const planItems = [];

  for (const m of weakestMotifs) {
    const { motifId, puzzles } = await trainingRepo.findPuzzlesForMotif(m.motif, {
      minRating,
      maxRating,
      excludePuzzleIds: Array.from(selectedPuzzleIds),
      limit: 3,
    });

    for (const puzzle of puzzles) {
      if (!selectedPuzzleIds.has(puzzle.id)) {
        selectedPuzzleIds.add(puzzle.id);
        planItems.push({
          puzzleId: puzzle.id,
          motifId,
          reasonCode: `MOTIF_WEAKNESS:${m.motif}`,
        });
      }
    }
  }

  for (const combo of weakestOpeningPhases) {
    const puzzles = await trainingRepo.findPuzzlesForPhase(combo.phase, {
      minRating,
      maxRating,
      excludePuzzleIds: Array.from(selectedPuzzleIds),
      limit: 3,
    });

    for (const puzzle of puzzles) {
      if (!selectedPuzzleIds.has(puzzle.id)) {
        selectedPuzzleIds.add(puzzle.id);
        planItems.push({
          puzzleId: puzzle.id,
          motifId: null,
          reasonCode: `OPENING_PHASE_WEAKNESS:${combo.eco}_${combo.phase.toUpperCase()}`,
        });
      }
    }
  }

  const plan = await trainingRepo.createPlanWithItems(userId, planItems);

  let message = null;
  if (planItems.length === 0) {
    message = 'import and analyze more games to identify weaknesses';
  }

  const response = {
    plan: toPlanDto(plan),
  };

  if (message) {
    response.message = message;
  }

  return response;
}

export async function setItemCompletion(userId, planId, itemId, completed) {
  const plan = await trainingRepo.findPlanById(Number(planId), userId);
  if (!plan) {
    throw new NotFoundError('Training plan not found');
  }

  const item = plan.items.find((it) => it.id === Number(itemId));
  if (!item) {
    throw new NotFoundError('Training plan item not found');
  }

  await trainingRepo.updateItemCompletion(plan.id, item.id, completed);

  const updatedPlan = await trainingRepo.findPlanById(plan.id, userId);
  const updatedItem = updatedPlan.items.find((it) => it.id === item.id);

  return {
    item: {
      id: updatedItem.id,
      planId: updatedItem.planId,
      puzzleId: updatedItem.puzzleId,
      motifId: updatedItem.motifId,
      reasonCode: updatedItem.reasonCode,
      completedAt: updatedItem.completedAt,
    },
  };
}

export const trainingService = {
  toPlanDto,
  listPlans,
  generatePlan,
  setItemCompletion,
};

export default trainingService;
