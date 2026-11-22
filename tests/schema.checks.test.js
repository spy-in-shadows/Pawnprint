import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { pgPool, closeDb } from '../src/config/db.js';

// CHECK constraints added by migration 20261122161952_add_check_constraints.
// Each test makes one invalid write (rejected with SQLSTATE 23514 and the constraint name)
// and one valid write (accepted). Every row is created under a throwaway user that is deleted
// after the test, so ON DELETE CASCADE removes the account, games, moves and jobs.

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const runTag = `checks_${Date.now()}`;
let seq = 0;
let lookups;
let engineVersionId;
let ctx;

async function q(sql, params = []) {
  return pgPool.query(sql, params);
}

async function lookupId(table, column, value) {
  await q(`INSERT INTO ${table} (${column}) VALUES ($1) ON CONFLICT (${column}) DO NOTHING`, [value]);
  const { rows } = await q(`SELECT id FROM ${table} WHERE ${column} = $1`, [value]);
  return rows[0].id;
}

async function expectCheckViolation(promise, constraint) {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected ${constraint} to reject the write`).not.toBeNull();
  expect(err.code).toBe('23514');
  expect(err.constraint).toBe(constraint);
}

async function insertGame(overrides = {}) {
  seq += 1;
  const row = {
    color: 'white',
    analysis_status: 'pending',
    total_plies: 1,
    ...overrides,
  };
  return q(
    `INSERT INTO games (player_account_id, platform_id, external_id, played_at, color, result_id,
                        total_plies, analysis_status)
     VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'UTC'), $4, $5, $6, $7)
     RETURNING id`,
    [ctx.accountId, lookups.platformId, `${runTag}_${seq}`, row.color, lookups.resultId, row.total_plies, row.analysis_status],
  );
}

async function insertMove(gameId, overrides = {}) {
  const row = { ply: 1, mover_color: 'white', ...overrides };
  return q(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, mover_color, phase_id)
     VALUES ($1, $2, 'e4', 'e2e4', $3, $4, $5)
     RETURNING id`,
    [gameId, row.ply, START_FEN, row.mover_color, lookups.phaseId],
  );
}

describe('CHECK constraints', () => {
  beforeAll(async () => {
    lookups = {
      platformId: await lookupId('platforms', 'name', 'lichess'),
      resultId: await lookupId('results', 'code', 'win'),
      phaseId: await lookupId('phases', 'name', 'opening'),
      classificationId: await lookupId('classifications', 'name', 'best'),
      motifId: await lookupId('motifs', 'name', 'pin'),
    };
    const { rows } = await q(
      `INSERT INTO engine_versions (name, version, default_depth, threads, hash_size)
       VALUES ($1, 'test', 12, 1, 64) RETURNING id`,
      [runTag],
    );
    engineVersionId = rows[0].id;
  });

  beforeEach(async () => {
    seq += 1;
    const user = await q(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id",
      [`${runTag}_${seq}@example.com`],
    );
    const account = await q(
      'INSERT INTO player_accounts (user_id, platform_id, username) VALUES ($1, $2, $3) RETURNING id',
      [user.rows[0].id, lookups.platformId, `${runTag}_${seq}`],
    );
    ctx = { userId: user.rows[0].id, accountId: account.rows[0].id };
  });

  afterEach(async () => {
    await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
  });

  afterAll(async () => {
    await q('DELETE FROM engine_versions WHERE id = $1', [engineVersionId]);
    await closeDb();
  });

  it('games_color_check accepts white and black only', async () => {
    await expectCheckViolation(insertGame({ color: 'red' }), 'games_color_check');
    const { rows } = await insertGame({ color: 'black' });
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it('moves_mover_color_check accepts white and black only', async () => {
    const game = await insertGame();
    await expectCheckViolation(insertMove(game.rows[0].id, { mover_color: 'w' }), 'moves_mover_color_check');
    const { rows } = await insertMove(game.rows[0].id, { mover_color: 'white' });
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it('games_analysis_status_check rejects an unknown status on update', async () => {
    const game = await insertGame();
    const gameId = game.rows[0].id;
    await expectCheckViolation(
      q("UPDATE games SET analysis_status = 'done' WHERE id = $1", [gameId]),
      'games_analysis_status_check',
    );
    const { rowCount } = await q(
      "UPDATE games SET analysis_status = 'failed', failure_reason = 'test' WHERE id = $1",
      [gameId],
    );
    expect(rowCount).toBe(1);
  });

  it('analysis_jobs_status_check accepts queued, running, completed and failed only', async () => {
    await expectCheckViolation(
      q("INSERT INTO analysis_jobs (player_account_id, status) VALUES ($1, 'cancelled')", [ctx.accountId]),
      'analysis_jobs_status_check',
    );
    const { rows } = await q(
      "INSERT INTO analysis_jobs (player_account_id, status) VALUES ($1, 'queued') RETURNING id, status",
      [ctx.accountId],
    );
    expect(rows[0].status).toBe('queued');
  });

  it('analysis_jobs_since_until_check rejects since after until', async () => {
    await expectCheckViolation(
      q(
        `INSERT INTO analysis_jobs (player_account_id, since, until)
         VALUES ($1, TIMESTAMP '2026-02-01', TIMESTAMP '2026-01-01')`,
        [ctx.accountId],
      ),
      'analysis_jobs_since_until_check',
    );
    const { rowCount } = await q(
      `INSERT INTO analysis_jobs (player_account_id, since, until)
       VALUES ($1, TIMESTAMP '2026-01-01', TIMESTAMP '2026-02-01')`,
      [ctx.accountId],
    );
    expect(rowCount).toBe(1);
  });

  it('analysis_job_games_status_check accepts the worker progress values only', async () => {
    const game = await insertGame();
    const job = await q('INSERT INTO analysis_jobs (player_account_id) VALUES ($1) RETURNING id', [ctx.accountId]);
    await expectCheckViolation(
      q("INSERT INTO analysis_job_games (job_id, game_id, status) VALUES ($1, $2, 'analyzed')", [
        job.rows[0].id,
        game.rows[0].id,
      ]),
      'analysis_job_games_status_check',
    );
    const { rowCount } = await q(
      "INSERT INTO analysis_job_games (job_id, game_id, status) VALUES ($1, $2, 'done')",
      [job.rows[0].id, game.rows[0].id],
    );
    expect(rowCount).toBe(1);
  });

  it('move_motifs_kind_check accepts allowed and missed only', async () => {
    const game = await insertGame();
    const move = await insertMove(game.rows[0].id);
    const moveId = move.rows[0].id;
    await expectCheckViolation(
      q("INSERT INTO move_motifs (move_id, motif_id, kind) VALUES ($1, $2, 'found')", [moveId, lookups.motifId]),
      'move_motifs_kind_check',
    );
    const { rowCount } = await q(
      "INSERT INTO move_motifs (move_id, motif_id, kind) VALUES ($1, $2, 'missed')",
      [moveId, lookups.motifId],
    );
    expect(rowCount).toBe(1);
  });

  it('move_classifications_cp_loss_check rejects a negative loss', async () => {
    const game = await insertGame();
    const move = await insertMove(game.rows[0].id);
    const moveId = move.rows[0].id;
    await expectCheckViolation(
      q('INSERT INTO move_classifications (move_id, classification_id, cp_loss) VALUES ($1, $2, -1)', [
        moveId,
        lookups.classificationId,
      ]),
      'move_classifications_cp_loss_check',
    );
    const { rowCount } = await q(
      'INSERT INTO move_classifications (move_id, classification_id, cp_loss) VALUES ($1, $2, 0)',
      [moveId, lookups.classificationId],
    );
    expect(rowCount).toBe(1);
  });

  it('moves_ply_check rejects ply 0', async () => {
    const game = await insertGame();
    await expectCheckViolation(insertMove(game.rows[0].id, { ply: 0 }), 'moves_ply_check');
    const { rows } = await insertMove(game.rows[0].id, { ply: 1 });
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it('move_evals_depth_check rejects a negative depth and keeps depth 0 for terminal positions', async () => {
    const game = await insertGame();
    const move = await insertMove(game.rows[0].id);
    const moveId = move.rows[0].id;
    await expectCheckViolation(
      q(
        `INSERT INTO move_evals (move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)
         VALUES ($1, 0, 0, 'e2e4', -1, $2)`,
        [moveId, engineVersionId],
      ),
      'move_evals_depth_check',
    );
    const { rowCount } = await q(
      `INSERT INTO move_evals (move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)
       VALUES ($1, 0, 0, 'none', 0, $2)`,
      [moveId, engineVersionId],
    );
    expect(rowCount).toBe(1);
  });
});
