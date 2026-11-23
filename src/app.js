import fs from 'fs';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import v1Router from './routes/v1/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRateLimiter, authRateLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import * as healthController from './controllers/health.controller.js';

export function createApp(options = {}) {
  const app = express();

  // 0. Security headers, before anything else so every response (API, static, errors) carries them.
  // The built client loads one module script and one stylesheet from /assets and sets styles only
  // through the DOM (React style props), so no 'unsafe-inline' is needed. data: images are used by
  // the drag preview of the board.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
    })
  );

  // 1. Request logger
  app.use(requestLogger);

  // Root health endpoint (unauthenticated)
  app.get('/health', healthController.check);

  // 2. Body parser
  app.use(express.json({ limit: '1mb' }));

  // 3. Rate limiters
  const apiLimiter = options.apiRateLimiter ?? apiRateLimiter;
  const authLimiter = options.authRateLimiter ?? authRateLimiter;
  app.use('/api', apiLimiter);
  app.use('/api/v1/auth', authLimiter);

  // 4. API v1 router
  app.use('/api/v1', v1Router);

  // 5. Static client serving with SPA fallback for non-/api GET routes
  const clientDist = options.clientDistPath ?? path.resolve(process.cwd(), 'client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        return next();
      }
      const indexPath = path.join(clientDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
      next();
    });
  }

  // 6. 404 handler (API routes never fall through to index.html)
  app.use(notFoundHandler);

  // 7. Error handler
  app.use(errorHandler);

  return app;
}
