// High-throughput chess game ingestion and analysis storage repository.
// Inserting all moves of a game via UNNEST over parallel typed arrays eliminates write amplification:
// it collapses dozens of individual INSERT statements into a single SQL statement, requiring exactly one
// network round trip and one WAL flush per game rather than one per ply.

import { pgPool, withTransaction } from '../config/db.js';

let lookupCache = null;

async function getLookups(client) {
  if (lookupCache) return lookupCache;

  const phasesRes = await client.query('SELECT id, name FROM phases');
  const classesRes = await client.query('SELECT id, name FROM classifications');
  const motifsRes = await client.query('SELECT id, name FROM motifs');
  const resultsRes = await client.query('SELECT id, code FROM results');

  const phases = new Map(phasesRes.rows.map((r) => [r.name, r.id]));
  const classifications = new Map(classesRes.rows.map((r) => [r.name, r.id]));
  const motifs = new Map(motifsRes.rows.map((r) => [r.name, r.id]));
  const results = new Map(resultsRes.rows.map((r) => [r.code, r.id]));

  lookupCache = { phases, classifications, motifs, results };
  return lookupCache;
}

function deriveResultCode(resultRaw, color) {
  if (resultRaw === '1-0') {
    return color === 'white' ? 'win' : 'loss';
  }
  if (resultRaw === '0-1') {
    return color === 'white' ? 'loss' : 'win';
  }
  return 'draw';
}

/**
 * Inserts a game and all its parsed plies inside a single atomic transaction.
 * Idempotent: returns { gameId, isNew: false } if the game has already been ingested.
 */
export async function insertGameWithMoves(accountId, parsedGame) {
  return withTransaction(async (client) => {
    const lookups = await getLookups(client);

    // 1. Account lookup
    const accRes = await client.query(
      'SELECT id, platform_id, username FROM player_accounts WHERE id = $1',
      [accountId]
    );
    if (accRes.rowCount === 0) {
      throw new Error(`Player account not found: ${accountId}`);
    }
    const account = accRes.rows[0];

    // 2. Decide player color (case-insensitive username match; default 'white' if neither matches)
    const accUsername = (account.username || '').toLowerCase();
    const whitePlayer = (parsedGame.white || '').toLowerCase();
    const blackPlayer = (parsedGame.black || '').toLowerCase();

    let color = 'white';
    if (accUsername === whitePlayer) {
      color = 'white';
    } else if (accUsername === blackPlayer) {
      color = 'black';
    }

    // 3. Derive result relative to player's color
    const resultCode = deriveResultCode(parsedGame.resultRaw, color);
    const resultId = lookups.results.get(resultCode) || 3;

    // 4. Upsert time control if provided
    let timeControlId = null;
    if (parsedGame.timeControl) {
      const tc = parsedGame.timeControl;
      const tcRes = await client.query(
        `INSERT INTO time_controls (base_seconds, increment_seconds, category)
         VALUES ($1, $2, $3)
         ON CONFLICT (base_seconds, increment_seconds)
         DO UPDATE SET category = EXCLUDED.category
         RETURNING id;`,
        [tc.baseSeconds, tc.incrementSeconds, tc.category]
      );
      timeControlId = tcRes.rows[0].id;
    }

    // 5. Resolve opening by ECO code
    let openingId = null;
    if (parsedGame.eco) {
      const openRes = await client.query(
        'SELECT id FROM openings WHERE eco = $1 LIMIT 1',
        [parsedGame.eco]
      );
      if (openRes.rowCount > 0) {
        openingId = openRes.rows[0].id;
      }
    }

    // 6. Ratings relative to assigned color
    const playerRating = color === 'white' ? (parsedGame.whiteElo ?? null) : (parsedGame.blackElo ?? null);
    const opponentRating = color === 'white' ? (parsedGame.blackElo ?? null) : (parsedGame.whiteElo ?? null);

    // 7. Analysis status and failure reason
    const hasNoMoves = !parsedGame.moves || parsedGame.moves.length === 0;
    let analysisStatus = 'pending';
    let failureReason = null;

    if (parsedGame.parseError && hasNoMoves) {
      analysisStatus = 'failed';
      failureReason = parsedGame.parseError;
    } else if (parsedGame.parseError) {
      failureReason = parsedGame.parseError;
    }

    const totalPlies = parsedGame.moves ? parsedGame.moves.length : (parsedGame.totalPlies || 0);
    const playedAt = parsedGame.playedAt || new Date();

    // 8. Insert game header with idempotent conflict handling
    const gameInsertSql = `
      INSERT INTO games (
        player_account_id,
        platform_id,
        external_id,
        played_at,
        color,
        result_id,
        opening_id,
        time_control_id,
        player_rating,
        opponent_rating,
        total_plies,
        analysis_status,
        failure_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (platform_id, external_id) DO NOTHING
      RETURNING id;
    `;

    const gameRes = await client.query(gameInsertSql, [
      account.id,
      account.platform_id,
      parsedGame.externalId,
      playedAt,
      color,
      resultId,
      openingId,
      timeControlId,
      playerRating,
      opponentRating,
      totalPlies,
      analysisStatus,
      failureReason,
    ]);

    if (gameRes.rowCount === 0) {
      const existingRes = await client.query(
        'SELECT id FROM games WHERE platform_id = $1 AND external_id = $2',
        [account.platform_id, parsedGame.externalId]
      );
      return { gameId: existingRes.rows[0].id, isNew: false };
    }

    const gameId = gameRes.rows[0].id;

    if (hasNoMoves) {
      return { gameId, isNew: true };
    }

    // 9. Insert all moves in a single bulk statement using UNNEST
    const plies = [];
    const sans = [];
    const ucis = [];
    const fens = [];
    const moverColors = [];
    const clocks = [];
    const timesSpent = [];
    const phaseIds = [];

    for (const m of parsedGame.moves) {
      plies.push(m.ply);
      sans.push(m.san);
      ucis.push(m.uci);
      fens.push(m.fenBefore);
      moverColors.push(m.moverColor);
      clocks.push(m.clockRemainingMs ?? null);
      timesSpent.push(m.timeSpentMs ?? null);
      const phaseId = lookups.phases.get(m.phase) || (m.phase === 'opening' ? 1 : m.phase === 'middlegame' ? 2 : 3);
      phaseIds.push(phaseId);
    }

    const movesInsertSql = `
      INSERT INTO moves (
        game_id,
        ply,
        san,
        uci,
        fen_before,
        mover_color,
        clock_remaining_ms,
        time_spent_ms,
        phase_id
      )
      SELECT
        $1,
        u.ply,
        u.san,
        u.uci,
        u.fen_before,
        u.mover_color,
        u.clock_remaining_ms,
        u.time_spent_ms,
        u.phase_id
      FROM UNNEST(
        $2::int[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::int[],
        $8::int[],
        $9::int[]
      ) AS u(ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id)
      ORDER BY u.ply ASC;
    `;

    await client.query(movesInsertSql, [
      gameId,
      plies,
      sans,
      ucis,
      fens,
      moverColors,
      clocks,
      timesSpent,
      phaseIds,
    ]);

    return { gameId, isNew: true };
  });
}

/**
 * Bulk-inserts engine evaluation, mate analysis, move classifications, and motifs
 * for an entire game inside one transaction, updating the game status to 'analyzed'.
 */
export async function saveGameAnalysis({ gameId, engineVersionId, moves }) {
  return withTransaction(async (client) => {
    const lookups = await getLookups(client);

    // 1. Map game plies to internal move IDs
    const movesRes = await client.query(
      'SELECT id, ply FROM moves WHERE game_id = $1 ORDER BY ply ASC',
      [gameId]
    );
    const plyToMoveId = new Map(movesRes.rows.map((r) => [r.ply, r.id]));

    // 2. Prepare UNNEST arrays for move_evals
    const evalMoveIds = [];
    const evalsBefore = [];
    const evalsAfter = [];
    const bestUcis = [];
    const depths = [];
    const engineVersionIds = [];

    // 3. Prepare UNNEST arrays for move_mates (only where mate distance exists)
    const mateMoveIds = [];
    const matesBefore = [];
    const matesAfter = [];

    // 4. Prepare UNNEST arrays for move_classifications
    const classMoveIds = [];
    const classIds = [];
    const cpLosses = [];

    // 5. Prepare UNNEST arrays for move_motifs
    const motifMoveIds = [];
    const motifIds = [];
    const motifKinds = [];

    for (const m of moves) {
      const moveId = plyToMoveId.get(m.ply);
      if (!moveId) continue;

      evalMoveIds.push(moveId);
      evalsBefore.push(m.evalBeforeCp);
      evalsAfter.push(m.evalAfterCp);
      bestUcis.push(m.bestUci);
      depths.push(m.depth);
      engineVersionIds.push(engineVersionId);

      if (
        (m.mateBefore !== null && m.mateBefore !== undefined) ||
        (m.mateAfter !== null && m.mateAfter !== undefined)
      ) {
        mateMoveIds.push(moveId);
        matesBefore.push(m.mateBefore ?? null);
        matesAfter.push(m.mateAfter ?? null);
      }

      if (m.classification) {
        const classId = lookups.classifications.get(m.classification);
        if (classId) {
          classMoveIds.push(moveId);
          classIds.push(classId);
          cpLosses.push(m.cpLoss ?? 0);
        }
      }

      if (m.motifs && m.motifs.length > 0) {
        for (const item of m.motifs) {
          const motifId = lookups.motifs.get(item.name);
          if (motifId) {
            motifMoveIds.push(moveId);
            motifIds.push(motifId);
            motifKinds.push(item.kind || 'allowed');
          }
        }
      }
    }

    if (evalMoveIds.length > 0) {
      const insertEvalsSql = `
        INSERT INTO move_evals (
          move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id
        )
        SELECT * FROM UNNEST(
          $1::int[],
          $2::int[],
          $3::int[],
          $4::text[],
          $5::int[],
          $6::int[]
        )
        ON CONFLICT (move_id) DO NOTHING;
      `;
      await client.query(insertEvalsSql, [
        evalMoveIds,
        evalsBefore,
        evalsAfter,
        bestUcis,
        depths,
        engineVersionIds,
      ]);
    }

    if (mateMoveIds.length > 0) {
      const insertMatesSql = `
        INSERT INTO move_mates (move_id, mate_before, mate_after)
        SELECT * FROM UNNEST(
          $1::int[],
          $2::int[],
          $3::int[]
        )
        ON CONFLICT (move_id) DO NOTHING;
      `;
      await client.query(insertMatesSql, [mateMoveIds, matesBefore, matesAfter]);
    }

    if (classMoveIds.length > 0) {
      const insertClassSql = `
        INSERT INTO move_classifications (move_id, classification_id, cp_loss)
        SELECT * FROM UNNEST(
          $1::int[],
          $2::int[],
          $3::int[]
        )
        ON CONFLICT (move_id) DO NOTHING;
      `;
      await client.query(insertClassSql, [classMoveIds, classIds, cpLosses]);
    }

    if (motifMoveIds.length > 0) {
      const insertMotifsSql = `
        INSERT INTO move_motifs (move_id, motif_id, kind)
        SELECT * FROM UNNEST(
          $1::int[],
          $2::int[],
          $3::text[]
        )
        ON CONFLICT (move_id, motif_id, kind) DO NOTHING;
      `;
      await client.query(insertMotifsSql, [motifMoveIds, motifIds, motifKinds]);
    }

    // 6. Mark game as analyzed
    await client.query(
      "UPDATE games SET analysis_status = 'analyzed' WHERE id = $1",
      [gameId]
    );
  });
}

/**
 * Marks a game as failed with a recorded failure reason.
 */
export async function markGameFailed(gameId, reason) {
  await pgPool.query(
    "UPDATE games SET analysis_status = 'failed', failure_reason = $2 WHERE id = $1",
    [gameId, reason]
  );
}

export const moveBulkRepository = {
  insertGameWithMoves,
  saveGameAnalysis,
  markGameFailed,
};

export default moveBulkRepository;
