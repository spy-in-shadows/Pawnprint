import { closeDb as defaultCloseDb } from './config/db.js';
import { logger as defaultLogger } from './utils/logger.js';

const FORCE_CLOSE_MS = 10000;

// Stops accepting connections and resolves once open requests have finished. Idle keep-alive
// connections are closed straight away; anything still open after FORCE_CLOSE_MS is cut.
function closeServer(server, forceAfterMs) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    const timer = setTimeout(() => server.closeAllConnections?.(), forceAfterMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

/**
 * Graceful shutdown for the API process. On SIGINT/SIGTERM: stop accepting connections, wait for
 * open requests, close the pg pool and Prisma, exit 0. On an unhandled rejection or uncaught
 * exception: log it, close the same resources, exit 1 (the process state can no longer be trusted).
 * Returns the shutdown function so tests can drive it without sending real signals.
 */
export function installShutdownHandlers({
  server,
  closeDb = defaultCloseDb,
  logger = defaultLogger,
  exit = (code) => process.exit(code),
  proc = process,
  forceAfterMs = FORCE_CLOSE_MS,
} = {}) {
  let shuttingDown = null;

  function shutdown(reason, code = 0, err = undefined) {
    if (shuttingDown) return shuttingDown;
    if (err) logger.error('Fatal error, shutting down', { reason, err });
    else logger.info('API stopping', { signal: reason });

    shuttingDown = (async () => {
      try {
        await closeServer(server, forceAfterMs);
        logger.info('HTTP server closed');
        await closeDb();
        logger.info('Database connections closed');
      } catch (closeErr) {
        logger.error('Error during shutdown', { err: closeErr });
        code = 1;
      }
      exit(code);
    })();
    return shuttingDown;
  }

  proc.on('SIGINT', () => shutdown('SIGINT'));
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('unhandledRejection', (reason) =>
    shutdown('unhandledRejection', 1, reason instanceof Error ? reason : new Error(String(reason)))
  );
  proc.on('uncaughtException', (err) => shutdown('uncaughtException', 1, err));

  return shutdown;
}

export default installShutdownHandlers;
