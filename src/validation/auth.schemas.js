import { z } from 'zod';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const registerBody = z.object({
  email: z
    .string({ error: 'is required' })
    .trim()
    .refine((value) => EMAIL_REGEX.test(value), 'must be a valid email address'),
  password: z.string({ error: 'is required' }).min(8, 'must be at least 8 characters long'),
});

// Login stays lenient on shape: wrong or missing credentials are a 401 with one message for every
// case, so the response never reveals which field was wrong. Only non-string values are a 400.
export const loginBody = z.object({
  email: z.string({ error: 'must be a string' }).optional(),
  password: z.string({ error: 'must be a string' }).optional(),
});
