import * as gameRepo from '../repositories/game.repo.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

const ECO_REGEX = /^[A-E]\d\d$/;
const MAX_INT32 = 2147483647;

export async function listGames(userId, query = {}) {
  const { accountId, from, to, opening, page, pageSize } = query;

  let validatedAccountId;
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    const num = Number(accountId);
    if (!Number.isInteger(num) || num <= 0 || num > MAX_INT32) {
      throw new ValidationError('accountId must be a positive integer');
    }
    validatedAccountId = num;
  }

  if (opening !== undefined && opening !== null && opening !== '') {
    if (typeof opening !== 'string' || !ECO_REGEX.test(opening)) {
      throw new ValidationError('opening must be a valid 3-character ECO code (e.g. B00)');
    }
  }

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
    accountId: validatedAccountId,
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
