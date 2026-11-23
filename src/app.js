import fs from 'fs';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/env.js';
import v1Router from './routes/v1/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRateLimiter, authRateLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import * as healthController from './controllers/health.controller.js';

export function createApp(options = {}) {
  const app = express();

  // Behind a reverse proxy every request comes from the proxy's address; trusting it (TRUST_PROXY)
  // makes req.ip the client address from X-Forwarded-For, so rate limits apply per client rather than
  // to everyone at once, and req.protocol follows X-Forwarded-Proto (used by the CSRF origin check).
  app.set('trust proxy', options.trustProxy ?? config.trustProxy);

  // Order matters; each step says why it sits where it does.

  // 1. helmet first: every response, including 429s, 404s and errors, carries the security headers.
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

  // 2. Request logger next, so rejected requests (rate limited, CORS, bad JSON) are logged too.
  app.use(requestLogger);

  // 3. Root health check before the limiters: load balancers and uptime probes must never get 429.
  app.get('/health', healthController.check);

  // 4. CORS before the rate limiters: a 429 must carry Access-Control-Allow-Origin, otherwise a
  // browser on an allowed origin sees an opaque CORS failure instead of the 429. Preflights are
  // answered here and never reach the limiters or the body parser.
  // Only origins in CORS_ORIGINS are allowed (empty default = same-origin only). Credentials stay off:
  // the API authenticates with Bearer tokens; the refresh cookie is same-origin only.
  const allowedOrigins = new Set(options.corsOrigins ?? config.corsOrigins);
  // The refresh/logout CSRF check accepts the same list (src/middleware/csrf.js).
  app.locals.allowedOrigins = allowedOrigins;
  app.use(
    cors({
      origin: (origin, callback) => callback(null, Boolean(origin) && allowedOrigins.has(origin)),
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: false,
    })
  );

  // 5. Rate limiters before any body parsing: a client over its limit is rejected without the
  // server reading or parsing up to 1 MB of JSON for it.
  const apiLimiter = options.apiRateLimiter ?? apiRateLimiter;
  const authLimiter = options.authRateLimiter ?? authRateLimiter;
  app.use('/api', apiLimiter);
  app.use('/api/v1/auth', authLimiter);

  // 6. Body and cookie parsing only for requests that passed the limiters, right before the routes.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // 7. API routes before static files, so /api paths are never shadowed by files in client/dist.
  app.use('/api/v1', v1Router);

  // 8. Static client and SPA fallback after the API, for every remaining non-/api GET.
  const clientDist = options.clientDistPath ?? path.resolve(process.cwd(), 'client/dist');
  // Both checks run once here, not per request; rebuild the client before starting the server.
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    const indexPath = path.join(clientDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api')) {
          return next();
        }
        return res.sendFile(indexPath);
      });
    }
  }

  // 9. 404 after everything that can answer (API routes never fall through to index.html).
  app.use(notFoundHandler);

  // 10. Error handler last: Express only routes errors to handlers registered after the failing step.
  app.use(errorHandler);

  return app;
}
