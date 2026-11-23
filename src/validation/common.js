import { z } from 'zod';

export const INT4_MAX = 2147483647;
export const ECO_REGEX = /^[A-E]\d\d$/;

// Query strings and form fields send '' for "not set"; treat it (and null) as absent.
const blankToUndefined = (value) => (value === '' || value === null ? undefined : value);

export const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());

// Positive 32-bit id given as a number or a numeric string (route params, query, JSON bodies).
export const positiveId = z.coerce
  .number({ error: 'must be a positive integer' })
  .int('must be a positive integer')
  .positive('must be a positive integer')
  .max(INT4_MAX, 'must be a positive integer');

export const idParam = z.string().pipe(positiveId);

// Any integer, given as a number or numeric string (ranges are clamped by the services).
export const looseInt = z.coerce.number({ error: 'must be an integer' }).int('must be an integer');

export const dateString = z
  .union([z.string(), z.date()], { error: 'must be a valid date' })
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'must be a valid date');

export const pagination = {
  page: optional(looseInt),
  pageSize: optional(looseInt),
};
