import { verifyToken } from '../services/auth.service.js';
import { UnauthorizedError } from '../utils/errors.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return next(new UnauthorizedError('Authorization header missing'));
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return next(new UnauthorizedError('Malformed authorization header'));
  }

  const token = parts[1];
  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

export default authenticate;
