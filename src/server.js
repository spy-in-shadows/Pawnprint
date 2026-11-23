import { createApp } from './app.js';
import config from './config/env.js';
import { logger } from './utils/logger.js';
import { installShutdownHandlers } from './shutdown.js';

const server = createApp().listen(config.port, () => {
  logger.info('API listening', { url: `http://localhost:${server.address().port}` });
});

installShutdownHandlers({ server });
