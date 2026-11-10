import express from 'express';
import v1Router from './routes/v1/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', v1Router);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
