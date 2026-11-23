import { z } from 'zod';
import { pagination } from './common.js';

export const listUsersQuery = z.object({ ...pagination });
