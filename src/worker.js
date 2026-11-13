import os from 'node:os';
import { closeDb } from './config/db.js';
import { logger } from './utils/logger.js';
import { JobRunner } from './workers/jobRunner.js';
import workerEvents from './workers/events.js';

const workerId = `${os.hostname()}-${process.pid}`;
const log = logger.child({ workerId });
const runner = new JobRunner(workerId);

workerEvents.on('job:started', ({ jobId, accountId }) => log.info('Job started', { jobId, accountId }));
workerEvents.on('game:done', ({ jobId, gameId }) => log.debug('Game analyzed', { jobId, gameId }));
workerEvents.on('job:finished', (meta) => log.info('Job finished', meta));
workerEvents.on('job:failed', ({ jobId, accountId, err }) => log.error('Job failed', { jobId, accountId, err }));

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Worker stopping', { signal });
  try {
    await runner.stop();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('Worker did not stop cleanly', { err });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log.info('Worker starting');
runner.start().catch(async (err) => {
  log.error('Worker failed to start', { err });
  await runner.stop().catch(() => {});
  await closeDb();
  process.exit(1);
});
