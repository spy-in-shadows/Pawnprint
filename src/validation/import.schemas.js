import { z } from 'zod';
import { dateString, idParam, looseInt, optional } from './common.js';

// accountId must be an integer (400 otherwise); an integer that cannot be an id (0, negative,
// larger than int4) is answered with 404 by the controller, like an account that does not exist.
export const createImportBody = z.object({
  accountId: z
    .union([z.number(), z.string().trim().min(1)], { error: 'is required and must be an integer' })
    .transform(Number)
    .refine(Number.isInteger, 'must be an integer'),
  maxGames: optional(looseInt),
  since: optional(dateString),
  until: optional(dateString),
});

export const importIdParams = z.object({ id: idParam });
