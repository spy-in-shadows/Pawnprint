import { pgPool, withTransaction } from '../config/db.js';
import { NotFoundError } from '../utils/errors.js';

export async function refreshAccountSummary(accountId) {
  return withTransaction(async (client) => {
    // Check if account exists
    const accCheck = await client.query(
      'SELECT id FROM player_accounts WHERE id = $1',
      [accountId]
    );
    if (accCheck.rowCount === 0) {
      throw new NotFoundError(`Player account ${accountId} not found`);
    }

    // 1. Total games belonging to the account
    const totalGamesRes = await client.query(
      'SELECT COUNT(*)::int AS count FROM games WHERE player_account_id = $1',
      [accountId]
    );
    const totalGames = totalGamesRes.rows[0].count;

    // 2. Aggregate analyzed games metrics for the owner's moves only
    const summarySql = `
      SELECT
        COUNT(DISTINCT g.id)::int AS "analyzedGames",
        COUNT(m.id)::int AS "totalMoves",
        COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int AS inaccuracies,
        COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int AS mistakes,
        COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
        COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0) AS "avgCpLoss",
        COALESCE(
          ROUND(
            (COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric / NULLIF(COUNT(m.id), 0)::numeric) * 100,
            1
          )::float,
          0.0
        ) AS "accuracyPct",
        MAX(g.played_at) AS "lastGameAt"
      FROM games g
      LEFT JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
      LEFT JOIN move_classifications mc ON mc.move_id = m.id
      LEFT JOIN classifications c ON c.id = mc.classification_id
      WHERE g.player_account_id = $1
        AND g.analysis_status = 'analyzed'
    `;
    const summaryRes = await client.query(summarySql, [accountId]);
    const summary = summaryRes.rows[0];

    // 3. Upsert account_summary row
    await client.query(
      `
      INSERT INTO account_summary (
        player_account_id,
        total_games,
        analyzed_games,
        total_moves,
        inaccuracies,
        mistakes,
        blunders,
        avg_cp_loss,
        accuracy_pct,
        last_game_at,
        refreshed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (NOW() AT TIME ZONE 'UTC')
      )
      ON CONFLICT (player_account_id) DO UPDATE SET
        total_games = EXCLUDED.total_games,
        analyzed_games = EXCLUDED.analyzed_games,
        total_moves = EXCLUDED.total_moves,
        inaccuracies = EXCLUDED.inaccuracies,
        mistakes = EXCLUDED.mistakes,
        blunders = EXCLUDED.blunders,
        avg_cp_loss = EXCLUDED.avg_cp_loss,
        accuracy_pct = EXCLUDED.accuracy_pct,
        last_game_at = EXCLUDED.last_game_at,
        refreshed_at = (NOW() AT TIME ZONE 'UTC')
      `,
      [
        accountId,
        totalGames,
        summary.analyzedGames,
        summary.totalMoves,
        summary.inaccuracies,
        summary.mistakes,
        summary.blunders,
        summary.avgCpLoss,
        summary.accuracyPct,
        summary.lastGameAt,
      ]
    );

    // 4. Aggregate phase breakdown
    const phaseSql = `
      SELECT
        p.id AS "phaseId",
        COUNT(m.id)::int AS moves,
        COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
        COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0) AS "avgCpLoss"
      FROM phases p
      LEFT JOIN (
        moves m
        JOIN games g ON m.game_id = g.id AND g.player_account_id = $1 AND g.analysis_status = 'analyzed' AND m.mover_color = g.color
        LEFT JOIN move_classifications mc ON mc.move_id = m.id
        LEFT JOIN classifications c ON c.id = mc.classification_id
      ) ON m.phase_id = p.id
      GROUP BY p.id
      ORDER BY p.id ASC
    `;
    const phaseRes = await client.query(phaseSql, [accountId]);

    // Upsert phase summary rows
    for (const row of phaseRes.rows) {
      await client.query(
        `
        INSERT INTO account_phase_summary (
          player_account_id,
          phase_id,
          moves,
          blunders,
          avg_cp_loss
        ) VALUES (
          $1, $2, $3, $4, $5
        )
        ON CONFLICT (player_account_id, phase_id) DO UPDATE SET
          moves = EXCLUDED.moves,
          blunders = EXCLUDED.blunders,
          avg_cp_loss = EXCLUDED.avg_cp_loss
        `,
        [accountId, row.phaseId, row.moves, row.blunders, row.avgCpLoss]
      );
    }
  });
}

export async function getAccountSummary(userId, accountId = null) {
  // 1. Fetch user accounts
  const accQuery = accountId
    ? `SELECT id FROM player_accounts WHERE user_id = $1 AND id = $2 ORDER BY id ASC`
    : `SELECT id FROM player_accounts WHERE user_id = $1 ORDER BY id ASC`;
  const accParams = accountId ? [userId, accountId] : [userId];
  const accRes = await pgPool.query(accQuery, accParams);

  if (accountId && accRes.rowCount === 0) {
    throw new NotFoundError('Player account not found');
  }

  const accounts = [];

  for (const acc of accRes.rows) {
    const accId = acc.id;

    // Check if summary exists in account_summary
    let sumRes = await pgPool.query(
      `
      SELECT
        player_account_id,
        total_games,
        analyzed_games,
        total_moves,
        inaccuracies,
        mistakes,
        blunders,
        avg_cp_loss,
        accuracy_pct,
        TO_CHAR(last_game_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_game_at_str,
        TO_CHAR(refreshed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS refreshed_at_str
      FROM account_summary
      WHERE player_account_id = $1
      `,
      [accId]
    );

    if (sumRes.rowCount === 0) {
      // Lazy refresh
      await refreshAccountSummary(accId);
      sumRes = await pgPool.query(
        `
        SELECT
          player_account_id,
          total_games,
          analyzed_games,
          total_moves,
          inaccuracies,
          mistakes,
          blunders,
          avg_cp_loss,
          accuracy_pct,
          TO_CHAR(last_game_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_game_at_str,
          TO_CHAR(refreshed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS refreshed_at_str
        FROM account_summary
        WHERE player_account_id = $1
        `,
        [accId]
      );
    }

    const row = sumRes.rows[0];

    // Fetch phase breakdown
    const phaseRes = await pgPool.query(
      `
      SELECT
        p.name AS phase,
        aps.moves,
        aps.blunders,
        aps.avg_cp_loss AS "avgCpLoss"
      FROM account_phase_summary aps
      JOIN phases p ON aps.phase_id = p.id
      WHERE aps.player_account_id = $1
      ORDER BY p.id ASC
      `,
      [accId]
    );

    accounts.push({
      accountId: row.player_account_id,
      totalGames: row.total_games,
      analyzedGames: row.analyzed_games,
      totalMoves: row.total_moves,
      inaccuracies: row.inaccuracies,
      mistakes: row.mistakes,
      blunders: row.blunders,
      avgCpLoss: row.avg_cp_loss,
      accuracyPct: row.accuracy_pct,
      lastGameAt: row.last_game_at_str ? new Date(row.last_game_at_str).toISOString() : null,
      refreshedAt: row.refreshed_at_str ? new Date(row.refreshed_at_str).toISOString() : null,
      phases: phaseRes.rows.map((pr) => ({
        phase: pr.phase,
        moves: pr.moves,
        blunders: pr.blunders,
        avgCpLoss: pr.avgCpLoss,
      })),
    });
  }

  return { accounts };
}

export const summaryService = {
  refreshAccountSummary,
  getAccountSummary,
};

export default summaryService;
