import { z } from 'zod';
import { ECO_REGEX, dateString, idParam, optional, pagination, positiveId } from './common.js';

export const listGamesQuery = z.object({
  accountId: optional(positiveId),
  from: optional(dateString),
  to: optional(dateString),
  opening: optional(z.string().regex(ECO_REGEX, 'must be a 3-character ECO code such as B00')),
  ...pagination,
});

export const gameIdParams = z.object({ id: idParam });
