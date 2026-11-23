// High-throughput and hot paths (bulk move insertions, SKIP LOCKED job claiming)
// query Postgres directly via pgPool for minimal overhead and explicit transaction control.
// Standard CRUD, relational queries, and lookup data access use the singleton PrismaClient.

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import config from './env.js';
import { logger } from '../utils/logger.js';

// Timestamp columns are `timestamp without time zone` holding UTC wall-clock time, which is how
// Prisma writes and reads them. pg defaults to the host's local zone in both directions, so on any
// non-UTC machine raw-SQL writes (played_at from the bulk insert) would be shifted by the offset.
const TIMESTAMP_OID = 1114;
pg.defaults.parseInputDatesAsUTC = true;
pg.types.setTypeParser(TIMESTAMP_OID, (value) => new Date(`${value.replace(' ', 'T')}Z`));

export function prismaClientOptions({ nodeEnv, prismaLogQueries }) {
  const log = nodeEnv === 'development' ? ['warn', 'error'] : ['error'];
  if (prismaLogQueries) {
    // Emitted as events (not printed by Prisma) so queries go through the project logger.
    log.push({ emit: 'event', level: 'query' });
  }
  return { log };
}

export function attachQueryLogger(client, log = logger) {
  client.$on('query', (event) => {
    log.info('db query', {
      query: event.query,
      params: event.params,
      durationMs: Number(event.duration),
    });
  });
}

export const prisma = new PrismaClient(prismaClientOptions(config));
if (config.prismaLogQueries) {
  attachQueryLogger(prisma);
}

export const pgPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on('error', (err) => {
  logger.error('Unexpected error on idle pg client', { err });
});

export async function withTransaction(fn) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Error rolling back transaction', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

let isClosed = false;

export async function closeDb() {
  if (isClosed) return;
  isClosed = true;
  await Promise.allSettled([
    pgPool.end(),
    prisma.$disconnect(),
  ]);
}
