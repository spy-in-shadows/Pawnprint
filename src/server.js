import { createApp } from './app.js';
import config from './config/env.js';
import { logger } from './utils/logger.js';

const server = createApp().listen(config.port, () => {
  logger.info('API listening', { url: `http://localhost:${server.address().port}` });
});

function shutdown(signal) {
  logger.info('API stopping', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
