import { z } from 'zod';
import { idParam } from './common.js';

export const PLATFORMS = ['lichess', 'chesscom', 'upload'];

export const linkAccountBody = z.object({
  platform: z
    .string({ error: 'is required' })
    .trim()
    .toLowerCase()
    .refine((value) => PLATFORMS.includes(value), `must be one of: ${PLATFORMS.join(', ')}`),
  username: z.string({ error: 'is required' }).trim().min(1, 'is required'),
});

export const accountIdParams = z.object({ id: idParam });
