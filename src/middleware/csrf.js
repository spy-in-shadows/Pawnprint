import { ForbiddenError } from '../utils/errors.js';

// CSRF defence for the cookie-authenticated endpoints (/auth/refresh, /auth/logout).
// A cross-site form or link cannot set a custom header, and a cross-origin fetch that sets one
// needs a CORS preflight, which only CORS_ORIGINS pass. When the browser sends Origin it must be
// this server's own origin or one in CORS_ORIGINS (app.locals.allowedOrigins, set in app.js).
export function requireSameOriginFetch(req, res, next) {
  if (req.get('X-Requested-With') !== 'fetch') {
    return next(new ForbiddenError('Missing X-Requested-With: fetch header'));
  }
  const origin = req.get('Origin');
  if (origin) {
    const own = `${req.protocol}://${req.get('host')}`;
    const allowed = req.app.locals.allowedOrigins ?? new Set();
    if (origin !== own && !allowed.has(origin)) {
      return next(new ForbiddenError('Origin not allowed'));
    }
  }
  return next();
}

export default requireSameOriginFetch;
