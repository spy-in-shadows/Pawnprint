import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';
import { installShutdownHandlers } from '../src/shutdown.js';

function setup({ closeDb = vi.fn(async () => {}) } = {}) {
  const proc = new EventEmitter();
  const calls = [];
  const logger = { info: vi.fn(), error: vi.fn() };
  const server = http.createServer((req, res) => res.end('ok'));
  const exit = vi.fn();
  const db = vi.fn(async () => {
    calls.push(server.listening ? 'db-closed-while-listening' : 'db-closed-after-server');
    await closeDb();
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const shutdown = installShutdownHandlers({ server, closeDb: db, logger, exit, proc, forceAfterMs: 200 });
      resolve({ proc, server, exit, db, logger, calls, shutdown });
    });
  });
}

describe('API shutdown', () => {
  it('on SIGTERM stops accepting connections, then closes the database, then exits 0', async () => {
    const { proc, server, exit, db, calls, shutdown } = await setup();
    proc.emit('SIGTERM');
    await shutdown('SIGTERM');
    expect(server.listening).toBe(false);
    expect(db).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['db-closed-after-server']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second signal does not close twice', async () => {
    const { proc, db, exit, shutdown } = await setup();
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await shutdown('SIGINT');
    expect(db).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('an unhandled rejection is logged, resources are closed and the exit code is 1', async () => {
    const { proc, db, exit, logger, shutdown } = await setup();
    proc.emit('unhandledRejection', new Error('boom'));
    await shutdown();
    expect(logger.error).toHaveBeenCalledWith('Fatal error, shutting down', expect.objectContaining({ reason: 'unhandledRejection' }));
    expect(db).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('an uncaught exception exits 1 after closing the database', async () => {
    const { proc, db, exit, shutdown } = await setup();
    proc.emit('uncaughtException', new Error('crash'));
    await shutdown();
    expect(db).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 if closing the database fails', async () => {
    const { proc, exit, shutdown } = await setup({ closeDb: vi.fn(async () => { throw new Error('db gone'); }) });
    proc.emit('SIGTERM');
    await shutdown();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('an open keep-alive connection does not hold up shutdown', async () => {
    const { server, exit, shutdown } = await setup();
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve) => {
      http.get({ port: server.address().port, agent }, (res) => { res.resume(); res.on('end', resolve); });
    });
    const started = Date.now();
    await shutdown('SIGTERM');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(exit).toHaveBeenCalledWith(0);
    agent.destroy();
  });
});
