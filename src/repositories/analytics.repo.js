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

export async function getTrend({ userId, accountId, from, to }) {
  const sql = `
    WITH daily_stats AS (
      SELECT
        TO_CHAR(DATE_TRUNC('day', g.played_at), 'YYYY-MM-DD') AS day,
        COUNT(DISTINCT g.id)::int AS games,
        ROUND(
          (COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric / NULLIF(COUNT(m.id), 0)::numeric) * 100,
          1
        )::float AS "accuracyPct"
      FROM moves m
      JOIN games g ON m.game_id = g.id
      JOIN player_accounts pa ON g.player_account_id = pa.id
      LEFT JOIN move_classifications mc ON m.id = mc.move_id
      LEFT JOIN classifications c ON mc.classification_id = c.id
      WHERE pa.user_id = $1
        AND ($2::int IS NULL OR pa.id = $2)
        AND ($3::timestamp IS NULL OR g.played_at >= $3)
        AND ($4::timestamp IS NULL OR g.played_at <= $4)
        AND g.analysis_status = 'analyzed'
        AND m.mover_color = g.color
      GROUP BY DATE_TRUNC('day', g.played_at)
    )
    SELECT
      day,
      games,
      "accuracyPct",
      ROUND(
        AVG("accuracyPct") OVER (
          ORDER BY day
          ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        )::numeric,
        1
      )::float AS "rollingAccuracyPct"
    FROM daily_stats
    ORDER BY day ASC;
  `;

  const res = await pgPool.query(sql, [userId, accountId || null, from || null, to || null]);
  return res.rows;
}

export async function getMotifs({ userId, accountId, from, to }) {
  // Move-frequency rate: errors per 100 of the owner's moves played, NOT opportunity-normalized.
  const sql = `
    WITH owner_moves AS (
      SELECT COUNT(m.id)::int AS total_moves
      FROM moves m
      JOIN games g ON m.game_id = g.id
      JOIN player_accounts pa ON g.player_account_id = pa.id
      WHERE pa.user_id = $1
        AND ($2::int IS NULL OR pa.id = $2)
        AND ($3::timestamp IS NULL OR g.played_at >= $3)
        AND ($4::timestamp IS NULL OR g.played_at <= $4)
        AND g.analysis_status = 'analyzed'
        AND m.mover_color = g.color
    )
    SELECT
      mot.name AS motif,
      mm.kind,
      COUNT(mm.move_id)::int AS "errorCount",
      om.total_moves AS "totalMoves",
      ROUND(
        (COUNT(mm.move_id)::numeric / NULLIF(om.total_moves, 0)::numeric) * 100,
        2
      )::float AS "errorsPer100Moves"
    FROM motifs mot
    CROSS JOIN (VALUES ('allowed'::text), ('missed'::text)) AS k(kind)
    CROSS JOIN owner_moves om
    LEFT JOIN move_motifs mm ON mm.motif_id = mot.id AND mm.kind = k.kind
    LEFT JOIN moves m ON mm.move_id = m.id AND m.mover_color = (
      SELECT g2.color FROM games g2 WHERE g2.id = m.game_id
    )
    LEFT JOIN games g ON m.game_id = g.id AND g.analysis_status = 'analyzed'
    LEFT JOIN player_accounts pa ON g.player_account_id = pa.id
      AND pa.user_id = $1
      AND ($2::int IS NULL OR pa.id = $2)
      AND ($3::timestamp IS NULL OR g.played_at >= $3)
      AND ($4::timestamp IS NULL OR g.played_at <= $4)
    WHERE mm.move_id IS NULL OR pa.id IS NOT NULL
    GROUP BY mot.name, mm.kind, k.kind, om.total_moves
    HAVING COUNT(mm.move_id) > 0
    ORDER BY "errorsPer100Moves" DESC, "errorCount" DESC, mot.name ASC, mm.kind ASC;
  `;

  const res = await pgPool.query(sql, [userId, accountId || null, from || null, to || null]);
  return res.rows;
}

export async function getWeakestOpeningPhases({ userId, limit = 2, minMoves = 20 }) {
  const sql = `
    SELECT
      COALESCE(o.eco, 'Unknown') AS eco,
      COALESCE(o.name, 'Unknown Opening') AS name,
      p.name AS phase,
      COUNT(m.id)::int AS moves,
      COUNT(CASE WHEN c.name IN ('blunder', 'mistake') THEN 1 END)::int AS "errorCount",
      ROUND(AVG(mc.cp_loss)::numeric, 1)::float AS "avgCpLoss"
    FROM moves m
    JOIN games g ON m.game_id = g.id
    JOIN player_accounts pa ON g.player_account_id = pa.id
    JOIN phases p ON m.phase_id = p.id
    LEFT JOIN openings o ON g.opening_id = o.id
    LEFT JOIN move_classifications mc ON m.id = mc.move_id
    LEFT JOIN classifications c ON mc.classification_id = c.id
    WHERE pa.user_id = $1
      AND g.analysis_status = 'analyzed'
      AND m.mover_color = g.color
    GROUP BY o.eco, o.name, p.name
    HAVING COUNT(m.id) >= $2
    ORDER BY "avgCpLoss" DESC, "errorCount" DESC
    LIMIT $3;
  `;

  const res = await pgPool.query(sql, [userId, minMoves, limit]);
  return res.rows;
}

export async function getWeakestMotifs({ userId, limit = 3 }) {
  const sql = `
    SELECT
      mot.name AS motif,
      COUNT(mm.move_id)::int AS "errorCount"
    FROM move_motifs mm
    JOIN motifs mot ON mm.motif_id = mot.id
    JOIN moves m ON mm.move_id = m.id
    JOIN games g ON m.game_id = g.id
    JOIN player_accounts pa ON g.player_account_id = pa.id
    WHERE pa.user_id = $1
      AND g.analysis_status = 'analyzed'
      AND m.mover_color = g.color
    GROUP BY mot.name
    ORDER BY "errorCount" DESC, mot.name ASC
    LIMIT $2;
  `;

  const res = await pgPool.query(sql, [userId, limit]);
  return res.rows;
}

export const analyticsRepo = {
  getOpenings,
  getPhases,
  getTimePressure,
  getTrend,
  getMotifs,
  getWeakestOpeningPhases,
  getWeakestMotifs,
};

export default analyticsRepo;
