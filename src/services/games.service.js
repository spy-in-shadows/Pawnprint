import * as gameRepo from '../repositories/game.repo.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';


// Field formats (accountId, opening, dates, page) are validated by listGamesQuery
// (src/validation/games.schemas.js); the date order is a business rule and stays here.
export async function listGames(userId, query = {}) {
  const { accountId, from, to, opening, page, pageSize } = query;

  if (from && to && new Date(from) > new Date(to)) {
    throw new ValidationError('from date must be before or equal to to date');
  }

  return gameRepo.list({
    userId,
    accountId,
    from,
    to,
    opening: opening || undefined,
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
