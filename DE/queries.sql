-- Pawnprint: project queries for the Data Engineering deliverable 6.
--
-- Run against the demo database (see DE/README.md):
--   docker compose -p pawnprint-demo exec -T db psql -U chess -d chess_analytics -f - < DE/queries.sql
--
-- Parameters are literal values taken from the demo data:
--   user id 2, player account id 2 (Lichess account with 50 analyzed games).
--
-- Every query that changes data runs inside BEGIN ... ROLLBACK, so running this
-- file leaves the demo data unchanged. Each block starting with "-- Q" is one query
-- and is run in the same psql session as the rest of its block.

-- Q01. INSERT: register a user, link a player account and import a game idempotently
BEGIN;
INSERT INTO users (email, password_hash)
VALUES ('q01-student@example.com', 'not-a-real-hash')
RETURNING id, email, created_at;

INSERT INTO player_accounts (user_id, platform_id, username)
SELECT u.id, p.id, 'q01_student'
FROM users u, platforms p
WHERE u.email = 'q01-student@example.com' AND p.name = 'lichess'
RETURNING id, user_id, platform_id, username;

-- First run inserts the game.
INSERT INTO games (player_account_id, platform_id, external_id, played_at, color,
                   result_id, opening_id, time_control_id, player_rating, opponent_rating,
                   total_plies, analysis_status)
SELECT pa.id, pa.platform_id, 'q01-game-1', TIMESTAMP '2026-11-01 10:00:00', 'white',
       (SELECT id FROM results WHERE code = 'win'),
       (SELECT id FROM openings WHERE eco = 'C20' ORDER BY id LIMIT 1),
       (SELECT id FROM time_controls WHERE base_seconds = 180 AND increment_seconds = 2),
       1500, 1480, 0, 'pending'
FROM player_accounts pa
WHERE pa.username = 'q01_student'
ON CONFLICT (platform_id, external_id) DO NOTHING
RETURNING id, external_id;

-- Second run of the same statement: the unique key (platform_id, external_id) already exists.
INSERT INTO games (player_account_id, platform_id, external_id, played_at, color,
                   result_id, opening_id, time_control_id, player_rating, opponent_rating,
                   total_plies, analysis_status)
SELECT pa.id, pa.platform_id, 'q01-game-1', TIMESTAMP '2026-11-01 10:00:00', 'white',
       (SELECT id FROM results WHERE code = 'win'),
       (SELECT id FROM openings WHERE eco = 'C20' ORDER BY id LIMIT 1),
       (SELECT id FROM time_controls WHERE base_seconds = 180 AND increment_seconds = 2),
       1500, 1480, 0, 'pending'
FROM player_accounts pa
WHERE pa.username = 'q01_student'
ON CONFLICT (platform_id, external_id) DO NOTHING
RETURNING id, external_id;

SELECT COUNT(*) AS games_with_this_external_id
FROM games WHERE external_id = 'q01-game-1';
ROLLBACK;

-- Q02. UPDATE: move the sync cursor forward and mark an analysis job finished
BEGIN;
SELECT id, last_synced_at FROM player_accounts WHERE id = 2;

-- Cursor update used by the worker (src/workers/jobRunner.js): never moves backwards.
UPDATE player_accounts
SET last_synced_at = GREATEST(COALESCE(last_synced_at, TIMESTAMP '2025-12-01 00:00:00'),
                              TIMESTAMP '2025-12-01 00:00:00')
WHERE id = 2
RETURNING id, last_synced_at;

-- An older timestamp leaves the cursor where it is.
UPDATE player_accounts
SET last_synced_at = GREATEST(COALESCE(last_synced_at, TIMESTAMP '2024-01-01 00:00:00'),
                              TIMESTAMP '2024-01-01 00:00:00')
WHERE id = 2
RETURNING id, last_synced_at;

-- A running job for the account, then the markJobFinished statement (src/workers/jobQueue.js).
INSERT INTO analysis_jobs (player_account_id, status, attempts, locked_by, locked_at, heartbeat_at)
VALUES (2, 'running', 1, 'worker-q02', (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'))
RETURNING id, status;

UPDATE analysis_jobs
SET status = 'completed',
    finished_at = (NOW() AT TIME ZONE 'UTC'),
    failed_games = 0,
    skipped_games = 1
WHERE player_account_id = 2 AND status = 'running'
RETURNING id, status, failed_games, skipped_games, finished_at IS NOT NULL AS has_finished_at;
ROLLBACK;

-- Q03. DELETE: unlink a player account and show the ON DELETE CASCADE chain
BEGIN;
SELECT
  (SELECT COUNT(*) FROM player_accounts WHERE id = 2) AS accounts,
  (SELECT COUNT(*) FROM games WHERE player_account_id = 2) AS games,
  (SELECT COUNT(*) FROM moves m JOIN games g ON g.id = m.game_id WHERE g.player_account_id = 2) AS moves,
  (SELECT COUNT(*) FROM move_evals) AS all_move_evals,
  (SELECT COUNT(*) FROM analysis_jobs WHERE player_account_id = 2) AS jobs,
  (SELECT COUNT(*) FROM account_summary WHERE player_account_id = 2) AS summaries;

DELETE FROM player_accounts WHERE id = 2;

SELECT
  (SELECT COUNT(*) FROM player_accounts WHERE id = 2) AS accounts,
  (SELECT COUNT(*) FROM games WHERE player_account_id = 2) AS games,
  (SELECT COUNT(*) FROM moves m JOIN games g ON g.id = m.game_id WHERE g.player_account_id = 2) AS moves,
  (SELECT COUNT(*) FROM move_evals) AS all_move_evals,
  (SELECT COUNT(*) FROM analysis_jobs WHERE player_account_id = 2) AS jobs,
  (SELECT COUNT(*) FROM account_summary WHERE player_account_id = 2) AS summaries;
ROLLBACK;

SELECT COUNT(*) AS games_after_rollback FROM games WHERE player_account_id = 2;

-- Q04. SELECT with filtering and sorting: latest games of an account with lookups
SELECT g.id,
       g.played_at,
       g.color,
       r.code AS result,
       o.eco,
       o.name AS opening,
       tc.base_seconds || '+' || tc.increment_seconds AS time_control,
       tc.category,
       g.player_rating,
       g.opponent_rating
FROM games g
JOIN results r ON r.id = g.result_id
LEFT JOIN openings o ON o.id = g.opening_id
LEFT JOIN time_controls tc ON tc.id = g.time_control_id
WHERE g.player_account_id = 2
  AND g.played_at >= TIMESTAMP '2025-10-01'
ORDER BY g.played_at DESC
LIMIT 10;

-- Q05. Aggregates: moves, blunders, average centipawn loss and accuracy of an account
SELECT COUNT(DISTINCT g.id)::int AS analyzed_games,
       COUNT(m.id)::int AS total_moves,
       COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int AS inaccuracies,
       COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int AS mistakes,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
       ROUND(AVG(mc.cp_loss)::numeric, 1) AS avg_cp_loss,
       ROUND(COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric
             / NULLIF(COUNT(m.id), 0) * 100, 1) AS accuracy_pct
FROM games g
LEFT JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
LEFT JOIN move_classifications mc ON mc.move_id = m.id
LEFT JOIN classifications c ON c.id = mc.classification_id
WHERE g.player_account_id = 2
  AND g.analysis_status = 'analyzed';

-- Q06. GROUP BY with HAVING: ECO opening groups with at least 5 games, win rate and loss, worst first
WITH game_stats AS (
  SELECT g.id,
         LEFT(o.eco, 1) AS eco_group,
         r.code AS result,
         AVG(mc.cp_loss) AS game_avg_cp_loss
  FROM games g
  JOIN results r ON r.id = g.result_id
  JOIN openings o ON o.id = g.opening_id
  JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
  JOIN move_classifications mc ON mc.move_id = m.id
  WHERE g.player_account_id = 2
    AND g.analysis_status = 'analyzed'
  GROUP BY g.id, LEFT(o.eco, 1), r.code
)
SELECT eco_group,
       COUNT(*) AS games,
       COUNT(*) FILTER (WHERE result = 'win') AS wins,
       ROUND(100.0 * COUNT(*) FILTER (WHERE result = 'win') / COUNT(*), 1) AS win_rate_pct,
       ROUND(AVG(game_avg_cp_loss)::numeric, 1) AS avg_cp_loss
FROM game_stats
GROUP BY eco_group
HAVING COUNT(*) >= 5
ORDER BY avg_cp_loss DESC;

-- Q07. JOIN across five tables: blunders and accuracy by game phase
SELECT p.name AS phase,
       COUNT(m.id)::int AS moves,
       ROUND(AVG(mc.cp_loss)::numeric, 1) AS avg_cp_loss,
       ROUND(COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric
             / NULLIF(COUNT(m.id), 0) * 100, 1) AS accuracy_pct,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
       COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int AS mistakes
FROM moves m
JOIN games g ON m.game_id = g.id
JOIN player_accounts pa ON g.player_account_id = pa.id
JOIN phases p ON m.phase_id = p.id
LEFT JOIN move_classifications mc ON m.id = mc.move_id
LEFT JOIN classifications c ON mc.classification_id = c.id
WHERE pa.user_id = 2
  AND pa.id = 2
  AND g.analysis_status = 'analyzed'
  AND m.mover_color = g.color
GROUP BY p.name, p.id
ORDER BY p.id;

-- Q08. JOIN with CASE buckets: time pressure (share of base clock left) against blunder rate
WITH bucketed_moves AS (
  SELECT m.id,
         mc.cp_loss,
         c.name AS class_name,
         CASE
           WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000) > 0.50 THEN '>50%'
           WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000) > 0.25 THEN '25-50%'
           WHEN m.clock_remaining_ms::numeric / (tc.base_seconds * 1000) >= 0.10 THEN '10-25%'
           ELSE '<10%'
         END AS bucket
  FROM moves m
  JOIN games g ON m.game_id = g.id
  JOIN player_accounts pa ON g.player_account_id = pa.id
  JOIN time_controls tc ON g.time_control_id = tc.id
  LEFT JOIN move_classifications mc ON m.id = mc.move_id
  LEFT JOIN classifications c ON mc.classification_id = c.id
  WHERE pa.user_id = 2
    AND pa.id = 2
    AND g.analysis_status = 'analyzed'
    AND m.mover_color = g.color
    AND tc.base_seconds > 0
    AND m.clock_remaining_ms IS NOT NULL
)
SELECT bucket,
       COUNT(id)::int AS moves,
       COUNT(CASE WHEN class_name = 'blunder' THEN 1 END)::int AS blunders,
       COUNT(CASE WHEN class_name IN ('mistake', 'blunder') THEN 1 END)::int AS mistakes_and_blunders,
       ROUND(COUNT(CASE WHEN class_name IN ('mistake', 'blunder') THEN 1 END)::numeric
             / NULLIF(COUNT(id), 0) * 100, 2) AS mistake_rate_pct,
       ROUND(AVG(cp_loss)::numeric, 1) AS avg_cp_loss
FROM bucketed_moves
GROUP BY bucket
ORDER BY CASE bucket WHEN '>50%' THEN 1 WHEN '25-50%' THEN 2 WHEN '10-25%' THEN 3 ELSE 4 END;

-- Q09. Subquery: the account's moves whose loss is far above the account's own average
SELECT g.id AS game_id,
       m.ply,
       m.san,
       p.name AS phase,
       c.name AS classification,
       mc.cp_loss
FROM moves m
JOIN games g ON g.id = m.game_id
JOIN phases p ON p.id = m.phase_id
JOIN move_classifications mc ON mc.move_id = m.id
JOIN classifications c ON c.id = mc.classification_id
WHERE g.player_account_id = 2
  AND m.mover_color = g.color
  AND mc.cp_loss > 5 * (
        SELECT AVG(mc2.cp_loss)
        FROM move_classifications mc2
        JOIN moves m2 ON m2.id = mc2.move_id
        JOIN games g2 ON g2.id = m2.game_id
        WHERE g2.player_account_id = 2
          AND m2.mover_color = g2.color
      )
ORDER BY mc.cp_loss DESC, g.id, m.ply
LIMIT 10;

SELECT COUNT(*) AS moves_above_5x_average
FROM moves m
JOIN games g ON g.id = m.game_id
JOIN move_classifications mc ON mc.move_id = m.id
WHERE g.player_account_id = 2
  AND m.mover_color = g.color
  AND mc.cp_loss > 5 * (
        SELECT AVG(mc2.cp_loss)
        FROM move_classifications mc2
        JOIN moves m2 ON m2.id = mc2.move_id
        JOIN games g2 ON g2.id = m2.game_id
        WHERE g2.player_account_id = 2
          AND m2.mover_color = g2.color
      );

-- Q10. CTE: tactical motif weaknesses (motif, kind, count, errors per 100 moves)
WITH owner_moves AS (
  SELECT COUNT(m.id)::int AS total_moves
  FROM moves m
  JOIN games g ON m.game_id = g.id
  JOIN player_accounts pa ON g.player_account_id = pa.id
  WHERE pa.user_id = 2
    AND pa.id = 2
    AND g.analysis_status = 'analyzed'
    AND m.mover_color = g.color
)
SELECT mot.name AS motif,
       mm.kind,
       COUNT(mm.move_id)::int AS error_count,
       om.total_moves,
       ROUND(COUNT(mm.move_id)::numeric / NULLIF(om.total_moves, 0) * 100, 2) AS errors_per_100_moves
FROM player_accounts pa
JOIN games g ON g.player_account_id = pa.id
JOIN moves m ON m.game_id = g.id
JOIN move_motifs mm ON mm.move_id = m.id
JOIN motifs mot ON mm.motif_id = mot.id
CROSS JOIN owner_moves om
WHERE pa.user_id = 2
  AND pa.id = 2
  AND g.analysis_status = 'analyzed'
  AND m.mover_color = g.color
GROUP BY mot.name, mm.kind, om.total_moves
ORDER BY errors_per_100_moves DESC, error_count DESC, mot.name, mm.kind;

-- Q11. Window function: rolling average centipawn loss over the last 10 games
WITH per_game AS (
  SELECT g.id,
         g.played_at,
         ROUND(AVG(mc.cp_loss)::numeric, 1) AS game_avg_cp_loss
  FROM games g
  JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
  JOIN move_classifications mc ON mc.move_id = m.id
  WHERE g.player_account_id = 2
    AND g.analysis_status = 'analyzed'
  GROUP BY g.id, g.played_at
)
SELECT id AS game_id,
       played_at,
       game_avg_cp_loss,
       ROUND(AVG(game_avg_cp_loss) OVER (
               ORDER BY played_at, id
               ROWS BETWEEN 9 PRECEDING AND CURRENT ROW), 1) AS rolling_10_game_cp_loss,
       ROW_NUMBER() OVER (ORDER BY played_at, id) AS game_number
FROM per_game
ORDER BY played_at DESC, id DESC
LIMIT 10;

-- Q12. Job queue: claim the next job with FOR UPDATE SKIP LOCKED
BEGIN;
INSERT INTO analysis_jobs (player_account_id, status, max_games)
VALUES (2, 'queued', 10)
RETURNING id, status, attempts;

-- The claim statement of src/workers/jobQueue.js with $1 = 'worker-q12' and $2 = 120 seconds.
UPDATE analysis_jobs
SET status = 'running',
    locked_by = 'worker-q12',
    locked_at = (NOW() AT TIME ZONE 'UTC'),
    heartbeat_at = (NOW() AT TIME ZONE 'UTC'),
    attempts = attempts + 1
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE (status = 'queued' AND attempts < 3)
     OR (status = 'running' AND attempts < 3
         AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => 120))
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, player_account_id, status, locked_by, attempts;

-- A second claim finds nothing: the job is running with a fresh heartbeat.
UPDATE analysis_jobs
SET status = 'running',
    locked_by = 'worker-q12-b',
    locked_at = (NOW() AT TIME ZONE 'UTC'),
    heartbeat_at = (NOW() AT TIME ZONE 'UTC'),
    attempts = attempts + 1
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE (status = 'queued' AND attempts < 3)
     OR (status = 'running' AND attempts < 3
         AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => 120))
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, player_account_id, status, locked_by, attempts;
ROLLBACK;

-- Q13. Upsert of the summary tables and a check against the live aggregate
BEGIN;
INSERT INTO account_summary (player_account_id, total_games, analyzed_games, total_moves,
                             inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct,
                             last_game_at, refreshed_at)
SELECT 2,
       (SELECT COUNT(*)::int FROM games WHERE player_account_id = 2),
       COUNT(DISTINCT g.id)::int,
       COUNT(m.id)::int,
       COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int,
       COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int,
       COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0),
       COALESCE(ROUND((COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric
                       / NULLIF(COUNT(m.id), 0)::numeric) * 100, 1)::float, 0.0),
       MAX(g.played_at),
       (NOW() AT TIME ZONE 'UTC')
FROM games g
LEFT JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
LEFT JOIN move_classifications mc ON mc.move_id = m.id
LEFT JOIN classifications c ON c.id = mc.classification_id
WHERE g.player_account_id = 2
  AND g.analysis_status = 'analyzed'
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
  refreshed_at = (NOW() AT TIME ZONE 'UTC');

INSERT INTO account_phase_summary (player_account_id, phase_id, moves, blunders, avg_cp_loss)
SELECT 2,
       p.id,
       COUNT(m.id)::int,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int,
       COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0)
FROM phases p
LEFT JOIN (
  moves m
  JOIN games g ON m.game_id = g.id AND g.player_account_id = 2
              AND g.analysis_status = 'analyzed' AND m.mover_color = g.color
  LEFT JOIN move_classifications mc ON mc.move_id = m.id
  LEFT JOIN classifications c ON c.id = mc.classification_id
) ON m.phase_id = p.id
GROUP BY p.id
ON CONFLICT (player_account_id, phase_id) DO UPDATE SET
  moves = EXCLUDED.moves,
  blunders = EXCLUDED.blunders,
  avg_cp_loss = EXCLUDED.avg_cp_loss;

-- Stored summary next to the live aggregate (Q05); the EXCEPT returns no rows when they match.
SELECT 'stored' AS source, total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct
FROM account_summary WHERE player_account_id = 2
UNION ALL
SELECT 'live', COUNT(m.id)::int,
       COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int,
       COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int,
       ROUND(AVG(mc.cp_loss)::numeric, 1)::float,
       ROUND(COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric
             / NULLIF(COUNT(m.id), 0) * 100, 1)::float
FROM games g
JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
LEFT JOIN move_classifications mc ON mc.move_id = m.id
LEFT JOIN classifications c ON c.id = mc.classification_id
WHERE g.player_account_id = 2 AND g.analysis_status = 'analyzed';

SELECT aps.phase_id, aps.moves, aps.blunders, aps.avg_cp_loss
FROM account_phase_summary aps
WHERE aps.player_account_id = 2
EXCEPT
SELECT m.phase_id, COUNT(m.id)::int,
       COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int,
       ROUND(AVG(mc.cp_loss)::numeric, 1)::float
FROM games g
JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
LEFT JOIN move_classifications mc ON mc.move_id = m.id
LEFT JOIN classifications c ON c.id = mc.classification_id
WHERE g.player_account_id = 2 AND g.analysis_status = 'analyzed'
GROUP BY m.phase_id;
ROLLBACK;

-- Q14. Training plan: puzzles for the weakest motif inside the player's rating band
WITH weakest_motif AS (
  SELECT mot.id, mot.name, COUNT(mm.move_id) AS error_count
  FROM move_motifs mm
  JOIN motifs mot ON mm.motif_id = mot.id
  JOIN moves m ON mm.move_id = m.id
  JOIN games g ON m.game_id = g.id
  JOIN player_accounts pa ON g.player_account_id = pa.id
  WHERE pa.user_id = 2
    AND g.analysis_status = 'analyzed'
    AND m.mover_color = g.color
  GROUP BY mot.id, mot.name
  ORDER BY error_count DESC, mot.name
  LIMIT 1
),
rating AS (
  SELECT ROUND(AVG(player_rating))::int AS recent_rating
  FROM (
    SELECT g.player_rating
    FROM games g
    JOIN player_accounts pa ON pa.id = g.player_account_id
    WHERE pa.user_id = 2 AND g.analysis_status = 'analyzed' AND g.player_rating IS NOT NULL
    ORDER BY g.played_at DESC
    LIMIT 20
  ) last20
)
SELECT w.name AS motif, w.error_count, r.recent_rating,
       pz.id AS puzzle_id, pz.lichess_id, pz.rating
FROM weakest_motif w
CROSS JOIN rating r
JOIN puzzle_motifs pm ON pm.motif_id = w.id
JOIN puzzles pz ON pz.id = pm.puzzle_id
WHERE pz.rating BETWEEN r.recent_rating - 250 AND r.recent_rating + 250
ORDER BY pz.id
LIMIT 3;

-- Q15. UPDATE: mark a training plan item as completed (owner check through the plan)
BEGIN;
UPDATE training_plan_items tpi
SET completed_at = (NOW() AT TIME ZONE 'UTC')
FROM training_plans tp
WHERE tpi.plan_id = tp.id
  AND tp.user_id = 2
  AND tpi.id = (SELECT MIN(i.id) FROM training_plan_items i
                JOIN training_plans p ON p.id = i.plan_id WHERE p.user_id = 2)
RETURNING tpi.id, tpi.plan_id, tpi.reason_code, tpi.completed_at IS NOT NULL AS completed;
ROLLBACK;

-- Q16. Constraint demonstrations: unique, partial unique index and foreign key violations
-- (a) duplicate game: same (platform_id, external_id) as game 32
BEGIN;
INSERT INTO games (player_account_id, platform_id, external_id, played_at, color,
                   result_id, total_plies)
SELECT player_account_id, platform_id, external_id, played_at, color, result_id, total_plies
FROM games WHERE id = 32;
ROLLBACK;

-- (b) second active job for the same account
BEGIN;
INSERT INTO analysis_jobs (player_account_id, status) VALUES (2, 'queued');
INSERT INTO analysis_jobs (player_account_id, status) VALUES (2, 'queued');
ROLLBACK;

-- (c) move row for a game that does not exist
BEGIN;
INSERT INTO moves (game_id, ply, san, uci, fen_before, mover_color, phase_id)
VALUES (999999, 1, 'e4', 'e2e4',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'white', 1);
ROLLBACK;

-- Q17. CHECK constraints: values outside the allowed sets are rejected by the database
-- (a) a game colour that is neither white nor black
BEGIN;
UPDATE games SET color = 'red' WHERE id = 32;
ROLLBACK;

-- (b) an analysis job with an unknown status
BEGIN;
INSERT INTO analysis_jobs (player_account_id, status) VALUES (2, 'cancelled');
ROLLBACK;

-- (c) a negative centipawn loss
BEGIN;
UPDATE move_classifications SET cp_loss = -5
WHERE move_id = (SELECT MIN(m.id) FROM moves m WHERE m.game_id = 32);
ROLLBACK;

-- (d) the same kind of write with an allowed value is accepted
BEGIN;
UPDATE games SET color = 'black' WHERE id = 32 RETURNING id, color;
ROLLBACK;

-- All CHECK constraints in the schema
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'c' AND connamespace = 'public'::regnamespace
ORDER BY 1, 2;
