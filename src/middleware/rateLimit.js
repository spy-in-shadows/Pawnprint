/**
 * In-memory fixed-window rate limiter per client IP.
 *
 * @param {object} options
 * @param {number} [options.windowMs=60000] - Window duration in milliseconds.
 * @param {number} [options.max=300] - Max requests allowed within window.
 * @param {Function} [options.keyGenerator] - Custom key generator function (req => string).
 * @param {Function} [options.skip] - Function determining whether to skip limiting (req => boolean).
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs ?? 60 * 1000;
  const max = options.max ?? 300;
  const keyGenerator = options.keyGenerator ?? ((req) => req.ip || req.socket?.remoteAddress || 'unknown');
  const skip = options.skip ?? (() => false);

  const hits = new Map();

  function cleanup(now) {
    for (const [key, record] of hits.entries()) {
      if (now >= record.resetAt) {
        hits.delete(key);
      }
    }
  }

  const limiter = function rateLimitMiddleware(req, res, next) {
    if (skip(req)) {
      return next();
    }

    const now = Date.now();
    cleanup(now);

    const key = keyGenerator(req);
    let record = hits.get(key);

    if (!record || now >= record.resetAt) {
      record = {
        count: 1,
        resetAt: now + windowMs,
      };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const retryAfterSeconds = Math.ceil(Math.max(0, record.resetAt - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

    if (record.count > max) {
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        error: {
          message: 'Too many requests, please try again later',
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });
    }

    next();
  };

  limiter.reset = () => {
    hits.clear();
  };

  return limiter;
}

export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 300,
});

export const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  skip: (req) => {
    if (req.method !== 'POST') return true;
    const path = req.path || req.originalUrl || '';
    return !path.endsWith('/login') && !path.endsWith('/register');
  },
});

export default {
  createRateLimiter,
  apiRateLimiter,
  authRateLimiter,
};
