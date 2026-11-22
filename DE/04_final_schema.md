# 4. Final schema

The complete DDL of the implemented schema is in [`schema.sql`](schema.sql). It was produced from the live demo database, not written by hand:

```
docker compose -p pawnprint-demo exec -T db pg_dump -U chess -d chess_analytics --schema-only --no-owner --no-privileges > DE/schema.sql
```

after which the blocks of the Prisma bookkeeping table `_prisma_migrations` were removed (a short Python filter that drops every `-- Name:` block mentioning that table). The resulting file was checked by loading it into an empty database (`CREATE DATABASE schema_check`, then `psql -v ON_ERROR_STOP=1 -f DE/schema.sql`), which created the 24 tables without errors; the check database was dropped afterwards.

The schema itself is defined in `prisma/schema.prisma` and created by the six migrations in `prisma/migrations/`:

| Migration | What it adds |
|---|---|
| `20261112050821_init_lookup_identity_games` | `platforms`, `users`, `player_accounts`, `results`, `time_controls`, `openings`, `games` and their keys |
| `20261112055912_moves_evals_motifs` | `phases`, `moves`, `engine_versions`, `move_evals`, `move_mates`, `classifications`, `move_classifications`, `motifs`, `move_motifs` |
| `20261112062647_puzzles_training_jobs` | `puzzles`, `puzzle_motifs`, `training_plans`, `training_plan_items`, `analysis_jobs`, `analysis_job_games`, and (raw SQL appended to the generated migration) the partial unique index `idx_analysis_jobs_active_unique` |
| `20261112105133_engine_key_and_job_counters_not_null` | backfills NULLs, then sets NOT NULL on `engine_versions.threads`, `engine_versions.hash_size`, `analysis_jobs.max_games`, `failed_games`, `skipped_games` |
| `20261114161727_analytics_indexes` | `idx_move_motifs_motif_id`, `idx_player_accounts_user_id` |
| `20261114162509_account_summaries` | `account_summary`, `account_phase_summary` |

General rules visible in every table:

- Every table has a primary key; entity tables use a `SERIAL` integer `id`, one-to-one tables reuse `move_id` or `player_account_id`, link tables use a composite key.
- Every foreign key has `ON UPDATE CASCADE` (the Prisma default). `ON DELETE` is `CASCADE` for ownership (user -> accounts -> games -> moves -> evaluations), `RESTRICT` for lookups that are still in use, and `SET NULL` for the optional lookups `games.opening_id`, `games.time_control_id` and `training_plan_items.motif_id`.
- Timestamps are `timestamp(3) without time zone` holding UTC; raw SQL writes them with `(NOW() AT TIME ZONE 'UTC')` and `src/config/db.js` sets the `pg` driver to read and write them as UTC.
- No table has a `CHECK` constraint (see Known limitations in `03_normalization.md`).

## Tables

### 4.1 `users`

Registered application users. `email` is stored lower-cased and trimmed by `normalizeEmail` in `src/services/auth.service.js`; `password_hash` is a bcrypt hash (10 salt rounds). Rows in the demo database: 2.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `email` | text | no |  |
| `password_hash` | text | no |  |
| `created_at` | timestamp(3) | no | `CURRENT_TIMESTAMP` |

- Primary key: `users_pkey` (id)
- Foreign keys: none
- Unique constraints: `users_email_key` (email)
- Other constraints: NOT NULL on `id`, `email`, `password_hash`, `created_at`; no CHECK constraints
- Indexes:
  - `users_email_key` btree (email): Unique email; login looks users up by email (`findByEmail`).
  - `users_pkey` btree (id): Primary key.

### 4.2 `platforms`

Lookup of game sources: `lichess`, `chesscom` and `upload` (seeded). Rows in the demo database: 3.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `name` | text | no |  |

- Primary key: `platforms_pkey` (id)
- Foreign keys: none
- Unique constraints: `platforms_name_key` (name)
- Other constraints: NOT NULL on `id`, `name`; no CHECK constraints
- Indexes:
  - `platforms_name_key` btree (name): Unique platform name; looked up by name when linking an account.
  - `platforms_pkey` btree (id): Primary key.

### 4.3 `player_accounts`

A user's link to one account on one platform. `last_synced_at` is the import cursor: the newest `played_at` stored by a completed platform job, moved forward only (`advanceCursor` in `src/workers/jobRunner.js`). Rows in the demo database: 2.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `user_id` | integer | no |  |
| `platform_id` | integer | no |  |
| `username` | text | no |  |
| `last_synced_at` | timestamp(3) | yes |  |
| `created_at` | timestamp(3) | no | `CURRENT_TIMESTAMP` |

- Primary key: `player_accounts_pkey` (id)
- Foreign keys:
  - `player_accounts_platform_id_fkey`: `platform_id` -> `platforms(id)`, ON DELETE RESTRICT
  - `player_accounts_user_id_fkey`: `user_id` -> `users(id)`, ON DELETE CASCADE
- Unique constraints: `player_accounts_platform_id_username_key` (platform_id, username)
- Other constraints: NOT NULL on `id`, `user_id`, `platform_id`, `username`, `created_at`; no CHECK constraints
- Indexes:
  - `idx_player_accounts_user_id` btree (user_id): Every user-scoped query filters `pa.user_id = $1`. Added in migration `20261114161727_analytics_indexes`; at 10,000 games the planner still chose sequential scans and the change was within noise, so it is kept for many users ([docs/explain/README.md](../docs/explain/README.md)).
  - `player_accounts_pkey` btree (id): Primary key.
  - `player_accounts_platform_id_username_key` btree (platform_id, username): One link per platform account across all users; `linkAccount` checks it before inserting (409 Conflict).

### 4.4 `results`

Lookup of game results from the account owner's point of view: `win`, `loss`, `draw` (seeded). Rows in the demo database: 3.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `code` | text | no |  |

- Primary key: `results_pkey` (id)
- Foreign keys: none
- Unique constraints: `results_code_key` (code)
- Other constraints: NOT NULL on `id`, `code`; no CHECK constraints
- Indexes:
  - `results_code_key` btree (code): Unique result code.
  - `results_pkey` btree (id): Primary key.

### 4.5 `time_controls`

Lookup of clock settings (base and increment in seconds) with their category (`bullet`, `blitz`, `rapid`, `classical`, `correspondence`). Seeded with 11 rows; the importer adds missing combinations with an upsert. Rows in the demo database: 11.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `base_seconds` | integer | no |  |
| `increment_seconds` | integer | no |  |
| `category` | text | no |  |

- Primary key: `time_controls_pkey` (id)
- Foreign keys: none
- Unique constraints: `time_controls_base_seconds_increment_seconds_key` (base_seconds, increment_seconds)
- Other constraints: NOT NULL on `id`, `base_seconds`, `increment_seconds`, `category`; no CHECK constraints
- Indexes:
  - `time_controls_base_seconds_increment_seconds_key` btree (base_seconds, increment_seconds): Natural key; target of the importer's `ON CONFLICT (base_seconds, increment_seconds)` upsert.
  - `time_controls_pkey` btree (id): Primary key.

### 4.6 `openings`

Lookup of ECO opening codes and names, seeded from `prisma/seed/openings.json` (500 rows, A00 to E99). Rows in the demo database: 500.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `eco` | text | no |  |
| `name` | text | no |  |

- Primary key: `openings_pkey` (id)
- Foreign keys: none
- Unique constraints: `openings_eco_name_key` (eco, name)
- Other constraints: NOT NULL on `id`, `eco`, `name`; no CHECK constraints
- Indexes:
  - `openings_eco_name_key` btree (eco, name): Natural key; its leading column can also serve the importer's lookup `WHERE eco = $1`.
  - `openings_pkey` btree (id): Primary key.

### 4.7 `games`

One row per imported game: who played it (`player_account_id`), where (`platform_id`, `external_id`), when, with which colour, result, opening, time control and ratings, and its analysis state (`analysis_status`, `failure_reason`). Rows in the demo database: 80.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `player_account_id` | integer | no |  |
| `platform_id` | integer | no |  |
| `external_id` | text | no |  |
| `played_at` | timestamp(3) | no |  |
| `color` | text | no |  |
| `result_id` | integer | no |  |
| `opening_id` | integer | yes |  |
| `time_control_id` | integer | yes |  |
| `player_rating` | integer | yes |  |
| `opponent_rating` | integer | yes |  |
| `total_plies` | integer | no |  |
| `analysis_status` | text | no | `'pending'` |
| `failure_reason` | text | yes |  |

- Primary key: `games_pkey` (id)
- Foreign keys:
  - `games_opening_id_fkey`: `opening_id` -> `openings(id)`, ON DELETE SET NULL
  - `games_platform_id_fkey`: `platform_id` -> `platforms(id)`, ON DELETE RESTRICT
  - `games_player_account_id_fkey`: `player_account_id` -> `player_accounts(id)`, ON DELETE CASCADE
  - `games_result_id_fkey`: `result_id` -> `results(id)`, ON DELETE RESTRICT
  - `games_time_control_id_fkey`: `time_control_id` -> `time_controls(id)`, ON DELETE SET NULL
- Unique constraints: `games_platform_id_external_id_key` (platform_id, external_id)
- Other constraints: NOT NULL on `id`, `player_account_id`, `platform_id`, `external_id`, `played_at`, `color`, `result_id`, `total_plies`, `analysis_status`; no CHECK constraints
- Indexes:
  - `games_pkey` btree (id): Primary key.
  - `games_platform_id_external_id_key` btree (platform_id, external_id): Idempotent imports: `ON CONFLICT (platform_id, external_id) DO NOTHING` (query Q01, Q16a).
  - `games_player_account_id_played_at_idx` btree (player_account_id, played_at): Games list and date filters: `WHERE player_account_id = ... ORDER BY played_at DESC`. The plan in `06_queries.md` (E1) uses it as `Index Scan Backward`.

### 4.8 `phases`

Lookup of game phases: `opening`, `middlegame`, `endgame` (seeded). Rows in the demo database: 3.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `name` | text | no |  |

- Primary key: `phases_pkey` (id)
- Foreign keys: none
- Unique constraints: `phases_name_key` (name)
- Other constraints: NOT NULL on `id`, `name`; no CHECK constraints
- Indexes:
  - `phases_name_key` btree (name): Unique phase name.
  - `phases_pkey` btree (id): Primary key.

### 4.9 `moves`

One row per ply of a game, written once at import by a single UNNEST insert per game and never updated. Rows in the demo database: 7,107.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `game_id` | integer | no |  |
| `ply` | integer | no |  |
| `san` | text | no |  |
| `uci` | text | no |  |
| `fen_before` | text | no |  |
| `mover_color` | text | no |  |
| `clock_remaining_ms` | integer | yes |  |
| `time_spent_ms` | integer | yes |  |
| `phase_id` | integer | no |  |

- Primary key: `moves_pkey` (id)
- Foreign keys:
  - `moves_game_id_fkey`: `game_id` -> `games(id)`, ON DELETE CASCADE
  - `moves_phase_id_fkey`: `phase_id` -> `phases(id)`, ON DELETE RESTRICT
- Unique constraints: `moves_game_id_ply_key` (game_id, ply)
- Other constraints: NOT NULL on `id`, `game_id`, `ply`, `san`, `uci`, `fen_before`, `mover_color`, `phase_id`; no CHECK constraints
- Indexes:
  - `moves_game_id_ply_key` btree (game_id, ply): One row per ply; also the access path for a game's moves (`WHERE game_id = $1 ORDER BY ply`). Seen as `Index Scan using moves_game_id_ply_key` in [docs/explain/after/6_weakest_opening_phases.txt](../docs/explain/after/6_weakest_opening_phases.txt).
  - `moves_pkey` btree (id): Primary key.

### 4.10 `engine_versions`

Immutable engine configurations. A worker registers its Stockfish name and version (read from the UCI `id name` line) with depth, threads and hash size; a new combination inserts a new row. Rows in the demo database: 1.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `name` | text | no |  |
| `version` | text | no |  |
| `default_depth` | integer | no |  |
| `threads` | integer | no | `1` |
| `hash_size` | integer | no | `64` |

- Primary key: `engine_versions_pkey` (id)
- Foreign keys: none
- Unique constraints: `engine_versions_name_version_default_depth_threads_hash_siz_key` (name, version, default_depth, threads, hash_size)
- Other constraints: NOT NULL on `id`, `name`, `version`, `default_depth`, `threads`, `hash_size`; no CHECK constraints
- Indexes:
  - `engine_versions_name_version_default_depth_threads_hash_siz_key` btree (name, version, default_depth, threads, hash_size): Natural key of an engine configuration (name truncated to 63 characters by PostgreSQL).
  - `engine_versions_pkey` btree (id): Primary key.

### 4.11 `move_evals`

Engine evaluation of one move: score before and after in White-perspective centipawns, engine best move, search depth and engine configuration. One-to-one with `moves`. Rows in the demo database: 7,107.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `move_id` | integer | no |  |
| `eval_before_cp` | integer | no |  |
| `eval_after_cp` | integer | no |  |
| `best_uci` | text | no |  |
| `depth` | integer | no |  |
| `engine_version_id` | integer | no |  |

- Primary key: `move_evals_pkey` (move_id)
- Foreign keys:
  - `move_evals_engine_version_id_fkey`: `engine_version_id` -> `engine_versions(id)`, ON DELETE RESTRICT
  - `move_evals_move_id_fkey`: `move_id` -> `moves(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `move_id`, `eval_before_cp`, `eval_after_cp`, `best_uci`, `depth`, `engine_version_id`; no CHECK constraints
- Indexes:
  - `move_evals_pkey` btree (move_id): Primary key.

### 4.12 `move_mates`

Forced-mate distances for the few moves where a mate exists, before and after the move. One-to-one with `moves`, sparse. Rows in the demo database: 127.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `move_id` | integer | no |  |
| `mate_before` | integer | yes |  |
| `mate_after` | integer | yes |  |

- Primary key: `move_mates_pkey` (move_id)
- Foreign keys:
  - `move_mates_move_id_fkey`: `move_id` -> `moves(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `move_id`; no CHECK constraints
- Indexes:
  - `move_mates_pkey` btree (move_id): Primary key.

### 4.13 `classifications`

Lookup of move classes: `best`, `good`, `inaccuracy`, `mistake`, `blunder` (seeded). Rows in the demo database: 5.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `name` | text | no |  |

- Primary key: `classifications_pkey` (id)
- Foreign keys: none
- Unique constraints: `classifications_name_key` (name)
- Other constraints: NOT NULL on `id`, `name`; no CHECK constraints
- Indexes:
  - `classifications_name_key` btree (name): Unique classification name.
  - `classifications_pkey` btree (id): Primary key.

### 4.14 `move_classifications`

Classification and centipawn loss of one move, derived from its evaluation. One-to-one with `moves`. Rows in the demo database: 7,107.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `move_id` | integer | no |  |
| `classification_id` | integer | no |  |
| `cp_loss` | integer | no |  |

- Primary key: `move_classifications_pkey` (move_id)
- Foreign keys:
  - `move_classifications_classification_id_fkey`: `classification_id` -> `classifications(id)`, ON DELETE RESTRICT
  - `move_classifications_move_id_fkey`: `move_id` -> `moves(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `move_id`, `classification_id`, `cp_loss`; no CHECK constraints
- Indexes:
  - `move_classifications_pkey` btree (move_id): Primary key.

### 4.15 `motifs`

Lookup of tactical motifs: `hanging_piece`, `fork`, `pin`, `skewer`, `back_rank`, `discovered_attack`, `missed_mate` (seeded). Rows in the demo database: 7.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `name` | text | no |  |

- Primary key: `motifs_pkey` (id)
- Foreign keys: none
- Unique constraints: `motifs_name_key` (name)
- Other constraints: NOT NULL on `id`, `name`; no CHECK constraints
- Indexes:
  - `motifs_name_key` btree (name): Unique motif name; `findPuzzlesForMotif` looks motifs up by name.
  - `motifs_pkey` btree (id): Primary key.

### 4.16 `move_motifs`

Link table between moves and motifs. `kind` is `allowed` (the move allowed the opponent's tactic) or `missed` (the best move would have used it). Rows in the demo database: 311.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `move_id` | integer | no |  |
| `motif_id` | integer | no |  |
| `kind` | text | no | `'allowed'` |

- Primary key: `move_motifs_pkey` (move_id, motif_id, kind)
- Foreign keys:
  - `move_motifs_motif_id_fkey`: `motif_id` -> `motifs(id)`, ON DELETE RESTRICT
  - `move_motifs_move_id_fkey`: `move_id` -> `moves(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `move_id`, `motif_id`, `kind`; no CHECK constraints
- Indexes:
  - `idx_move_motifs_motif_id` btree (motif_id): Joins and filters by motif. Added in migration `20261114161727_analytics_indexes` for [docs/explain/after/5_motif_weaknesses.txt](../docs/explain/after/5_motif_weaknesses.txt); kept for selective single-motif lookups at larger sizes ([docs/explain/README.md](../docs/explain/README.md)).
  - `move_motifs_pkey` btree (move_id, motif_id, kind): Primary key.

### 4.17 `puzzles`

Puzzle bank imported from the Lichess puzzle CSV (`scripts/importPuzzles.js`). Rows in the demo database: 50,000.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `lichess_id` | text | no |  |
| `fen` | text | no |  |
| `moves_uci` | text | no |  |
| `rating` | integer | no |  |
| `phase_tag` | text | yes |  |

- Primary key: `puzzles_pkey` (id)
- Foreign keys: none
- Unique constraints: `puzzles_lichess_id_key` (lichess_id)
- Other constraints: NOT NULL on `id`, `lichess_id`, `fen`, `moves_uci`, `rating`; no CHECK constraints
- Indexes:
  - `puzzles_lichess_id_key` btree (lichess_id): Idempotent puzzle import by Lichess id.
  - `puzzles_pkey` btree (id): Primary key.

### 4.18 `puzzle_motifs`

Link table between puzzles and motifs, from the puzzle themes column. Rows in the demo database: 16,600.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `puzzle_id` | integer | no |  |
| `motif_id` | integer | no |  |

- Primary key: `puzzle_motifs_pkey` (puzzle_id, motif_id)
- Foreign keys:
  - `puzzle_motifs_motif_id_fkey`: `motif_id` -> `motifs(id)`, ON DELETE RESTRICT
  - `puzzle_motifs_puzzle_id_fkey`: `puzzle_id` -> `puzzles(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `puzzle_id`, `motif_id`; no CHECK constraints
- Indexes:
  - `puzzle_motifs_pkey` btree (puzzle_id, motif_id): Primary key.

### 4.19 `training_plans`

A generated training plan of a user. Rows in the demo database: 2.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `user_id` | integer | no |  |
| `created_at` | timestamp(3) | no | `CURRENT_TIMESTAMP` |

- Primary key: `training_plans_pkey` (id)
- Foreign keys:
  - `training_plans_user_id_fkey`: `user_id` -> `users(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `id`, `user_id`, `created_at`; no CHECK constraints
- Indexes:
  - `training_plans_pkey` btree (id): Primary key.

### 4.20 `training_plan_items`

One puzzle in a plan, the motif it trains (if any), why it was chosen (`reason_code`) and when it was completed. Rows in the demo database: 25.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `plan_id` | integer | no |  |
| `puzzle_id` | integer | no |  |
| `motif_id` | integer | yes |  |
| `reason_code` | text | no |  |
| `completed_at` | timestamp(3) | yes |  |

- Primary key: `training_plan_items_pkey` (id)
- Foreign keys:
  - `training_plan_items_motif_id_fkey`: `motif_id` -> `motifs(id)`, ON DELETE SET NULL
  - `training_plan_items_plan_id_fkey`: `plan_id` -> `training_plans(id)`, ON DELETE CASCADE
  - `training_plan_items_puzzle_id_fkey`: `puzzle_id` -> `puzzles(id)`, ON DELETE RESTRICT
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `id`, `plan_id`, `puzzle_id`, `reason_code`; no CHECK constraints
- Indexes:
  - `training_plan_items_pkey` btree (id): Primary key.

### 4.21 `analysis_jobs`

Job queue. A job imports and analyses games of one account; workers claim jobs with `FOR UPDATE SKIP LOCKED` and keep `heartbeat_at` fresh while they run. Rows in the demo database: 3.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | integer | no | sequence (`SERIAL`) |
| `player_account_id` | integer | no |  |
| `status` | text | no | `'queued'` |
| `attempts` | integer | no | `0` |
| `max_games` | integer | no | `50` |
| `since` | timestamp(3) | yes |  |
| `until` | timestamp(3) | yes |  |
| `locked_by` | text | yes |  |
| `locked_at` | timestamp(3) | yes |  |
| `heartbeat_at` | timestamp(3) | yes |  |
| `error` | text | yes |  |
| `failed_games` | integer | no | `0` |
| `skipped_games` | integer | no | `0` |
| `created_at` | timestamp(3) | no | `CURRENT_TIMESTAMP` |
| `finished_at` | timestamp(3) | yes |  |

- Primary key: `analysis_jobs_pkey` (id)
- Foreign keys:
  - `analysis_jobs_player_account_id_fkey`: `player_account_id` -> `player_accounts(id)`, ON DELETE CASCADE
- Unique constraints: `idx_analysis_jobs_active_unique` (player_account_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))
- Other constraints: NOT NULL on `id`, `player_account_id`, `status`, `attempts`, `max_games`, `failed_games`, `skipped_games`, `created_at`; no CHECK constraints
- Indexes:
  - `analysis_jobs_pkey` btree (id): Primary key.
  - `analysis_jobs_status_created_at_idx` btree (status, created_at): Serves the claim query's `WHERE status = ... ORDER BY created_at` (DESIGN.md section 4).
  - `idx_analysis_jobs_active_unique` btree (player_account_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text])): Partial unique index (raw SQL at the end of migration `20261112062647_puzzles_training_jobs`): at most one job with status `queued` or `running` per account. Finished jobs are not in the index, so an account can have any number of them (query Q16b).

### 4.22 `analysis_job_games`

Per-game progress of a job (`pending`, `analyzing`, `done`, `failed`) with the error of a failed game. Rows in the demo database: 80.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `job_id` | integer | no |  |
| `game_id` | integer | no |  |
| `status` | text | no | `'pending'` |
| `error` | text | yes |  |

- Primary key: `analysis_job_games_pkey` (job_id, game_id)
- Foreign keys:
  - `analysis_job_games_game_id_fkey`: `game_id` -> `games(id)`, ON DELETE CASCADE
  - `analysis_job_games_job_id_fkey`: `job_id` -> `analysis_jobs(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `job_id`, `game_id`, `status`; no CHECK constraints
- Indexes:
  - `analysis_job_games_pkey` btree (job_id, game_id): Primary key.

### 4.23 `account_summary`

Precomputed totals for one account (games, moves, inaccuracies, mistakes, blunders, average loss, accuracy, latest game). Derived; rebuilt by `refreshAccountSummary`. Rows in the demo database: 2.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `player_account_id` | integer | no |  |
| `total_games` | integer | no |  |
| `analyzed_games` | integer | no |  |
| `total_moves` | integer | no |  |
| `inaccuracies` | integer | no |  |
| `mistakes` | integer | no |  |
| `blunders` | integer | no |  |
| `avg_cp_loss` | double precision | no |  |
| `accuracy_pct` | double precision | no |  |
| `last_game_at` | timestamp(3) | yes |  |
| `refreshed_at` | timestamp(3) | no | `CURRENT_TIMESTAMP` |

- Primary key: `account_summary_pkey` (player_account_id)
- Foreign keys:
  - `account_summary_player_account_id_fkey`: `player_account_id` -> `player_accounts(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `player_account_id`, `total_games`, `analyzed_games`, `total_moves`, `inaccuracies`, `mistakes`, `blunders`, `avg_cp_loss`, `accuracy_pct`, `refreshed_at`; no CHECK constraints
- Indexes:
  - `account_summary_pkey` btree (player_account_id): Primary key.

### 4.24 `account_phase_summary`

Precomputed moves, blunders and average loss for one account and phase. Derived; rebuilt by `refreshAccountSummary`. Rows in the demo database: 6.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `player_account_id` | integer | no |  |
| `phase_id` | integer | no |  |
| `moves` | integer | no |  |
| `blunders` | integer | no |  |
| `avg_cp_loss` | double precision | no |  |

- Primary key: `account_phase_summary_pkey` (player_account_id, phase_id)
- Foreign keys:
  - `account_phase_summary_phase_id_fkey`: `phase_id` -> `phases(id)`, ON DELETE CASCADE
  - `account_phase_summary_player_account_id_fkey`: `player_account_id` -> `player_accounts(id)`, ON DELETE CASCADE
- Unique constraints: none besides the primary key
- Other constraints: NOT NULL on `player_account_id`, `phase_id`, `moves`, `blunders`, `avg_cp_loss`; no CHECK constraints
- Indexes:
  - `account_phase_summary_pkey` btree (player_account_id, phase_id): Primary key.

## 4.25 Index strategy in one paragraph

Write-heavy move tables (`moves`, `move_evals`, `move_mates`, `move_classifications`) carry only their primary key, plus `UNIQUE(game_id, ply)` on `moves`, because every extra index slows the bulk inserts. Analytics reads are served by the composite index `games(player_account_id, played_at)`, the primary keys of the one-to-one tables (joins by `move_id`) and the summary tables. `docs/explain/README.md` records the before and after plans for the two indexes added in `20261114161727_analytics_indexes` and the rejected candidates (`move_classifications(classification_id)`, `moves(game_id, mover_color)`, secondary indexes on `move_evals` and `move_mates`). Indexes that are not present and could matter at larger sizes: `analysis_job_games(game_id)` (deleting a game has to find its job rows, and the primary key starts with `job_id`), `puzzle_motifs(motif_id)` (the puzzle selection for a motif filters on it) and `training_plans(user_id)`.

## 4.26 Seed data

`prisma/seed/index.js` (run with `npm run seed`) loads the lookup tables with Prisma `upsert` calls, so running it twice changes nothing:

| Table | Rows seeded | Values |
|---|---:|---|
| `platforms` | 3 | lichess, chesscom, upload |
| `phases` | 3 | opening, middlegame, endgame |
| `classifications` | 5 | best, good, inaccuracy, mistake, blunder |
| `results` | 3 | win, loss, draw |
| `motifs` | 7 | hanging_piece, fork, pin, skewer, back_rank, discovered_attack, missed_mate |
| `time_controls` | 11 | 60+0, 60+1, 120+1, 180+0, 180+2, 300+0, 300+3, 600+0, 600+5, 900+10, 1800+0, with the category computed from `base + 40 x increment` seconds (under 180 bullet, under 480 blitz, under 1500 rapid, otherwise classical) |
| `openings` | 500 | every ECO code A00 to E99 with one name each, from `prisma/seed/openings.json` (lichess-org/chess-openings dataset, CC0) |

The seed does not load users, games or puzzles. The 50,000 puzzles and 16,600 puzzle-motif links in the demo database were loaded with `npm run import:puzzles -- <csv>` (`scripts/importPuzzles.js`), and the 80 games came from three Lichess import jobs run through the application (`analysis_jobs` rows 1 to 3). When the seed was run against an empty test database during this work it printed (last three lines):

```
Seeded motifs: 7
Seeded time controls: 11
Seeded openings: 500
```
