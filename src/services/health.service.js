import { prisma, pgPool } from '../config/db.js';

export async function check(overrides = {}) {
  const pool = overrides.pgPool || pgPool;
  const db = overrides.prisma || prisma;

  let poolOk = false;
  let prismaOk = false;

  try {
    const res = await pool.query('SELECT 1 AS ok');
    if (res && res.rows && (res.rows[0].ok === 1 || res.rows[0].ok === '1')) {
      poolOk = true;
    }
  } catch {
    poolOk = false;
  }

  try {
    await db.$queryRaw`SELECT 1 AS ok`;
    prismaOk = true;
  } catch {
    prismaOk = false;
  }

  const isHealthy = poolOk && prismaOk;

  return {
    status: isHealthy ? 'ok' : 'degraded',
    database: {
      pgPool: poolOk ? 'connected' : 'disconnected',
      prisma: prismaOk ? 'connected' : 'disconnected',
    },
  };
}

export const healthService = {
  check,
};

export default healthService;
