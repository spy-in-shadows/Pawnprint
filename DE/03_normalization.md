# 3. Normalization (UNF to 3NF/BCNF)

This file derives the implemented schema from a single flat record, step by step, and then checks every implemented table against its functional dependencies. Table and column names in `code` are the names in the live database (`DE/schema.sql`); intermediate relations of the exercise are written in CAPITALS.

## 3.0 Starting point of the exercise

The starting point is the record a naive importer would write: one flat row per move, exactly as it comes out of a PGN file plus the engine, with the motif tags of the move as a repeating group.

```
FLAT_MOVE(
  user_email, password_hash,
  platform_name, platform_username,
  external_game_id, date_played, colour, result,
  opening_eco, opening_name,
  tc_base_seconds, tc_increment_seconds, tc_category,
  player_rating, opponent_rating, total_plies,
  ply, san, uci, fen_before, mover_colour, clock_remaining_ms, time_spent_ms, phase_name,
  engine_name, engine_version, engine_default_depth, engine_threads, engine_hash_size,
  depth, eval_before_cp, eval_after_cp, best_uci, mate_before, mate_after,
  classification_name, cp_loss,
  { motif_name, motif_kind }*          -- repeating group: zero or more tags per move
)
```

To make the example concrete, the following query rebuilds these flat rows from the implemented schema for four real moves of demo game 20 (the query is the inverse of the decomposition below: it joins 16 tables back together, 14 in the FROM clause and 2 in the subquery). Some columns are left out to keep the output readable.

```sql
SELECT u.email AS user_email, p.name AS platform_name, pa.username AS platform_username,
       g.external_id, g.played_at::date AS date_played, g.color, r.code AS result,
       o.eco AS opening_eco, o.name AS opening_name,
       tc.base_seconds AS tc_base, tc.increment_seconds AS tc_inc, tc.category AS tc_category,
       m.ply, m.san, m.uci, m.mover_color, m.clock_remaining_ms, ph.name AS phase_name,
       ev.name AS engine_name, ev.version AS engine_version, ev.threads, ev.hash_size,
       e.depth, e.eval_before_cp, e.eval_after_cp, e.best_uci,
       mm.mate_before, mm.mate_after, c.name AS classification_name, mc.cp_loss,
       (SELECT string_agg(mo.name || ':' || x.kind, ', ' ORDER BY mo.name)
          FROM move_motifs x JOIN motifs mo ON mo.id = x.motif_id WHERE x.move_id = m.id) AS motifs
FROM moves m
JOIN games g ON g.id = m.game_id
JOIN player_accounts pa ON pa.id = g.player_account_id
JOIN users u ON u.id = pa.user_id
JOIN platforms p ON p.id = g.platform_id
JOIN results r ON r.id = g.result_id
LEFT JOIN openings o ON o.id = g.opening_id
LEFT JOIN time_controls tc ON tc.id = g.time_control_id
JOIN phases ph ON ph.id = m.phase_id
JOIN move_evals e ON e.move_id = m.id
JOIN engine_versions ev ON ev.id = e.engine_version_id
LEFT JOIN move_mates mm ON mm.move_id = m.id
JOIN move_classifications mc ON mc.move_id = m.id
JOIN classifications c ON c.id = mc.classification_id
WHERE g.id = 20 AND m.ply BETWEEN 67 AND 70
ORDER BY m.ply;
```

Output (psql, demo database):

```
    user_email    | platform_name | platform_username | external_id | date_played | color | result | opening_eco |   opening_name   | tc_base | tc_inc | tc_category | ply | san  | uci  | mover_color | clock_remaining_ms | phase_name | engine_name | engine_version | threads | hash_size | depth | eval_before_cp | eval_after_cp | best_uci | mate_before | mate_after | classification_name | cp_loss |    motifs    
------------------+---------------+-------------------+-------------+-------------+-------+--------+-------------+------------------+---------+--------+-------------+-----+------+------+-------------+--------------------+------------+-------------+----------------+---------+-----------+-------+----------------+---------------+----------+-------------+------------+---------------------+---------+--------------
 demo@example.com | lichess       | DrNykterstein     | G3tGP3Qv    | 2026-03-17  | black | win    | B27         | Sicilian Defense |      60 |      0 | bullet      |  67 | Rf1  | h1f1 | white       |              27000 | endgame    | Stockfish   | 19             |       1 |        64 |    12 |            -59 |          -241 | e3d2     |             |            | mistake             |     182 | pin:allowed
 demo@example.com | lichess       | DrNykterstein     | G3tGP3Qv    | 2026-03-17  | black | win    | B27         | Sicilian Defense |      60 |      0 | bullet      |  68 | Ne5  | g6e5 | black       |              27000 | endgame    | Stockfish   | 19             |       1 |        64 |    12 |           -241 |          -209 | g6e5     |             |            | good                |      32 | 
 demo@example.com | lichess       | DrNykterstein     | G3tGP3Qv    | 2026-03-17  | black | win    | B27         | Sicilian Defense |      60 |      0 | bullet      |  69 | Rd1  | f1d1 | white       |              26000 | endgame    | Stockfish   | 19             |       1 |        64 |    12 |           -209 |          -606 | h2h5     |             |            | blunder             |     397 | fork:allowed
 demo@example.com | lichess       | DrNykterstein     | G3tGP3Qv    | 2026-03-17  | black | win    | B27         | Sicilian Defense |      60 |      0 | bullet      |  70 | Ng4+ | e5g4 | black       |              26000 | endgame    | Stockfish   | 19             |       1 |        64 |    12 |           -606 |          -606 | e5g4     |             |            | best                |       0 | 
(4 rows)
```

## 3.1 Redundancy and anomalies in the flat record

Game 20 has 74 plies, so in `FLAT_MOVE` the game-level values (`external_game_id G3tGP3Qv`, `date_played`, `colour black`, `result win`, `opening_eco B27`, `opening_name Sicilian Defense`, `tc_base_seconds 60`, `tc_category bullet`, the ratings) would be repeated 74 times, the user values (`user_email`, `password_hash`) would be repeated for every move of every game of the user (7,107 move rows in the demo data for 2 users), and the engine settings (`Stockfish`, `19`, threads `1`, hash `64`) would be repeated on all 7,107 rows although there is only one engine configuration.

- **Update anomaly.** Renaming an opening (for example after the openings dataset is updated) means updating `opening_name` on every move row of every game played with that ECO code; missing one row leaves two names for `B27`. The same holds for renaming a phase (`phase_name`), a classification or a platform, and for changing a user's `password_hash`, which would have to be rewritten on thousands of rows.
- **Insert anomaly.** A platform (`chesscom` has no games in the demo data), an opening, a time control, a motif or a classification cannot be recorded until a move that uses it exists. A newly linked platform account cannot be stored before its first game is imported, and a registered user without games cannot be stored at all.
- **Delete anomaly.** Deleting the last game of an account deletes the only rows that hold `platform_username`, so the account link disappears with it; deleting the last game of a user loses the user's email and password hash.
- **Repeated engine settings.** `engine_name`, `engine_version`, `engine_default_depth`, `engine_threads` and `engine_hash_size` are identical on every row produced by the same engine configuration. Changing the configuration is not an update at all: it must be a new configuration, which the flat record cannot express cleanly.
- **Missing values.** `mate_before` and `mate_after` are empty on 6,980 of 7,107 moves (only 127 moves have a forced mate), and most moves have no motif tag.

## 3.2 First normal form (1NF)

1NF requires atomic values and no repeating groups.

1. The repeating group `{ motif_name, motif_kind }*` is removed. Flattening it into the main record would give one row per (move, motif, kind); a move without any tag would then need a NULL in a key column, so the group is moved into its own relation, one row per tag.
2. Values are made atomic: the PGN `TimeControl` text such as `60+0` is split into `tc_base_seconds` and `tc_increment_seconds`; the PGN `[%clk]` comment is parsed into `clock_remaining_ms` and `time_spent_ms` (integers); the engine score is split into a centipawn value (`eval_before_cp`, `eval_after_cp`) and a mate distance (`mate_before`, `mate_after`).
3. A game is identified by its natural key `(platform_name, external_game_id)`, because external ids are only unique within one platform.

Result of 1NF:

| Relation | Attributes | Key |
|---|---|---|
| MOVE_1NF | platform_name, external_game_id, ply, user_email, password_hash, platform_username, date_played, colour, result, opening_eco, opening_name, tc_base_seconds, tc_increment_seconds, tc_category, player_rating, opponent_rating, total_plies, san, uci, fen_before, mover_colour, clock_remaining_ms, time_spent_ms, phase_name, engine_name, engine_version, engine_default_depth, engine_threads, engine_hash_size, depth, eval_before_cp, eval_after_cp, best_uci, mate_before, mate_after, classification_name, cp_loss | (platform_name, external_game_id, ply) |
| MOVE_MOTIF_1NF | platform_name, external_game_id, ply, motif_name, motif_kind | (platform_name, external_game_id, ply, motif_name, motif_kind) |

Taken together, the key of the original flat relation is (game, ply, motif, kind), where game = (platform_name, external_game_id). `MOVE_MOTIF_1NF` keeps `motif_kind` in the key because the same motif can be both `allowed` and `missed` on one move.

## 3.3 Second normal form (2NF)

2NF requires that no non-key attribute depends on only part of a composite key. The key of `MOVE_1NF` is (platform_name, external_game_id, ply). These dependencies use only the game part of the key:

- (platform_name, external_game_id) -> date_played, colour, result, opening_eco, opening_name, tc_base_seconds, tc_increment_seconds, tc_category, player_rating, opponent_rating, total_plies
- (platform_name, external_game_id) -> platform_username, user_email, password_hash (a game belongs to one account, which belongs to one user)

The remaining attributes need the whole key: (platform_name, external_game_id, ply) -> san, uci, fen_before, mover_colour, clock_remaining_ms, time_spent_ms, phase_name, engine settings, depth, eval_before_cp, eval_after_cp, best_uci, mate_before, mate_after, classification_name, cp_loss.

`MOVE_MOTIF_1NF` has no non-key attributes, so it is already in 2NF.

Decomposition:

| Relation | Attributes | Key |
|---|---|---|
| GAME_2NF | platform_name, external_game_id, platform_username, user_email, password_hash, date_played, colour, result, opening_eco, opening_name, tc_base_seconds, tc_increment_seconds, tc_category, player_rating, opponent_rating, total_plies | (platform_name, external_game_id) |
| MOVE_2NF | platform_name, external_game_id, ply, san, uci, fen_before, mover_colour, clock_remaining_ms, time_spent_ms, phase_name, engine_name, engine_version, engine_default_depth, engine_threads, engine_hash_size, depth, eval_before_cp, eval_after_cp, best_uci, mate_before, mate_after, classification_name, cp_loss | (platform_name, external_game_id, ply) |
| MOVE_MOTIF_2NF | platform_name, external_game_id, ply, motif_name, motif_kind | all attributes |

## 3.4 Third normal form (3NF)

3NF requires that no non-key attribute depends on another non-key attribute (no transitive dependency). Each transitive dependency below is removed by moving the dependent attributes into their own relation and keeping only a reference. At this step surrogate integer keys (`id`) are introduced for the new relations, as in the implemented schema; each keeps its natural key as a unique constraint.

| # | Transitive dependency in the 2NF relation | New relation (implemented table) | Reference kept |
|---|---|---|---|
| 1 | game -> (platform_name, platform_username) -> user_email -> password_hash | ACCOUNT(platform, username, user) = `player_accounts`; USER(email, password_hash) = `users` | `games.player_account_id`, `player_accounts.user_id` |
| 2 | platform_id -> platform_name | PLATFORM = `platforms` | `player_accounts.platform_id`, `games.platform_id` |
| 3 | game -> result_id -> result code | RESULT = `results` | `games.result_id` |
| 4 | game -> opening_eco -> opening_name | OPENING(eco, name) = `openings` | `games.opening_id` |
| 5 | game -> (tc_base_seconds, tc_increment_seconds) -> tc_category | TIME_CONTROL(base_seconds, increment_seconds, category) = `time_controls` | `games.time_control_id` |
| 6 | move -> phase_id -> phase_name | PHASE = `phases` | `moves.phase_id` |
| 7 | move -> engine configuration id -> (engine_name, engine_version, engine_default_depth, engine_threads, engine_hash_size) | ENGINE_VERSION = `engine_versions` | `move_evals.engine_version_id` |
| 8 | move -> classification_id -> classification_name | CLASSIFICATION = `classifications` | `move_classifications.classification_id` |
| 9 | motif tag -> motif_id -> motif_name | MOTIF = `motifs` | `move_motifs.motif_id` |

Notes on the dependencies:

- Row 7: before an identifier is introduced, the five engine columns have no dependency among themselves; together they are the identity of one engine configuration and they repeat on every move. Giving the configuration its own key (`engine_versions.id`, natural key `UNIQUE(name, version, default_depth, threads, hash_size)`) turns the repetition into the transitive dependency shown and removes it. `depth` stays with the evaluation because it is the depth of that search (all 7,107 demo evaluations have depth 12, the configured default).
- Row 4: in the seeded openings dataset each ECO code has exactly one name (500 rows, 500 distinct `eco` values). The table keeps `UNIQUE(eco, name)` rather than `UNIQUE(eco)`; see Known limitations.
- Row 5: `(base_seconds, increment_seconds)` is a candidate key of `time_controls` (`UNIQUE(base_seconds, increment_seconds)`), and `category` is computed from it by the formula in `src/chess/pgnParser.js` (`parseTimeControl`) and `prisma/seed/index.js`.

The move-level relation is also split by meaning, not only by dependency. Every attribute of MOVE_2NF depends on the whole move key, but the attributes come from three different moments: the parsed move (written once at import), the engine evaluation (written once after analysis) and the derived classification. They are stored in separate one-to-one tables that share the move key (`moves.id`):

| Part of MOVE_2NF | Implemented table | Key |
|---|---|---|
| ply, san, uci, fen_before, mover_colour, clock_remaining_ms, time_spent_ms, phase | `moves` | `id`; natural key `UNIQUE(game_id, ply)` |
| depth, eval_before_cp, eval_after_cp, best_uci, engine configuration | `move_evals` | `move_id` |
| mate_before, mate_after (only when a mate exists) | `move_mates` | `move_id` |
| classification, cp_loss | `move_classifications` | `move_id` |
| motif tags (MOVE_MOTIF_2NF) | `move_motifs` | `(move_id, motif_id, kind)` |

### Final 3NF relations and where they live in the schema

| Relation of the derivation | Implemented table | Comes from |
|---|---|---|
| USER | `users` | 3NF row 1 |
| ACCOUNT | `player_accounts` | 3NF row 1 |
| PLATFORM | `platforms` | 3NF row 2 |
| GAME | `games` | GAME_2NF without the user, account, opening, time-control and result attributes |
| RESULT | `results` | 3NF row 3 |
| OPENING | `openings` | 3NF row 4 |
| TIME_CONTROL | `time_controls` | 3NF row 5 |
| MOVE | `moves` | MOVE_2NF, parsed part |
| PHASE | `phases` | 3NF row 6 |
| MOVE_EVAL | `move_evals` | MOVE_2NF, evaluation part |
| ENGINE_VERSION | `engine_versions` | 3NF row 7 |
| MOVE_MATE | `move_mates` | MOVE_2NF, mate part |
| MOVE_CLASSIFICATION | `move_classifications` | MOVE_2NF, classification part |
| CLASSIFICATION | `classifications` | 3NF row 8 |
| MOVE_MOTIF | `move_motifs` | MOVE_MOTIF_2NF |
| MOTIF | `motifs` | 3NF row 9 |

The remaining eight tables are not part of the flat move record. They model the other features of the application and were designed directly in normalized form: `puzzles` and `puzzle_motifs` (puzzle bank and its many-to-many link to `motifs`), `training_plans` and `training_plan_items` (generated plans), `analysis_jobs` and `analysis_job_games` (job queue and its many-to-many link to `games`), and `account_summary` and `account_phase_summary` (derived rollups, section 3.6).

## 3.5 Functional dependencies of every implemented table

The list covers all 24 tables returned by `\dt` (without `_prisma_migrations`). "Declared" means enforced by a primary key or unique index in the database. Where a dependency holds in the data but is not declared, the check query and its result are given.

| Table | Functional dependencies | Candidate keys | Normal form |
|---|---|---|---|
| `platforms` | id -> name; name -> id | {id}, {name} | BCNF: every determinant is a key |
| `results` | id -> code; code -> id | {id}, {code} | BCNF |
| `phases` | id -> name; name -> id | {id}, {name} | BCNF |
| `classifications` | id -> name; name -> id | {id}, {name} | BCNF |
| `motifs` | id -> name; name -> id | {id}, {name} | BCNF |
| `time_controls` | id -> base_seconds, increment_seconds, category; (base_seconds, increment_seconds) -> id, category | {id}, {base_seconds, increment_seconds} | BCNF (see Known limitations for the `(0, 0)` row) |
| `openings` | id -> eco, name; (eco, name) -> id | {id}, {eco, name} | BCNF for the declared dependencies; eco -> name holds in the data but is not declared |
| `engine_versions` | id -> name, version, default_depth, threads, hash_size; (name, version, default_depth, threads, hash_size) -> id | {id}, {name, version, default_depth, threads, hash_size} | BCNF |
| `users` | id -> email, password_hash, created_at; email -> id | {id}, {email} | BCNF |
| `player_accounts` | id -> user_id, platform_id, username, last_synced_at, created_at; (platform_id, username) -> id | {id}, {platform_id, username} | BCNF |
| `games` | id -> all other columns; (platform_id, external_id) -> id; player_account_id -> platform_id | {id}, {platform_id, external_id} | 3NF, not BCNF: `player_account_id -> platform_id` has a non-key determinant, but `platform_id` is prime (part of the candidate key), which 3NF allows. Checked: 0 of 80 games have a `platform_id` different from their account's |
| `moves` | id -> all other columns; (game_id, ply) -> id; chess-rule dependencies ply -> mover_color, fen_before -> mover_color, (fen_before, san) -> uci, (fen_before, uci) -> san | {id}, {game_id, ply} | BCNF for the declared keys; the chess-rule dependencies are intentional redundancy (section 3.6). Checked: 0 of 7,107 moves have `mover_color` different from ply parity or from the side to move in `fen_before` |
| `move_evals` | move_id -> eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id | {move_id} | BCNF |
| `move_mates` | move_id -> mate_before, mate_after | {move_id} | BCNF |
| `move_classifications` | move_id -> classification_id, cp_loss | {move_id} | BCNF within the table (the values are derived from `move_evals`, section 3.6) |
| `move_motifs` | no non-trivial dependency; all three columns form the key | {move_id, motif_id, kind} | BCNF (all-key) |
| `puzzles` | id -> lichess_id, fen, moves_uci, rating, phase_tag; lichess_id -> id | {id}, {lichess_id} | BCNF |
| `puzzle_motifs` | no non-trivial dependency | {puzzle_id, motif_id} | BCNF (all-key) |
| `training_plans` | id -> user_id, created_at | {id} | BCNF |
| `training_plan_items` | id -> plan_id, puzzle_id, motif_id, reason_code, completed_at; for motif reasons reason_code -> motif_id | {id} | 3NF violated for motif reasons (Known limitations) |
| `analysis_jobs` | id -> all other columns; for rows with status in ('queued', 'running'): player_account_id -> id (partial unique index) | {id}; {player_account_id} among active rows | BCNF |
| `analysis_job_games` | (job_id, game_id) -> status, error | {job_id, game_id} | BCNF |
| `account_summary` | player_account_id -> all other columns | {player_account_id} | BCNF within the table; the whole table is derived (section 3.6) |
| `account_phase_summary` | (player_account_id, phase_id) -> moves, blunders, avg_cp_loss | {player_account_id, phase_id} | BCNF within the table; derived |

Queries used for the checks in the table (run on the demo database):

```
SELECT COUNT(*) AS games, COUNT(*) FILTER (WHERE g.platform_id <> pa.platform_id) AS platform_mismatch
FROM games g JOIN player_accounts pa ON pa.id = g.player_account_id;
 games | platform_mismatch
-------+-------------------
    80 |                 0

SELECT COUNT(*) AS moves,
       COUNT(*) FILTER (WHERE mover_color <> CASE WHEN ply % 2 = 1 THEN 'white' ELSE 'black' END) AS parity_mismatch,
       COUNT(*) FILTER (WHERE split_part(fen_before, ' ', 2) <> left(mover_color, 1)) AS fen_side_mismatch
FROM moves;
 moves | parity_mismatch | fen_side_mismatch
-------+-----------------+-------------------
  7107 |               0 |                 0

SELECT COUNT(*), COUNT(DISTINCT eco) FROM openings;
 count | count
-------+-------
   500 |   500
```

## 3.6 Intentional design choices

- **`move_mates` as a separate sparse table.** Only 127 of 7,107 moves have a mate distance. Two nullable columns on `move_evals` would be NULL on 98 percent of the rows; a separate one-to-one table keeps every column of `move_evals` NOT NULL and stores a row only when a mate exists. The project rule in `ENGINEERING.md` ("Mate data goes in `move_mates`, not nullable columns on `move_evals`") records this.
- **`move_evals` and `move_classifications` as one-to-one tables sharing the move key.** `moves` is written once at import and never updated; evaluations and classifications are written later, in one transaction per game, by `saveGameAnalysis` (`src/repositories/moveBulk.repo.js`). Keeping them in separate tables means analysis never rewrites a move row, and a game that is not analysed yet simply has no rows there.
- **Derived values stored on purpose.**
  - `move_classifications.cp_loss` and `classification_id` are computed from `move_evals` and `moves.mover_color` by `src/chess/evalMath.js`. They are stored because every analytics query filters and counts by classification, and because storing them keeps a game's classification stable if the classification rules change later.
  - `move_evals.eval_before_cp` of ply n equals `eval_after_cp` of ply n-1 (the worker evaluates each position once and reuses it; checked: 7,027 of 7,027 consecutive pairs match). Storing both values per move lets `cp_loss` be checked from one row.
  - `moves.mover_color` follows from `ply` (only standard starting positions are imported) and from `fen_before`; `san` and `uci` are two notations of the same move. They are kept because analytics filters on `m.mover_color = g.color` in every query, the client shows SAN, and the engine needs UCI. Move rows are insert-only, so these copies cannot drift through updates.
  - `games.total_plies` equals the number of move rows for the game (80 of 80 games match). It is kept because a game that failed to parse can have no move rows but still has a known length.
  - `games.platform_id` repeats `player_accounts.platform_id`. It is kept because it is part of the natural key `UNIQUE(platform_id, external_id)` that makes imports idempotent.
- **Summary tables are deliberate, documented denormalization.** `account_summary` (one row per account) and `account_phase_summary` (one row per account and phase) contain only values that can be recomputed from `games`, `moves`, `move_classifications` and `classifications`. They exist for read performance: `docs/benchmarks/queries.md` measured 0.29 ms for reading them against 242.35 ms for the equivalent aggregate at 10,000 games. Refresh logic (`refreshAccountSummary` in `src/services/summary.service.js`): inside one transaction it checks that the account exists, counts all games of the account, aggregates the owner's moves (`m.mover_color = g.color`) of games with `analysis_status = 'analyzed'` (moves, inaccuracies, mistakes, blunders, average `cp_loss`, accuracy as the share of `best` and `good` moves, latest `played_at`), upserts `account_summary` with `INSERT ... ON CONFLICT (player_account_id) DO UPDATE`, then computes one row per phase (a `LEFT JOIN` from `phases`, so phases without moves get zeros) and upserts `account_phase_summary` with `ON CONFLICT (player_account_id, phase_id) DO UPDATE`. The worker calls it after every completed job (`src/workers/jobRunner.js`); `getAccountSummary` calls it lazily when an account has no summary row yet. Because the tables can always be rebuilt, losing or corrupting them loses no information. Query Q13 in `06_queries.md` checks that the stored summary equals the live aggregate.
- **Status and kind values as text with application validation.** `games.color`, `moves.mover_color`, `games.analysis_status` (`pending`, `analyzed`, `failed`), `analysis_jobs.status` (`queued`, `running`, `completed`, `failed`), `analysis_job_games.status` (`pending`, `analyzing`, `done`, `failed`) and `move_motifs.kind` (`allowed`, `missed`) are `text` columns. Only the application decides their values: the parser and `insertGameWithMoves` set colours and status, `jobQueue.js` sets job status, and `saveGameAnalysis` writes motif kinds. Since migration `20261122161952_add_check_constraints` the database enforces the same sets with `CHECK` constraints (`games_color_check`, `moves_mover_color_check`, `games_analysis_status_check`, `analysis_jobs_status_check`, `analysis_job_games_status_check`, `move_motifs_kind_check`, and `time_controls_category_check` for `time_controls.category`), so a manual or faulty write with another value is rejected with SQLSTATE 23514 (query Q17 in `06_queries.md`). These columns could also have been lookup tables like `phases`; we kept them as text because the sets are tiny and fixed in code, and a `CHECK` constraint enforces a fixed set without a join.

## 3.7 Known limitations

1. **Value rules that are still only in application code.** The status, colour, kind and category columns and the numeric ranges are enforced by 37 `CHECK` constraints (see `04_final_schema.md`). Two rules are deliberately weaker in the database than in the application: `move_evals.depth` only has to be `>= 0`, because terminal positions are stored with depth 0 and `best_uci = 'none'` (the pairing of the two is checked by the data-quality check `eval_ranges`, not by a constraint), and game ratings only have to be `>= 0`, because a PGN header such as `WhiteElo "0"` is parsed as 0. `training_plan_items.reason_code` has no `CHECK`: the application writes a closed set of prefixes (`MOTIF_WEAKNESS:`, `OPENING_PHASE_WEAKNESS:`) but the rest of the code is open.
2. **`eco -> name` is not declared.** `openings` is unique on `(eco, name)`, not on `eco`. The importer resolves the opening of a game with `SELECT id FROM openings WHERE eco = $1 LIMIT 1` (`src/repositories/moveBulk.repo.js`), without an `ORDER BY`. This is correct today because each ECO code has one name, but it would pick an arbitrary name if a second name for an ECO code were ever seeded.
3. **The `(0, 0)` time control has two meanings.** `parseTimeControl` maps a missing `TimeControl` header to `(0, 0, 'classical')` and the correspondence marker `-` to `(0, 0, 'correspondence')`. Both share the key `(0, 0)`, and the upsert in `insertGameWithMoves` (`ON CONFLICT (base_seconds, increment_seconds) DO UPDATE SET category = EXCLUDED.category`) overwrites the category with the last import's value. The demo data has no `(0, 0)` row (it appeared during the walkthrough in `07_integration_evidence.md` and was removed afterwards).
4. **`training_plan_items.reason_code` is a structured string.** Values such as `MOTIF_WEAKNESS:pin` and `OPENING_PHASE_WEAKNESS:B01_ENDGAME` hold two pieces of information in one text value, and for motif reasons the motif name in the code repeats `motif_id`. It is written once by `generatePlan` (`src/services/training.service.js`) and never updated, so the copies cannot drift, but strictly the motif part breaks 3NF.
5. **`games.platform_id` is not tied to the account's platform by a constraint.** The redundancy is consistent in the data (0 mismatches) because `insertGameWithMoves` copies it from the account, but no composite foreign key enforces it.
