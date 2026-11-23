import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prismaClientOptions, attachQueryLogger, closeDb } from '../src/config/db.js';

describe('optional Prisma query logging', () => {
  const clients = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect()));
    await closeDb();
  });

  it('is off by default', () => {
    const opts = prismaClientOptions({ nodeEnv: 'production', prismaLogQueries: false });
    expect(opts.log).toEqual(['error']);
  });

  it('adds a query event when PRISMA_LOG_QUERIES is on', () => {
    const opts = prismaClientOptions({ nodeEnv: 'development', prismaLogQueries: true });
    expect(opts.log).toEqual(['warn', 'error', { emit: 'event', level: 'query' }]);
  });

  it('logs query text, params and duration through the logger', async () => {
    const client = new PrismaClient(prismaClientOptions({ nodeEnv: 'test', prismaLogQueries: true }));
    clients.push(client);
    const records = [];
    attachQueryLogger(client, { info: (msg, meta) => records.push({ msg, ...meta }) });

    await client.platform.findUnique({ where: { name: 'lichess' } });

    const record = records.find((r) => r.query.includes('"platforms"'));
    expect(record).toBeDefined();
    expect(record.msg).toBe('db query');
    expect(record.params).toContain('lichess');
    expect(typeof record.durationMs).toBe('number');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });
});
