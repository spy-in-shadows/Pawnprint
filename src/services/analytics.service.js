import * as analyticsRepo from '../repositories/analytics.repo.js';
import { ValidationError } from '../utils/errors.js';

const MAX_INT32 = 2147483647;

function validateFilters(query = {}) {
  const { accountId, from, to } = query;

  let validatedAccountId;
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    const num = Number(accountId);
    if (!Number.isInteger(num) || num <= 0 || num > MAX_INT32) {
      throw new ValidationError('accountId must be a positive integer');
    }
    validatedAccountId = num;
  }

  let fromDate;
  let toDate;
  if (from) {
    fromDate = new Date(from);
    if (isNaN(fromDate.getTime())) {
      throw new ValidationError('Invalid date format');
    }
  }

  if (to) {
    toDate = new Date(to);
    if (isNaN(toDate.getTime())) {
      throw new ValidationError('Invalid date format');
    }
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('from date must be before or equal to to date');
  }

  return {
    accountId: validatedAccountId,
    from: from ? fromDate.toISOString() : undefined,
    to: to ? toDate.toISOString() : undefined,
  };
}

export async function getOpenings(userId, query = {}) {
  const filters = validateFilters(query);
  return analyticsRepo.getOpenings({ userId, ...filters });
}

export async function getPhases(userId, query = {}) {
  const filters = validateFilters(query);
  return analyticsRepo.getPhases({ userId, ...filters });
}

export async function getTimePressure(userId, query = {}) {
  const filters = validateFilters(query);
  return analyticsRepo.getTimePressure({ userId, ...filters });
}

export const analyticsService = {
  getOpenings,
  getPhases,
  getTimePressure,
};

export default analyticsService;
