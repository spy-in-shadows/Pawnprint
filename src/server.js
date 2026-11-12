import { createApp } from './app.js';
import config from './config/env.js';

const server = createApp().listen(config.port, () => {
  console.log(`API listening on http://localhost:${server.address().port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
