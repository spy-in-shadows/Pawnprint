import { pgPool } from '../config/db.js';

const SAMPLE_SIZE = 5;
const MATE_EVAL_THRESHOLD = 9000;

// Each check is one query that selects the ids of the offending rows as `id`. $1 is the account
// id or null for the whole database. engine_versions is shared by every account, so that check
// takes no parameter and always covers the whole table.
const CHECKS = [
  {
    name: 'analyzed_games_have_all_evals',
    sql: `
      SELECT DISTINCT g.id
      FROM games g
      JOIN moves m ON m.game_id = g.id
      LEFT JOIN move_evals me ON me.move_id = m.id
      WHERE g.analysis_status = 'analyzed'
        AND me.move_id IS NULL
        AND ($1::int IS NULL OR g.player_account_id = $1)`,
  },
  {
    // (game_id, ply) is unique, so a row count equal to total_plies with plies running from 1 to
    // total_plies leaves no room for a gap or a duplicate.
    name: 'plies_contiguous',
    sql: `
      SELECT g.id
      FROM games g
      LEFT JOIN moves m ON m.game_id = g.id
      WHERE g.analysis_status = 'analyzed'
        AND ($1::int IS NULL OR g.player_account_id = $1)
      GROUP BY g.id, g.total_plies
      HAVING COUNT(m.id) <> g.total_plies
          OR (COUNT(m.id) > 0 AND (MIN(m.ply) <> 1 OR MAX(m.ply) <> g.total_plies))`,
  },
  {
    name: 'every_eval_has_classification',
    sql: `
      SELECT me.move_id AS id
      FROM move_evals me
      JOIN moves m ON m.id = me.move_id
      JOIN games g ON g.id = m.game_id
      LEFT JOIN move_classifications mc ON mc.move_id = me.move_id
      WHERE mc.move_id IS NULL
        AND ($1::int IS NULL OR g.player_account_id = $1)`,
  },
  {
    // Terminal positions are stored with best_uci 'none' and depth 0 because no search ran.
    name: 'eval_ranges',
    sql: `
      SELECT me.move_id AS id
      FROM move_evals me
      JOIN moves m ON m.id = me.move_id
      JOIN games g ON g.id = m.game_id
      WHERE (me.eval_before_cp NOT BETWEEN -10000 AND 10000
             OR me.eval_after_cp NOT BETWEEN -10000 AND 10000
             OR (me.depth <= 0 AND me.best_uci <> 'none'))
        AND ($1::int IS NULL OR g.player_account_id = $1)`,
  },
  {
    // A mate distance of 0 is a finished game: after the move the mover has delivered mate, so the
    // White-perspective eval follows the mover's colour; before the move the mover would be mated.
    // A move_mates row with both distances null has no side to match and is reported as well.
    name: 'mate_rows_consistent',
    sql: `
      WITH sides AS (
        SELECT m.id, me.eval_before_cp AS eval_cp, mm.mate_before AS mate,
               CASE WHEN m.mover_color = 'white' THEN -1 ELSE 1 END AS zero_mate_sign,
               mm.move_id IS NOT NULL AND mm.mate_before IS NULL AND mm.mate_after IS NULL AS empty_row
        FROM move_evals me
        JOIN moves m ON m.id = me.move_id
        JOIN games g ON g.id = m.game_id
        LEFT JOIN move_mates mm ON mm.move_id = me.move_id
        WHERE ($1::int IS NULL OR g.player_account_id = $1)
        UNION ALL
        SELECT m.id, me.eval_after_cp, mm.mate_after,
               CASE WHEN m.mover_color = 'white' THEN 1 ELSE -1 END,
               FALSE
        FROM move_evals me
        JOIN moves m ON m.id = me.move_id
        JOIN games g ON g.id = m.game_id
        LEFT JOIN move_mates mm ON mm.move_id = me.move_id
        WHERE ($1::int IS NULL OR g.player_account_id = $1)
      )
      SELECT DISTINCT id
      FROM sides
      WHERE empty_row
         OR (mate IS NULL AND ABS(eval_cp) > ${MATE_EVAL_THRESHOLD})
         OR (mate IS NOT NULL
             AND NOT (ABS(eval_cp) > ${MATE_EVAL_THRESHOLD}
                      AND SIGN(eval_cp) = CASE WHEN mate = 0 THEN zero_mate_sign ELSE SIGN(mate) END))`,
  },
  {
    name: 'failed_games_have_reason',
    sql: `
      SELECT g.id
      FROM games g
      WHERE g.analysis_status = 'failed'
        AND NULLIF(BTRIM(g.failure_reason), '') IS NULL
        AND ($1::int IS NULL OR g.player_account_id = $1)`,
  },
  {
    name: 'no_orphan_progress',
    sql: `
      SELECT ajg.job_id AS id
      FROM analysis_job_games ajg
      LEFT JOIN analysis_jobs j ON j.id = ajg.job_id
      LEFT JOIN games g ON g.id = ajg.game_id
      WHERE (j.id IS NULL
             OR g.id IS NULL
             OR (j.status = 'completed' AND ajg.status IN ('pending', 'analyzing')))
        AND ($1::int IS NULL OR j.player_account_id = $1 OR g.player_account_id = $1)`,
  },
  {
    name: 'one_active_job_per_account',
    sql: `
      SELECT j.player_account_id AS id
      FROM analysis_jobs j
      WHERE j.status IN ('queued', 'running')
        AND ($1::int IS NULL OR j.player_account_id = $1)
      GROUP BY j.player_account_id
      HAVING COUNT(*) > 1`,
  },
  {
    name: 'engine_versions_unreferenced_dupes',
    scoped: false,
    sql: `
      SELECT MIN(ev.id) AS id
      FROM engine_versions ev
      GROUP BY ev.name, ev.version, ev.default_depth, ev.threads, ev.hash_size
      HAVING COUNT(*) > 1`,
  },
];

export const CHECK_NAMES = CHECKS.map((check) => check.name);

async function runCheck(check, accountId) {
  const { rows } = await pgPool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE((ARRAY_AGG(id ORDER BY id))[1:${SAMPLE_SIZE}], '{}') AS sample
     FROM (${check.sql}) offending`,
    check.scoped === false ? [] : [accountId],
  );
  return { check: check.name, count: rows[0].count, sample: rows[0].sample };
}

export async function runDataQualityChecks({ accountId = null } = {}) {
  const results = [];
  for (const check of CHECKS) {
    results.push(await runCheck(check, accountId));
  }
  const violations = results.filter((result) => result.count > 0);
  return { ok: violations.length === 0, violations };
}
