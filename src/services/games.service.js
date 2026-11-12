import * as gameRepo from '../repositories/game.repo.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

export async function listGames(userId, query = {}) {
  const { accountId, from, to, opening, page, pageSize } = query;

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new ValidationError('Invalid date format');
    }
    if (fromDate > toDate) {
      throw new ValidationError('from date must be before or equal to to date');
    }
  } else if (from) {
    if (isNaN(new Date(from).getTime())) {
      throw new ValidationError('Invalid date format');
    }
  } else if (to) {
    if (isNaN(new Date(to).getTime())) {
      throw new ValidationError('Invalid date format');
    }
  }

  return gameRepo.list({
    userId,
    accountId,
    from,
    to,
    opening,
    page,
    pageSize,
  });
}

export async function getGameDetail(userId, gameId) {
  const game = await gameRepo.getDetail({ userId, gameId });
  if (!game) {
    throw new NotFoundError('Game not found');
  }
  return game;
}

export const gamesService = {
  listGames,
  getGameDetail,
};

export default gamesService;
