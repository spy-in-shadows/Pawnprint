import * as analyticsRepo from '../repositories/analytics.repo.js';
import * as summaryService from './summary.service.js';
import { ValidationError } from '../utils/errors.js';

// Formats are validated by analyticsQuery (src/validation/analytics.schemas.js); the date order
// is a business rule and stays here. Dates are normalised to ISO strings for the repository.
function validateFilters(query = {}) {
  const { accountId, from, to } = query;
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;

  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('from date must be before or equal to to date');
  }

  return {
    accountId,
    from: fromDate ? fromDate.toISOString() : undefined,
    to: toDate ? toDate.toISOString() : undefined,
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

export async function getTrend(userId, query = {}) {
  const filters = validateFilters(query);
  return analyticsRepo.getTrend({ userId, ...filters });
}

export async function getMotifs(userId, query = {}) {
  const filters = validateFilters(query);
  return analyticsRepo.getMotifs({ userId, ...filters });
}

export async function getWeakestOpeningPhases(userId, options = {}) {
  return analyticsRepo.getWeakestOpeningPhases({ userId, ...options });
}

export async function getWeakestMotifs(userId, options = {}) {
  return analyticsRepo.getWeakestMotifs({ userId, ...options });
}

export async function getSummary(userId, query = {}) {
  return summaryService.getAccountSummary(userId, query.accountId);
}

export const analyticsService = {
  getOpenings,
  getPhases,
  getTimePressure,
  getTrend,
  getMotifs,
  getWeakestOpeningPhases,
  getWeakestMotifs,
  getSummary,
};

export default analyticsService;
