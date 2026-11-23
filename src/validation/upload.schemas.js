import { z } from 'zod';
import { optional } from './common.js';

// Multipart text fields arrive as strings. The account must be an integer when given; ownership and
// range are checked by the service (404 when the account is not the caller's).
export const uploadPgnBody = z.object({
  accountId: optional(
    z
      .union([z.number(), z.string().trim()], { error: 'must be an integer' })
      .transform(Number)
      .refine(Number.isInteger, 'must be an integer')
  ),
});
