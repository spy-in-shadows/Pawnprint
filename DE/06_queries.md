# 6. Queries

`DE/queries.sql` holds 16 project-specific queries. This file explains each one and shows its real output.

## How the outputs were produced

- Database: the demo database (`chess_analytics` in the `pawnprint-demo` Compose project, PostgreSQL 16.15), see `DE/README.md`.
- Parameters are literals taken from that database: user id 2 and player account id 2, a Lichess account with 50 analysed games (2,367 own moves). This account was chosen over account 1 (30 games) because it has more data per group.
- Each block of `queries.sql` that starts with `-- Qnn.` was run as one psql session:

  ```
  docker compose -p pawnprint-demo exec -T db psql -U chess -d chess_analytics -f - < Qnn.sql
  ```

  Running the whole file at once (`-f - < DE/queries.sql`) gives the same results in one session.
- Every query that changes data (Q01, Q02, Q03, Q12, Q13, Q15, Q16) runs inside `BEGIN; ... ROLLBACK;` in the same session, so the demo data is left unchanged. The only lasting effect is that sequences advance (for example the ids 3, 82, 4 and 5 that appear in Q01, Q02 and Q12 are not reused), because PostgreSQL does not roll sequences back. Ids and timestamps in those outputs will differ on another run.
- psql prints the command tag (`BEGIN`, `INSERT 0 1`, `UPDATE 1`, `ROLLBACK`) after each statement and the row count `(n rows)` after each result.

Coverage of the required query types:

| Requirement | Queries |
|---|---|
| INSERT (with idempotent `ON CONFLICT DO NOTHING`) | Q01, Q12, Q16 |
| UPDATE | Q02, Q12, Q15 |
| DELETE with cascade | Q03 |
| SELECT with filtering and sorting, joins on lookup tables | Q04 |
| Aggregates | Q05, Q13 |
| GROUP BY with HAVING | Q06 |
| Joins across four or more tables | Q07 (6 tables), Q08 (6 tables), Q10 (5 tables) |
| CASE buckets | Q08 |
| Subquery | Q09, Q14 |
| CTE | Q06, Q08, Q10, Q11, Q14 |
| Window function | Q11 |
| `FOR UPDATE SKIP LOCKED` | Q12 |
| Upsert `ON CONFLICT DO UPDATE` and consistency check | Q13 |
| Constraint violations (unique, partial unique, foreign key) | Q16 |

## Queries

### Q01. INSERT: register a user, link a player account and import a game idempotently

**Business question.** Can a new user register, link a platform account and import a game, and does importing the same game again create a duplicate?

**Feature and code.** Register (`POST /api/v1/auth/register`), link account (`POST /api/v1/accounts`), import and upload. Equivalent code: `userRepo.create` in `src/repositories/user.repo.js:15` (Prisma), `linkAccount` in `src/services/account.service.js:34` (Prisma), and the game insert in `insertGameWithMoves`, `src/repositories/moveBulk.repo.js:151-168` (raw SQL with `ON CONFLICT (platform_id, external_id) DO NOTHING`).

```sql
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
```

**Explanation.**

1. `BEGIN` starts a transaction so that everything is undone by the final `ROLLBACK`.
2. The first `INSERT ... RETURNING` creates the user and returns the generated id and the default `created_at`.
3. The second `INSERT ... SELECT` links a Lichess account by looking up the new user and the `lichess` platform by name instead of hard-coding ids.
4. The third statement inserts a game. Lookup ids for the result, opening (ECO C20) and time control (180+2) come from scalar subqueries. `ON CONFLICT (platform_id, external_id) DO NOTHING` uses the unique index `games_platform_id_external_id_key`.
5. The fourth statement is identical. psql reports `INSERT 0 0` and `RETURNING` gives 0 rows: the conflict was detected and nothing was written.
6. The count confirms exactly one game with that external id, then `ROLLBACK` removes the user, the account and the game.

**Output** (psql, demo database):

```
BEGIN
 id |          email          |       created_at        
----+-------------------------+-------------------------
  3 | q01-student@example.com | 2026-11-22 15:23:56.554
(1 row)

INSERT 0 1
 id | user_id | platform_id |  username   
----+---------+-------------+-------------
  3 |       3 |           1 | q01_student
(1 row)

INSERT 0 1
 id | external_id 
----+-------------
 82 | q01-game-1
(1 row)

INSERT 0 1
 id | external_id 
----+-------------
(0 rows)

INSERT 0 0
 games_with_this_external_id 
-----------------------------
                           1
(1 row)

ROLLBACK
```

### Q02. UPDATE: move the sync cursor forward and mark an analysis job finished

**Business question.** After an import, how does the sync cursor move forward (and never backwards), and how is a job marked finished?

**Feature and code.** Platform import job completion in the worker. Cursor: `advanceCursor` in `src/workers/jobRunner.js:58-65`. Job: `markJobFinished` in `src/workers/jobQueue.js:128-140`. Both are raw SQL through the `pg` pool.

```sql
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
```

**Explanation.**

1. The first `SELECT` shows the current cursor of account 2.
2. `GREATEST(COALESCE(last_synced_at, t), t)` sets the cursor to the newer of the current value and the new timestamp `t`; `COALESCE` handles an account that was never synced.
3. Running it again with an older timestamp (2024-01-01) leaves the cursor at 2025-12-01, which is the 'never moves backwards' rule.
4. An `INSERT` creates a running job for the account (inside the transaction only).
5. The `UPDATE` is the `markJobFinished` statement: status `completed`, `finished_at` in UTC and the failed and skipped counters. `RETURNING` shows the new row.
6. `ROLLBACK` restores the cursor and removes the job.

**Output** (psql, demo database):

```
BEGIN
 id |   last_synced_at    
----+---------------------
  2 | 2025-10-11 19:38:53
(1 row)

 id |   last_synced_at    
----+---------------------
  2 | 2025-12-01 00:00:00
(1 row)

UPDATE 1
 id |   last_synced_at    
----+---------------------
  2 | 2025-12-01 00:00:00
(1 row)

UPDATE 1
 id | status  
----+---------
  4 | running
(1 row)

INSERT 0 1
 id |  status   | failed_games | skipped_games | has_finished_at 
----+-----------+--------------+---------------+-----------------
  4 | completed |            0 |             1 | t
(1 row)

UPDATE 1
ROLLBACK
```

### Q03. DELETE: unlink a player account and show the ON DELETE CASCADE chain

**Business question.** What happens to a player's games, moves, evaluations, jobs and summaries when the account is unlinked?

**Feature and code.** Unlink account (`DELETE /api/v1/accounts/:id`). Equivalent code: `deleteAccount` in `src/services/account.service.js:87-104`, which calls `prisma.playerAccount.delete`; the cascade is done by the database.

```sql
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
```

**Explanation.**

1. The first `SELECT` counts rows owned by account 2 with scalar subqueries; `all_move_evals` counts the whole table because evaluations reach the account only through moves and games.
2. `DELETE FROM player_accounts WHERE id = 2` deletes one row. The foreign keys `games_player_account_id_fkey`, `moves_game_id_fkey`, `move_evals_move_id_fkey` (and the ones of `move_classifications`, `move_mates`, `move_motifs`, `analysis_jobs`, `analysis_job_games`, `account_summary`, `account_phase_summary`) are all `ON DELETE CASCADE`.
3. The second `SELECT` shows 0 games, 0 moves, 0 jobs and 0 summaries left, and `move_evals` dropped from 7,107 to 2,378 (7,107 minus the 4,729 moves of the account's 50 games).
4. `ROLLBACK` undoes the delete; the last query, outside the transaction, shows the 50 games are back.

**Output** (psql, demo database):

```
BEGIN
 accounts | games | moves | all_move_evals | jobs | summaries 
----------+-------+-------+----------------+------+-----------
        1 |    50 |  4729 |           7107 |    1 |         1
(1 row)

DELETE 1
 accounts | games | moves | all_move_evals | jobs | summaries 
----------+-------+-------+----------------+------+-----------
        0 |     0 |     0 |           2378 |    0 |         0
(1 row)

ROLLBACK
 games_after_rollback 
----------------------
                   50
(1 row)
```

### Q04. SELECT with filtering and sorting: latest games of an account with lookups

**Business question.** What are the latest games of an account, with result, opening and time control?

**Feature and code.** Games list (`GET /api/v1/games?accountId=&from=`). Equivalent code: `list` in `src/repositories/game.repo.js:5-127` (Prisma `findMany` with `orderBy: { playedAt: 'desc' }` and `include` of `result`, `opening`, `timeControl`).

```sql
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
```

**Explanation.**

1. `FROM games g` with an inner join to `results` (every game has a result) and left joins to `openings` and `time_controls` (both foreign keys are nullable).
2. `tc.base_seconds || '+' || tc.increment_seconds` formats the clock the way chess sites show it.
3. `WHERE g.player_account_id = 2 AND g.played_at >= '2025-10-01'` filters by account and date, like the `accountId` and `from` query parameters.
4. `ORDER BY g.played_at DESC LIMIT 10` returns the newest page first. Both the filter and the order are served by the index `games_player_account_id_played_at_idx` (plan E1 below).

**Output** (psql, demo database):

```
 id |      played_at      | color | result | eco |                     opening                      | time_control | category | player_rating | opponent_rating 
----+---------------------+-------+--------+-----+--------------------------------------------------+--------------+----------+---------------+-----------------
 32 | 2025-10-11 19:38:53 | black | loss   | C57 | Italian Game: Two Knights Defense, Knight Attack | 180+0        | blitz    |          2842 |            2779
 33 | 2025-10-11 19:36:06 | white | win    | B30 | Sicilian Defense: Old Sicilian                   | 180+0        | blitz    |          2838 |            2692
 34 | 2025-10-11 19:32:47 | black | loss   | E60 | King's Indian Defense                            | 180+0        | blitz    |          2849 |            2657
 35 | 2025-10-11 19:30:30 | black | win    | A05 | Zukertort Opening                                | 180+0        | blitz    |          2841 |            2862
 36 | 2025-10-11 19:26:18 | white | win    | B22 | Sicilian Defense: Alapin Variation               | 180+0        | blitz    |          2836 |            2716
 37 | 2025-10-11 19:22:10 | white | draw   | A40 | Queen's Pawn                                     | 180+0        | blitz    |          2835 |            2867
 38 | 2025-10-11 19:19:53 | black | loss   | C10 | French Defense: Paulsen Variation                | 180+0        | blitz    |          2845 |            2792
 39 | 2025-10-11 19:17:34 | white | draw   | B23 | Sicilian Defense: Closed                         | 180+0        | blitz    |          2848 |            2690
 40 | 2025-10-11 19:13:51 | white | win    | C02 | French Defense: Advance Variation                | 180+0        | blitz    |          2843 |            2662
 41 | 2025-10-11 19:10:44 | black | win    | A49 | Indian Defense: Przepiorka Variation             | 180+0        | blitz    |          2837 |            2746
(10 rows)
```

### Q05. Aggregates: moves, blunders, average centipawn loss and accuracy of an account

**Business question.** Overall, how many moves has the player made, how many were errors, what is the average centipawn loss and the accuracy?

**Feature and code.** Dashboard summary tiles. This is the aggregate that `refreshAccountSummary` computes (`src/services/summary.service.js:23-45`) before it stores the result in `account_summary`.

```sql
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
```

**Explanation.**

1. `FROM games g` restricted to account 2 and `analysis_status = 'analyzed'`.
2. `LEFT JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color` keeps only the owner's moves (not the opponent's).
3. The joins to `move_classifications` and `classifications` give each move its class and `cp_loss`.
4. `COUNT(DISTINCT g.id)` counts games; `COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)` counts only blunders (the same for inaccuracies and mistakes).
5. `AVG(mc.cp_loss)` is the average centipawn loss; accuracy is the share of `best` and `good` moves in percent, with `NULLIF` avoiding division by zero.

**Output** (psql, demo database):

```
 analyzed_games | total_moves | inaccuracies | mistakes | blunders | avg_cp_loss | accuracy_pct 
----------------+-------------+--------------+----------+----------+-------------+--------------
             50 |        2367 |          190 |      119 |       54 |        40.6 |         84.7
(1 row)
```

### Q06. GROUP BY with HAVING: ECO opening groups with at least 5 games, win rate and loss, worst first

**Business question.** In which opening groups does the player lose the most, among groups with at least 5 games?

**Feature and code.** Opening analysis (the openings chart of the dashboard groups by ECO code and ply bucket, `OPENINGS_SQL` in `src/repositories/analytics.repo.js:3-37`). This query groups by ECO group instead (the first letter, A to E), because no single ECO code has 5 or more games in the demo data (the most frequent, A05, has 4).

```sql
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
```

**Explanation.**

1. The CTE `game_stats` produces one row per game: its ECO group `LEFT(o.eco, 1)`, its result code and the average `cp_loss` of the owner's moves in that game.
2. The inner `GROUP BY g.id, LEFT(o.eco, 1), r.code` collapses the moves of a game into that one row.
3. The outer query groups games by ECO group, counts games and wins (`COUNT(*) FILTER (WHERE result = 'win')`) and computes the win rate.
4. `HAVING COUNT(*) >= 5` removes groups with fewer than 5 games (D with 3 and E with 4 games are removed).
5. `ORDER BY avg_cp_loss DESC` lists the weakest group first.

**Output** (psql, demo database):

```
 eco_group | games | wins | win_rate_pct | avg_cp_loss 
-----------+-------+------+--------------+-------------
 C         |     6 |    2 |         33.3 |        46.8
 A         |    13 |    7 |         53.8 |        45.0
 B         |    24 |   16 |         66.7 |        33.0
(3 rows)
```

### Q07. JOIN across five tables: blunders and accuracy by game phase

**Business question.** In which phase of the game (opening, middlegame, endgame) does the player blunder most?

**Feature and code.** Phase accuracy chart (`GET /api/v1/analytics/phases`). Same SQL as `PHASES_SQL` in `src/repositories/analytics.repo.js:39-68`, with `$1 = 2` (user) and `$2 = 2` (account) and no date filter.

```sql
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
```

**Explanation.**

1. Joins six tables: `moves`, `games`, `player_accounts` (for the user filter), `phases`, and left joins to `move_classifications` and `classifications`.
2. `WHERE pa.user_id = 2 AND pa.id = 2` scopes to the logged-in user and the selected account; every API query is scoped by `user_id` so a user can never read another user's data.
3. `m.mover_color = g.color` keeps the owner's moves; `analysis_status = 'analyzed'` keeps finished games.
4. `GROUP BY p.name, p.id` gives one row per phase; the `CASE` counts give blunders and mistakes per phase; `ORDER BY p.id` keeps the natural phase order.

**Output** (psql, demo database):

```
   phase    | moves | avg_cp_loss | accuracy_pct | blunders | mistakes 
------------+-------+-------------+--------------+----------+----------
 opening    |   495 |        15.5 |         93.7 |        2 |        2
 middlegame |  1077 |        49.6 |         79.1 |       31 |       89
 endgame    |   795 |        43.9 |         86.5 |       21 |       28
(3 rows)
```

### Q08. JOIN with CASE buckets: time pressure (share of base clock left) against blunder rate

**Business question.** Does the player make more mistakes when short of time?

**Feature and code.** Time-pressure chart (`GET /api/v1/analytics/time-pressure`). Same structure as `TIME_PRESSURE_BUCKETS_SQL` in `src/repositories/analytics.repo.js:85-134`; this version adds a mistake-rate column.

```sql
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
```

**Explanation.**

1. The CTE `bucketed_moves` joins `moves`, `games`, `player_accounts`, `time_controls`, `move_classifications` and `classifications`.
2. The `CASE` puts each move into a bucket by the share of the base clock left: `clock_remaining_ms / (base_seconds * 1000)`.
3. Moves without a clock or with a base time of 0 are excluded in the `WHERE` clause (the API reports their number as `excludedMoves`).
4. The outer query counts moves, blunders and mistakes plus blunders per bucket, and the rate in percent.
5. `ORDER BY CASE bucket ...` returns the buckets from most time left to least.

**Output** (psql, demo database):

```
 bucket | moves | blunders | mistakes_and_blunders | mistake_rate_pct | avg_cp_loss 
--------+-------+----------+-----------------------+------------------+-------------
 >50%   |   616 |       13 |                    48 |             7.79 |        34.6
 25-50% |  1217 |       22 |                    86 |             7.07 |        39.8
 10-25% |   449 |       15 |                    33 |             7.35 |        47.1
 <10%   |    85 |        4 |                     6 |             7.06 |        59.6
(4 rows)
```

### Q09. Subquery: the account's moves whose loss is far above the account's own average

**Business question.** Which of the player's moves lost far more than the player's own average loss?

**Feature and code.** Game review: finding the moves worth reviewing. No endpoint runs this exact query; the game detail endpoint (`getDetail`, `src/repositories/game.repo.js:129-239`) returns `cpLoss` per move and the client highlights errors.

```sql
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
```

**Explanation.**

1. The scalar subquery in the `WHERE` clause computes the account's average `cp_loss` over the owner's moves (one value, about 40.6 for account 2).
2. The outer query keeps moves whose `cp_loss` is more than 5 times that average, and joins `phases` and `classifications` for readable names.
3. `ORDER BY mc.cp_loss DESC LIMIT 10` shows the ten worst moves; the second query counts all of them (114).
4. Two of the ten are `mistake`, not `blunder`: classification is based on the drop in win probability, so a large centipawn loss in an already lost position is not always a blunder.

**Output** (psql, demo database):

```
 game_id | ply | san  |   phase    | classification | cp_loss 
---------+-----+------+------------+----------------+---------
      53 |  68 | Qg6  | endgame    | blunder        |     878
      41 |  80 | Rxg2 | middlegame | blunder        |     755
      59 |  74 | Qc4  | middlegame | blunder        |     705
      55 |  88 | e5   | endgame    | blunder        |     656
      75 |  74 | Qa1+ | middlegame | blunder        |     646
      54 | 145 | Qd8  | endgame    | blunder        |     635
      32 |  26 | Bd6  | middlegame | blunder        |     633
      76 |  69 | Rc7  | endgame    | blunder        |     618
      67 |  66 | Rxc5 | middlegame | mistake        |     617
      34 | 132 | Ke6  | endgame    | mistake        |     591
(10 rows)

 moves_above_5x_average 
------------------------
                    114
(1 row)
```

### Q10. CTE: tactical motif weaknesses (motif, kind, count, errors per 100 moves)

**Business question.** Which tactical motifs does the player allow or miss most often, per 100 moves played?

**Feature and code.** Motif weakness chart (`GET /api/v1/analytics/motifs`) and the motif part of the training plan. Same SQL as `MOTIFS_SQL` in `src/repositories/analytics.repo.js:179-215`.

```sql
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
```

**Explanation.**

1. The CTE `owner_moves` counts all the owner's moves in analysed games (2,367 for account 2).
2. The main query joins `player_accounts`, `games`, `moves`, `move_motifs` and `motifs`, keeping the owner's moves.
3. `CROSS JOIN owner_moves` attaches the total to every row so it can be used as the denominator.
4. `GROUP BY mot.name, mm.kind` gives one row per motif and kind (`allowed` or `missed`); the rate is errors per 100 moves played.
5. The `ORDER BY` puts the largest rate first.

**Output** (psql, demo database):

```
       motif       |  kind   | error_count | total_moves | errors_per_100_moves 
-------------------+---------+-------------+-------------+----------------------
 hanging_piece     | allowed |          34 |        2367 |                 1.44
 pin               | allowed |          31 |        2367 |                 1.31
 pin               | missed  |          17 |        2367 |                 0.72
 hanging_piece     | missed  |          10 |        2367 |                 0.42
 discovered_attack | allowed |           4 |        2367 |                 0.17
 fork              | allowed |           4 |        2367 |                 0.17
 skewer            | allowed |           4 |        2367 |                 0.17
 skewer            | missed  |           3 |        2367 |                 0.13
 fork              | missed  |           1 |        2367 |                 0.04
(9 rows)
```

### Q11. Window function: rolling average centipawn loss over the last 10 games

**Business question.** Is the player improving? What is the rolling average centipawn loss over the last 10 games?

**Feature and code.** Trend chart (`GET /api/v1/analytics/trend`). The endpoint uses a 7-day rolling window over days (`TREND_SQL`, `src/repositories/analytics.repo.js:136-176`, `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW`); this query uses a 10-game window over games.

```sql
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
```

**Explanation.**

1. The CTE `per_game` gives one row per analysed game with the average `cp_loss` of the owner's moves.
2. `AVG(game_avg_cp_loss) OVER (ORDER BY played_at, id ROWS BETWEEN 9 PRECEDING AND CURRENT ROW)` averages each game with the 9 games before it; `id` breaks ties between games with the same timestamp.
3. `ROW_NUMBER() OVER (ORDER BY played_at, id)` numbers the games from the first (1) to the latest (50).
4. The final `ORDER BY played_at DESC LIMIT 10` shows the latest ten games; the window is computed before the `LIMIT`, so the first rows still use their full 10-game history.

**Output** (psql, demo database):

```
 game_id |      played_at      | game_avg_cp_loss | rolling_10_game_cp_loss | game_number 
---------+---------------------+------------------+-------------------------+-------------
      32 | 2025-10-11 19:38:53 |             57.8 |                    34.6 |          50
      33 | 2025-10-11 19:36:06 |             26.0 |                    31.5 |          49
      34 | 2025-10-11 19:32:47 |             44.4 |                    33.2 |          48
      35 | 2025-10-11 19:30:30 |             31.3 |                    33.9 |          47
      36 | 2025-10-11 19:26:18 |             34.8 |                    33.3 |          46
      37 | 2025-10-11 19:22:10 |             19.1 |                    35.1 |          45
      38 | 2025-10-11 19:19:53 |             39.0 |                    34.6 |          44
      39 | 2025-10-11 19:17:34 |             17.2 |                    36.4 |          43
      40 | 2025-10-11 19:13:51 |             22.2 |                    39.1 |          42
      41 | 2025-10-11 19:10:44 |             54.6 |                    40.2 |          41
(10 rows)
```

### Q12. Job queue: claim the next job with FOR UPDATE SKIP LOCKED

**Business question.** How does a worker take the next job without two workers taking the same one?

**Feature and code.** Analysis worker (`npm run worker`). The claim statement is `CLAIM_SQL` in `src/workers/jobQueue.js:60-76`, run by `claimNextJob` with `$1` = worker id and `$2` = `JOB_STALE_SECONDS` (120).

```sql
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
```

**Explanation.**

1. The `INSERT` queues a job for account 2 (inside the transaction only).
2. The sub-select finds the oldest job that is `queued`, or `running` with a heartbeat older than 120 seconds (a dead worker), and fewer than 3 attempts.
3. `FOR UPDATE SKIP LOCKED` locks the chosen row; a second worker running the same statement at the same time skips the locked row instead of waiting, so the two can never pick the same job.
4. The outer `UPDATE` marks the row `running`, records the worker and the lock and heartbeat time, and increments `attempts`, all in one statement.
5. The second claim returns 0 rows: the only job is now running with a fresh heartbeat. `ROLLBACK` removes the job.

**Output** (psql, demo database):

```
BEGIN
 id | status | attempts 
----+--------+----------
  5 | queued |        0
(1 row)

INSERT 0 1
 id | player_account_id | status  | locked_by  | attempts 
----+-------------------+---------+------------+----------
  5 |                 2 | running | worker-q12 |        1
(1 row)

UPDATE 1
 id | player_account_id | status | locked_by | attempts 
----+-------------------+--------+-----------+----------
(0 rows)

UPDATE 0
ROLLBACK
```

### Q13. Upsert of the summary tables and a check against the live aggregate

**Business question.** Is the precomputed summary equal to the live aggregate?

**Feature and code.** Summary endpoint (`GET /api/v1/analytics/summary`) and the refresh after each job. The upserts are the ones in `refreshAccountSummary`, `src/services/summary.service.js:49-91` and `112-132`, written here as `INSERT ... SELECT` statements with the account id as a literal.

```sql
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
```

**Explanation.**

1. The first `INSERT ... SELECT ... ON CONFLICT (player_account_id) DO UPDATE` recomputes the account totals and overwrites the existing row (`INSERT 0 1` means one row inserted or updated).
2. The second upsert computes one row per phase with a `LEFT JOIN` from `phases`, so a phase without moves still gets a row, and overwrites the three existing rows (`INSERT 0 3`).
3. The `UNION ALL` query shows the stored row next to the live aggregate of Q05: the values are identical.
4. The last query uses `EXCEPT` to list phase-summary rows that differ from the live per-phase aggregate; it returns 0 rows.
5. `ROLLBACK` restores the original summary rows (including `refreshed_at`).

**Output** (psql, demo database):

```
BEGIN
INSERT 0 1
INSERT 0 3
 source | total_moves | inaccuracies | mistakes | blunders | avg_cp_loss | accuracy_pct 
--------+-------------+--------------+----------+----------+-------------+--------------
 stored |        2367 |          190 |      119 |       54 |        40.6 |         84.7
 live   |        2367 |          190 |      119 |       54 |        40.6 |         84.7
(2 rows)

 phase_id | moves | blunders | avg_cp_loss 
----------+-------+----------+-------------
(0 rows)

ROLLBACK
```

### Q14. Training plan: puzzles for the weakest motif inside the player's rating band

**Business question.** Which puzzles should the player train first?

**Feature and code.** Training plan generation (`POST /api/v1/training/plans`). `generatePlan` in `src/services/training.service.js:51-130` calls `getWeakestMotifs` (`WEAKEST_MOTIFS_SQL`, `src/repositories/analytics.repo.js:241-256`), `getUserRecentRating` (`src/repositories/training.repo.js:46-64`) and `findPuzzlesForMotif` (`src/repositories/training.repo.js:66-93`). This query combines the three steps for the weakest motif.

```sql
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
```

**Explanation.**

1. CTE `weakest_motif`: the motif with the most tags on the user's own moves in analysed games (`pin`, 48 = 31 allowed + 17 missed from Q10).
2. CTE `rating`: the average `player_rating` of the user's last 20 analysed games (2,987).
3. The main query joins the motif to `puzzle_motifs` and `puzzles` and keeps puzzles rated within 250 points of that rating.
4. `ORDER BY pz.id LIMIT 3` returns three puzzles, the same rule as `findPuzzlesForMotif` (`take: 3`, `orderBy: { id: 'asc' }`). The application also skips puzzles the user has already completed.

**Output** (psql, demo database):

```
 motif | error_count | recent_rating | puzzle_id | lichess_id | rating 
-------+-------------+---------------+-----------+------------+--------
 pin   |          48 |          2987 |      1081 | 00eYd      |   2747
 pin   |          48 |          2987 |      5398 | 03MPe      |   2877
 pin   |          48 |          2987 |      5616 | 03TjG      |   2781
(3 rows)
```

### Q15. UPDATE: mark a training plan item as completed (owner check through the plan)

**Business question.** How is a training item marked as done, and only by its owner?

**Feature and code.** Training item update (`PATCH /api/v1/training/plans/:planId/items/:itemId`). Equivalent code: `setItemCompletion` in `src/services/training.service.js:132-158` (ownership check with `findPlanById`) and `updateItemCompletion` in `src/repositories/training.repo.js:138-148` (Prisma `updateMany`).

```sql
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
```

**Explanation.**

1. `UPDATE training_plan_items ... FROM training_plans` joins the item to its plan so the `WHERE` clause can check `tp.user_id = 2`; an item of another user would match 0 rows.
2. The subquery picks the user's first item (id 11) so the example does not depend on a hard-coded id.
3. `SET completed_at = (NOW() AT TIME ZONE 'UTC')` stores the completion time in UTC; `RETURNING` shows the item is now completed.
4. `ROLLBACK` leaves the item unchanged.

**Output** (psql, demo database):

```
BEGIN
 id | plan_id |    reason_code     | completed 
----+---------+--------------------+-----------
 11 |       2 | MOTIF_WEAKNESS:pin | t
(1 row)

UPDATE 1
ROLLBACK
```

### Q16. Constraint demonstrations: unique, partial unique index and foreign key violations

**Business question.** Does the database itself reject duplicate games, a second active job and orphan moves?

**Feature and code.** Integrity rules that the import service and the worker rely on: idempotent imports, one active job per account (`createImportJob` in `src/services/import.service.js:29-88` catches this error and returns the existing job), and moves always belonging to a game.

```sql
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
```

**Explanation.**

1. (a) Inserting a copy of game 32 fails on `games_platform_id_external_id_key`: the pair (platform 1, external id `MD031pzB`) already exists. The application avoids this error with `ON CONFLICT DO NOTHING` (Q01).
2. (b) The first queued job for account 2 is accepted (`INSERT 0 1`) because the account's other jobs are all `completed`. The second fails on the partial unique index `idx_analysis_jobs_active_unique`.
3. (c) A move for game 999999 fails on the foreign key `moves_game_id_fkey`.
4. Each case runs in its own `BEGIN ... ROLLBACK`, because after an error PostgreSQL rejects further statements in the same transaction.

**Output** (psql, demo database):

```
BEGIN
psql:<stdin>:7: ERROR:  duplicate key value violates unique constraint "games_platform_id_external_id_key"
DETAIL:  Key (platform_id, external_id)=(1, MD031pzB) already exists.
ROLLBACK
BEGIN
INSERT 0 1
psql:<stdin>:13: ERROR:  duplicate key value violates unique constraint "idx_analysis_jobs_active_unique"
DETAIL:  Key (player_account_id)=(2) already exists.
ROLLBACK
BEGIN
psql:<stdin>:20: ERROR:  insert or update on table "moves" violates foreign key constraint "moves_game_id_fkey"
DETAIL:  Key (game_id)=(999999) is not present in table "games".
ROLLBACK
```

## Execution plans

Two analytic reads were run with `EXPLAIN (ANALYZE, BUFFERS)` on the demo database.

### E1. Latest games of an account (Q04)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT g.id, g.played_at, g.color, r.code AS result, o.eco, o.name AS opening,
       tc.base_seconds || '+' || tc.increment_seconds AS time_control, tc.category,
       g.player_rating, g.opponent_rating
FROM games g
JOIN results r ON r.id = g.result_id
LEFT JOIN openings o ON o.id = g.opening_id
LEFT JOIN time_controls tc ON tc.id = g.time_control_id
WHERE g.player_account_id = 2
  AND g.played_at >= TIMESTAMP '2025-10-01'
ORDER BY g.played_at DESC
LIMIT 10;
```

```
                                                                                     QUERY PLAN                                                                                     
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.73..24.68 rows=10 width=143) (actual time=0.048..0.067 rows=10 loops=1)
   Buffers: shared hit=43
   ->  Nested Loop Left Join  (cost=0.73..65.40 rows=27 width=143) (actual time=0.047..0.066 rows=10 loops=1)
         Buffers: shared hit=43
         ->  Nested Loop Left Join  (cost=0.59..62.66 rows=27 width=109) (actual time=0.040..0.056 rows=10 loops=1)
               Buffers: shared hit=41
               ->  Nested Loop  (cost=0.31..19.28 rows=27 width=66) (actual time=0.034..0.041 rows=10 loops=1)
                     Buffers: shared hit=11
                     ->  Index Scan Backward using games_player_account_id_played_at_idx on games g  (cost=0.14..11.03 rows=27 width=38) (actual time=0.018..0.020 rows=10 loops=1)
                           Index Cond: ((player_account_id = 2) AND (played_at >= '2025-10-01 00:00:00'::timestamp without time zone))
                           Buffers: shared hit=5
                     ->  Memoize  (cost=0.16..1.96 rows=1 width=36) (actual time=0.002..0.002 rows=1 loops=10)
                           Cache Key: g.result_id
                           Cache Mode: logical
                           Hits: 7  Misses: 3  Evictions: 0  Overflows: 0  Memory Usage: 1kB
                           Buffers: shared hit=6
                           ->  Index Scan using results_pkey on results r  (cost=0.15..1.95 rows=1 width=36) (actual time=0.004..0.004 rows=1 loops=3)
                                 Index Cond: (id = g.result_id)
                                 Buffers: shared hit=6
               ->  Memoize  (cost=0.28..1.78 rows=1 width=51) (actual time=0.001..0.001 rows=1 loops=10)
                     Cache Key: g.opening_id
                     Cache Mode: logical
                     Hits: 0  Misses: 10  Evictions: 0  Overflows: 0  Memory Usage: 2kB
                     Buffers: shared hit=30
                     ->  Index Scan using openings_pkey on openings o  (cost=0.27..1.77 rows=1 width=51) (actual time=0.001..0.001 rows=1 loops=10)
                           Index Cond: (id = g.opening_id)
                           Buffers: shared hit=30
         ->  Memoize  (cost=0.15..0.61 rows=1 width=18) (actual time=0.000..0.000 rows=1 loops=10)
               Cache Key: g.time_control_id
               Cache Mode: logical
               Hits: 9  Misses: 1  Evictions: 0  Overflows: 0  Memory Usage: 1kB
               Buffers: shared hit=2
               ->  Index Scan using time_controls_pkey on time_controls tc  (cost=0.14..0.60 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=1)
                     Index Cond: (id = g.time_control_id)
                     Buffers: shared hit=2
 Planning:
   Buffers: shared hit=435
 Planning Time: 0.766 ms
 Execution Time: 0.118 ms
(39 rows)
```

The plan reads `games` through `Index Scan Backward using games_player_account_id_played_at_idx`: the index on `(player_account_id, played_at)` gives both the filter (`Index Cond`) and the `ORDER BY played_at DESC` order, so there is no sort node and the `LIMIT` stops after 10 index entries (5 shared buffers for `games`, 0.118 ms total). The lookups are primary-key index scans. This index was part of the first migration; the analytics plans in [`docs/explain/`](../docs/explain/README.md) document the two later indexes.

### E2. Summary read compared with the live aggregate (Q05)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct
FROM account_summary
WHERE player_account_id = 2;

EXPLAIN (ANALYZE, BUFFERS)
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
```

```
                                                              QUERY PLAN                                                               
---------------------------------------------------------------------------------------------------------------------------------------
 Index Scan using account_summary_pkey on account_summary  (cost=0.15..8.17 rows=1 width=32) (actual time=0.022..0.022 rows=1 loops=1)
   Index Cond: (player_account_id = 2)
   Buffers: shared hit=2
 Planning:
   Buffers: shared hit=85
 Planning Time: 0.141 ms
 Execution Time: 0.037 ms
(7 rows)

                                                                           QUERY PLAN                                                                            
-----------------------------------------------------------------------------------------------------------------------------------------------------------------
 Aggregate  (cost=510.41..510.45 rows=1 width=84) (actual time=2.852..2.853 rows=1 loops=1)
   Buffers: shared hit=166
   ->  Sort  (cost=475.75..478.64 rows=1155 width=44) (actual time=2.534..2.621 rows=2367 loops=1)
         Sort Key: g.id
         Sort Method: quicksort  Memory: 207kB
         Buffers: shared hit=166
         ->  Nested Loop Left Join  (cost=239.11..417.00 rows=1155 width=44) (actual time=1.460..2.348 rows=2367 loops=1)
               Buffers: shared hit=163
               ->  Hash Right Join  (cost=238.95..387.09 rows=1155 width=16) (actual time=1.447..1.977 rows=2367 loops=1)
                     Hash Cond: (mc.move_id = m.id)
                     Buffers: shared hit=153
                     ->  Seq Scan on move_classifications mc  (cost=0.00..109.98 rows=7098 width=12) (actual time=0.004..0.281 rows=7107 loops=1)
                           Buffers: shared hit=39
                     ->  Hash  (cost=224.51..224.51 rows=1155 width=8) (actual time=1.256..1.257 rows=2367 loops=1)
                           Buckets: 4096 (originally 2048)  Batches: 1 (originally 1)  Memory Usage: 125kB
                           Buffers: shared hit=114
                           ->  Hash Right Join  (cost=3.59..224.51 rows=1155 width=8) (actual time=0.342..1.113 rows=2367 loops=1)
                                 Hash Cond: ((m.game_id = g.id) AND (m.mover_color = g.color))
                                 Buffers: shared hit=114
                                 ->  Seq Scan on moves m  (cost=0.00..183.07 rows=7107 width=14) (actual time=0.020..0.467 rows=7107 loops=1)
                                       Buffers: shared hit=112
                                 ->  Hash  (cost=3.20..3.20 rows=26 width=10) (actual time=0.015..0.015 rows=50 loops=1)
                                       Buckets: 1024  Batches: 1  Memory Usage: 11kB
                                       Buffers: shared hit=2
                                       ->  Seq Scan on games g  (cost=0.00..3.20 rows=26 width=10) (actual time=0.004..0.009 rows=50 loops=1)
                                             Filter: ((player_account_id = 2) AND (analysis_status = 'analyzed'::text))
                                             Rows Removed by Filter: 30
                                             Buffers: shared hit=2
               ->  Memoize  (cost=0.16..0.19 rows=1 width=36) (actual time=0.000..0.000 rows=1 loops=2367)
                     Cache Key: mc.classification_id
                     Cache Mode: logical
                     Hits: 2362  Misses: 5  Evictions: 0  Overflows: 0  Memory Usage: 1kB
                     Buffers: shared hit=10
                     ->  Index Scan using classifications_pkey on classifications c  (cost=0.15..0.18 rows=1 width=36) (actual time=0.002..0.002 rows=1 loops=5)
                           Index Cond: (id = mc.classification_id)
                           Buffers: shared hit=10
 Planning:
   Buffers: shared hit=364
 Planning Time: 0.488 ms
 Execution Time: 2.897 ms
(40 rows)
```

The summary read is one primary-key lookup on `account_summary_pkey` (2 buffers, 0.037 ms). The live aggregate scans `moves` and `move_classifications` in full (7,107 rows each) and takes 2.897 ms on the 80-game demo database, about 78 times longer. The gap grows with the data: at 10,000 games [`docs/benchmarks/queries.md`](../docs/benchmarks/queries.md) measured 0.29 ms against 242.35 ms. The speed-up here comes from the summary table, not from an index; the sequential scans match what [`docs/explain/README.md`](../docs/explain/README.md) reports for the analytics queries at 10,000 games, where the planner also preferred sequential scans.

## Check that the demo data is unchanged

After all queries had run, the row counts of all tables were compared with the counts taken at the start (`05_sample_records.md`) with `diff`, which printed nothing:

```
      table_name       | rows  
-----------------------+-------
 account_phase_summary |     6
 account_summary       |     2
 analysis_job_games    |    80
 analysis_jobs         |     3
 classifications       |     5
 engine_versions       |     1
 games                 |    80
 motifs                |     7
 move_classifications  |  7107
 move_evals            |  7107
 move_mates            |   127
 move_motifs           |   311
 moves                 |  7107
 openings              |   500
 phases                |     3
 platforms             |     3
 player_accounts       |     2
 _prisma_migrations    |     6
 puzzle_motifs         | 16600
 puzzles               | 50000
 results               |     3
 time_controls         |    11
 training_plan_items   |    25
 training_plans        |     2
 users                 |     2
(25 rows)
```
