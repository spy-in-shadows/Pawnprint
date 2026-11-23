import { z } from 'zod';
import { dateString, optional, positiveId } from './common.js';

export const analyticsQuery = z.object({
  accountId: optional(positiveId),
  from: optional(dateString),
  to: optional(dateString),
});

export const summaryQuery = z.object({
  accountId: optional(positiveId),
});
