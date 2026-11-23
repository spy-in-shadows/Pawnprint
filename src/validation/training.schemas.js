import { z } from 'zod';
import { idParam } from './common.js';

// The plan and item ids are checked one at a time so each gets its own 404 message;
// looseObject keeps the other param for the next check.
export const planIdParams = z.looseObject({ planId: idParam });
export const itemIdParams = z.looseObject({ itemId: idParam });

export const updateItemBody = z.object({
  completed: z.boolean({ error: 'must be a boolean' }),
});
