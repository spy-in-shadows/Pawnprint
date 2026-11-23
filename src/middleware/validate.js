import { NotFoundError, ValidationError } from '../utils/errors.js';

// Formats zod issues as "field: problem" pairs so the 400 message lists every failing field.
export function formatIssues(issues) {
  return issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join('.') : 'request';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Parses request parts with zod schemas and replaces them with the parsed values.
 * - body: req.body is replaced.
 * - params: req.params is replaced. Malformed ids are answered like missing records (404 with
 *   `paramsNotFound` as the message) when that option is given, so ids never leak existence.
 * - query: Express 5 exposes req.query through a getter, so the parsed query is stored on
 *   req.validatedQuery and controllers read it from there.
 * Any other failure is a 400 VALIDATION_ERROR whose message names each failing field.
 */
export function validate({ body, params, query, paramsNotFound } = {}) {
  return function validateRequest(req, res, next) {
    if (params) {
      const result = params.safeParse(req.params ?? {});
      if (!result.success) {
        return next(
          paramsNotFound
            ? new NotFoundError(paramsNotFound)
            : new ValidationError(`Invalid request: ${formatIssues(result.error.issues)}`)
        );
      }
      req.params = result.data;
    }

    const issues = [];
    let parsedBody;
    let parsedQuery;
    if (body) {
      const result = body.safeParse(req.body ?? {});
      if (result.success) parsedBody = result.data;
      else issues.push(...result.error.issues);
    }
    if (query) {
      const result = query.safeParse(req.query ?? {});
      if (result.success) parsedQuery = result.data;
      else issues.push(...result.error.issues);
    }
    if (issues.length) {
      return next(new ValidationError(`Invalid request: ${formatIssues(issues)}`));
    }
    if (body) req.body = parsedBody;
    if (query) req.validatedQuery = parsedQuery;
    return next();
  };
}

export default validate;
