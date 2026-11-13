import { logger } from '../utils/logger.js';

export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const meta = {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs,
    };

    if (req.user?.id) {
      meta.userId = req.user.id;
    }

    logger.info('HTTP request', meta);
  });

  next();
}

export default requestLogger;
