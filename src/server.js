import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const server = createApp().listen(port, () => {
  console.log(`API listening on http://localhost:${server.address().port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
