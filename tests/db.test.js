import { describe, it, expect, afterAll } from 'vitest';
import config from '../src/config/env.js';
import { prisma, pgPool, withTransaction, closeDb } from '../src/config/db.js';

describe('database config, connection pool and transaction helper', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('pool respects max configuration', async () => {
    expect(pgPool.options.max).toBe(config.pgPoolMax);

    // Acquire clients up to pool capacity
    const clients = [];
    try {
      for (let i = 0; i < config.pgPoolMax; i++) {
        clients.push(await pgPool.connect());
      }
      expect(pgPool.totalCount).toBeLessThanOrEqual(config.pgPoolMax);
    } finally {
      clients.forEach((client) => client.release());
    }
  });

  it('withTransaction commits on success and rolls back on throw (verify with a temp table)', async () => {
    // 1. Verify commit on success with a temp table
    const tempValue = await withTransaction(async (client) => {
      await client.query('CREATE TEMP TABLE test_tx_commit_temp (val text)');
      await client.query("INSERT INTO test_tx_commit_temp VALUES ('success_val')");
      const res = await client.query('SELECT val FROM test_tx_commit_temp');
      return res.rows[0].val;
    });
    expect(tempValue).toBe('success_val');

    // 2. Verify rollback on throw with a temp table (table DDL and data roll back completely)
    await expect(
      withTransaction(async (client) => {
        await client.query('CREATE TEMP TABLE test_tx_rollback_temp (val text)');
        await client.query("INSERT INTO test_tx_rollback_temp VALUES ('fail_val')");
        throw new Error('transaction_aborted');
      })
    ).rejects.toThrow('transaction_aborted');

    // 3. Verify cross-query state with an explicit table
    await pgPool.query('CREATE TABLE IF NOT EXISTS _tx_test_state (id int primary key, val text)');
    try {
      await pgPool.query('DELETE FROM _tx_test_state');

      // Successful transaction commits
      await withTransaction(async (client) => {
        await client.query("INSERT INTO _tx_test_state VALUES (1, 'committed')");
      });
      const committedRes = await pgPool.query('SELECT val FROM _tx_test_state WHERE id = 1');
      expect(committedRes.rows[0]?.val).toBe('committed');

      // Failed transaction rolls back
      await expect(
        withTransaction(async (client) => {
          await client.query("INSERT INTO _tx_test_state VALUES (2, 'uncommitted')");
          throw new Error('rollback_error');
        })
      ).rejects.toThrow('rollback_error');

      const rolledBackRes = await pgPool.query('SELECT val FROM _tx_test_state WHERE id = 2');
      expect(rolledBackRes.rows.length).toBe(0);
    } finally {
      await pgPool.query('DROP TABLE IF EXISTS _tx_test_state');
    }
  });

  it('exposes singleton prisma instance and can query database', async () => {
    expect(prisma).toBeDefined();
    const count = await prisma.platform.count();
    expect(typeof count).toBe('number');
  });

  // Prisma stores timestamp columns as UTC wall-clock time; pg must agree on any host time zone.
  it('writes and reads timestamp columns as UTC whatever the host time zone', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try {
      const instant = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
      const written = await pgPool.query('SELECT $1::timestamp::text AS wall', [instant]);
      expect(written.rows[0].wall).toBe('2026-01-01 12:00:00');

      const read = await pgPool.query("SELECT '2026-01-01 12:00:00'::timestamp AS ts");
      expect(read.rows[0].ts.getTime()).toBe(instant.getTime());
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('closeDb is idempotent and handles multiple calls gracefully', async () => {
    await expect(closeDb()).resolves.not.toThrow();
    await expect(closeDb()).resolves.not.toThrow();
  });
});
