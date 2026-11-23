import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

// Runs after `authenticate`. The role comes from the access token, so a role change takes
// effect when the user's next access token is issued (at most ACCESS_TOKEN_TTL later).
export function requireRole(...roles) {
  const allowed = new Set(roles);
  return function authorize(req, res, next) {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }
    if (!allowed.has(req.user.role)) {
      return next(new ForbiddenError());
    }
    return next();
  };
}

export default requireRole;
