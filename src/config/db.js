// High-throughput and hot paths (bulk move insertions, SKIP LOCKED job claiming)
// query Postgres directly via pgPool for minimal overhead and explicit transaction control.
// Standard CRUD, relational queries, and lookup data access use the singleton PrismaClient.

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import config from './env.js';
import { logger } from '../utils/logger.js';

export const prisma = new PrismaClient({
  log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

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
