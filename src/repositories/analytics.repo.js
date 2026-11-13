import { pgPool } from '../config/db.js';

export async function getOpenings({ userId, accountId, from, to }) {
  const sql = `
    SELECT
      COALESCE(o.eco, 'Unknown') AS eco,
      COALESCE(o.name, 'Unknown Opening') AS name,
      CASE
        WHEN m.ply BETWEEN 1 AND 10 THEN '1-10'
        WHEN m.ply BETWEEN 11 AND 20 THEN '11-20'
        WHEN m.ply BETWEEN 21 AND 30 THEN '21-30'
        ELSE '31+'
      END AS "plyBucket",
      COUNT(m.id)::int AS moves,
      COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
      ROUND(
        (COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::numeric / NULLIF(COUNT(m.id), 0)::numeric) * 100,
        2
      )::float AS "blundersPer100",
      ROUND(
        AVG(mc.cp_loss)::numeric,
        1
      )::float AS "avgCpLoss"
    FROM moves m
    JOIN games g ON m.game_id = g.id
    JOIN player_accounts pa ON g.player_account_id = pa.id
    LEFT JOIN openings o ON g.opening_id = o.id
    LEFT JOIN move_classifications mc ON m.id = mc.move_id
    LEFT JOIN classifications c ON mc.classification_id = c.id
    WHERE pa.user_id = $1
      AND ($2::int IS NULL OR pa.id = $2)
      AND ($3::timestamp IS NULL OR g.played_at >= $3)
      AND ($4::timestamp IS NULL OR g.played_at <= $4)
      AND g.analysis_status = 'analyzed'
      AND m.mover_color = g.color
    GROUP BY o.eco, o.name, "plyBucket"
    ORDER BY o.eco ASC, "plyBucket" ASC;
  `;

  const res = await pgPool.query(sql, [userId, accountId || null, from || null, to || null]);
  return res.rows;
}

export async function getPhases({ userId, accountId, from, to }) {
  const sql = `
    SELECT
      p.name AS phase,
      COUNT(m.id)::int AS moves,
      ROUND(
        AVG(mc.cp_loss)::numeric,
        1
      )::float AS "avgCpLoss",
      ROUND(
        (COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric / NULLIF(COUNT(m.id), 0)::numeric) * 100,
        1
      )::float AS "accuracyPct",
      COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
      COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int AS mistakes,
      COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int AS inaccuracies
    FROM moves m
    JOIN games g ON m.game_id = g.id
    JOIN player_accounts pa ON g.player_account_id = pa.id
    JOIN phases p ON m.phase_id = p.id
    LEFT JOIN move_classifications mc ON m.id = mc.move_id
    LEFT JOIN classifications c ON mc.classification_id = c.id
    WHERE pa.user_id = $1
      AND ($2::int IS NULL OR pa.id = $2)
      AND ($3::timestamp IS NULL OR g.played_at >= $3)
      AND ($4::timestamp IS NULL OR g.played_at <= $4)
      AND g.analysis_status = 'analyzed'
      AND m.mover_color = g.color
    GROUP BY p.name, p.id
    ORDER BY p.id ASC;
  `;

  const res = await pgPool.query(sql, [userId, accountId || null, from || null, to || null]);
  return res.rows;
}

export async function getTimePressure({ userId, accountId, from, to }) {
  const countSql = `
    SELECT
      COUNT(CASE WHEN tc.base_seconds IS NULL OR tc.base_seconds = 0 OR m.clock_remaining_ms IS NULL THEN 1 END)::int AS "excludedMoves"
    FROM moves m
    JOIN games g ON m.game_id = g.id
    JOIN player_accounts pa ON g.player_account_id = pa.id
    LEFT JOIN time_controls tc ON g.time_control_id = tc.id
    WHERE pa.user_id = $1
      AND ($2::int IS NULL OR pa.id = $2)
      AND ($3::timestamp IS NULL OR g.played_at >= $3)
      AND ($4::timestamp IS NULL OR g.played_at <= $4)
      AND g.analysis_status = 'analyzed'
      AND m.mover_color = g.color;
  `;

  const bucketsSql = `
    WITH bucketed_moves AS (
      SELECT
        m.id,
        mc.cp_loss,
        c.name AS class_name,
        CASE
          WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000)::numeric > 0.50 THEN '>50%'
          WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000)::numeric > 0.25 THEN '25-50%'
          WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000)::numeric >= 0.10 THEN '10-25%'
          ELSE '<10%'
        END AS bucket
      FROM moves m
      JOIN games g ON m.game_id = g.id
      JOIN player_accounts pa ON g.player_account_id = pa.id
      JOIN time_controls tc ON g.time_control_id = tc.id
      LEFT JOIN move_classifications mc ON m.id = mc.move_id
      LEFT JOIN classifications c ON mc.classification_id = c.id
      WHERE pa.user_id = $1
        AND ($2::int IS NULL OR pa.id = $2)
        AND ($3::timestamp IS NULL OR g.played_at >= $3)
        AND ($4::timestamp IS NULL OR g.played_at <= $4)
        AND g.analysis_status = 'analyzed'
        AND m.mover_color = g.color
        AND tc.base_seconds IS NOT NULL
        AND tc.base_seconds > 0
        AND m.clock_remaining_ms IS NOT NULL
    )
    SELECT
      bucket,
      COUNT(id)::int AS moves,
      COUNT(CASE WHEN class_name = 'blunder' THEN 1 END)::int AS blunders,
      ROUND(
        (COUNT(CASE WHEN class_name = 'blunder' THEN 1 END)::numeric / NULLIF(COUNT(id), 0)::numeric) * 100,
        2
      )::float AS "blundersPer100",
      ROUND(
        AVG(cp_loss)::numeric,
        1
      )::float AS "avgCpLoss"
    FROM bucketed_moves
    GROUP BY bucket
    ORDER BY
      CASE bucket
        WHEN '>50%' THEN 1
        WHEN '25-50%' THEN 2
        WHEN '10-25%' THEN 3
        WHEN '<10%' THEN 4
      END ASC;
  `;

  const [countRes, bucketsRes] = await Promise.all([
    pgPool.query(countSql, [userId, accountId || null, from || null, to || null]),
    pgPool.query(bucketsSql, [userId, accountId || null, from || null, to || null]),
  ]);

  return {
    items: bucketsRes.rows,
    excludedMoves: countRes.rows[0]?.excludedMoves ?? 0,
  };
}

export const analyticsRepo = {
  getOpenings,
  getPhases,
  getTimePressure,
};

export default analyticsRepo;
