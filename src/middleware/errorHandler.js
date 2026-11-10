import { AppError } from '../utils/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}`, code: 'NOT_FOUND' } });
}

// body-parser errors carry their own status and `type`.
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': { status: 400, message: 'Malformed JSON body', code: 'INVALID_JSON' },
  'entity.too.large': { status: 413, message: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' },
};

// Express only treats a middleware as an error handler when it declares all four arguments.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }

  const parserError = BODY_PARSER_ERRORS[err.type];
  if (parserError) {
    return res.status(parserError.status).json({ error: { message: parserError.message, code: parserError.code } });
  }

  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  return res.status(500).json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
}
