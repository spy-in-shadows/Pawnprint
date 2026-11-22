# Longitudinal Chess Analytics Engine: Design Document

## 1. Goal

Ingest a player's games (Lichess, Chess.com, PGN upload), evaluate every move with Stockfish, store everything in a fully normalized PostgreSQL schema, aggregate it into longitudinal diagnostics (by opening, game phase, time pressure, tactical motif), and turn those diagnostics into a personalized puzzle training plan.

## 2. Tech stack (mapped to the course syllabus)

| Layer | Choice | Syllabus topic |
|---|---|---|
| Runtime | Node.js 20+, ES Modules | Modules, async, runtime |
| HTTP | Express.js, Router, middleware | Express, Middleware, REST |
| Structure | MVC (routes, controllers, services, models/repositories) | MVC |
| ORM | Prisma (schema, migrations, CRUD, reads, aggregates) | Prisma |
| Raw DB | `pg` Pool for hot paths | Drivers, connection pooling |
| Auth | JWT (access token), bcrypt, auth middleware | Auth/JWT |
| Files/IO | `fs`, `path`, `readline` streams for PGN parsing | fs, readline, streams |
| Events | `EventEmitter` for job lifecycle events | EventEmitter |
| Engine | Stockfish via `child_process.spawn`, UCI over stdio | Streams, events |
| Frontend | React + Vite + a chart library (Recharts) | beyond syllabus |
| Infra | Docker Compose for Postgres | n/a |

## 3. High-level architecture

```
React SPA  --HTTP/JSON-->  Express API (MVC)  --Prisma/pg-->  PostgreSQL
                                |                                   ^
                                | enqueue job rows                  | claim jobs (SKIP LOCKED)
                                v                                   |
                           analysis_jobs table  <----------  Worker processes (N)
                                                              |-- PGN parser (streams)
                                                              |-- Stockfish child process
                                                              |-- bulk insert via pg
```

Two separate Node entry points share the same code and database:
- `src/server.js`: the API.
- `src/worker.js`: a worker. Run several of them to demonstrate safe concurrency.

## 4. Database schema (normalized)

Design rules: no JSON blobs for move data, no wide NULL-filled rows, every repeated string lives in a lookup table, and write-heavy tables stay narrow with few indexes.

### Identity
- `users(id, email, password_hash, created_at)`
- `player_accounts(id, user_id, platform_id, username, last_synced_at, created_at, UNIQUE(platform_id, username))`
- `platforms(id, name)`: lichess, chesscom, upload

### Games
- `openings(id, eco, name)`: seeded from an ECO dataset
- `games(id, player_account_id, platform_id, external_id, played_at, color, result_id, opening_id, time_control_id, player_rating, opponent_rating, total_plies, analysis_status, failure_reason, UNIQUE(platform_id, external_id))`
- `results(id, code)`: win, loss, draw
- `time_controls(id, base_seconds, increment_seconds, category)`: bullet, blitz, rapid, classical, correspondence

### Moves (one row per ply, narrow and insert-only)
- `moves(id, game_id, ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id, UNIQUE(game_id, ply))`
- `phases(id, name)`: opening, middlegame, endgame

### Evaluations (separate table, so moves stay immutable)
- `move_evals(move_id PRIMARY KEY, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)`
- `move_mates(move_id PRIMARY KEY, mate_before, mate_after)`: **only rows for positions with forced mate**. This keeps `move_evals` free of NULLs.
- `move_classifications(move_id PRIMARY KEY, classification_id, cp_loss)`: derived after evaluation
- `classifications(id, name)`: best, good, inaccuracy, mistake, blunder
- `engine_versions(id, name, version, default_depth, threads, hash_size, UNIQUE(name, version, default_depth, threads, hash_size))`: **strictly immutable**; new combinations insert a new row without updates.

### Tactics
- `motifs(id, name)`: fork, pin, skewer, hanging piece, back rank, discovered attack, missed mate, etc.
- `move_motifs(move_id, motif_id, kind, PRIMARY KEY(move_id, motif_id, kind))`: records tactical motifs with `kind='allowed'` (player's move allowed an opponent tactic) or `kind='missed'` (player's best move would have executed a tactic/mate).

### Training
- `puzzles(id, lichess_id UNIQUE, fen, moves_uci, rating, phase_tag)`: imported from the Lichess puzzle CSV
- `puzzle_motifs(puzzle_id, motif_id)`: from the puzzle themes column
- `training_plans(id, user_id, created_at)`
- `training_plan_items(id, plan_id, puzzle_id, motif_id, reason_code, completed_at)`

### Jobs
- `analysis_jobs(id, player_account_id, status, attempts, max_games, failed_games, skipped_games, since, until, locked_by, locked_at, heartbeat_at, error, created_at, finished_at)`
- Partial unique index: `CREATE UNIQUE INDEX idx_analysis_jobs_active_unique ON analysis_jobs(player_account_id) WHERE status IN ('queued', 'running');` ensures only one active import job per account.
- `analysis_job_games(job_id, game_id, status, error)`: per-game progress (`pending`, `analyzing`, `done`, `failed`). A reclaimed job only analyzes games whose `analysis_status` is still `pending`, so completed games are never re-analyzed.

### Summaries
- `account_summary(player_account_id PK, total_games, analyzed_games, total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct, last_game_at, refreshed_at)`
- `account_phase_summary(player_account_id, phase_id, moves, blunders, avg_cp_loss, PRIMARY KEY(player_account_id, phase_id))`
- Rebuilt per account by `refreshAccountSummary` when a job completes; they count only the owner's moves in analyzed games.

### Constraints
- Every table has a primary key; foreign keys use `ON DELETE CASCADE` for ownership (user -> accounts -> games -> moves -> evaluations), `RESTRICT` for lookups in use and `SET NULL` for optional lookups.
- Unique keys make imports idempotent and stop duplicates: `games(platform_id, external_id)`, `player_accounts(platform_id, username)`, `moves(game_id, ply)`, `users(email)`, natural keys of the lookups, and the partial unique index on active jobs above.
- CHECK constraints (migration `20261122161952_add_check_constraints`, not modelled by Prisma; listed in comments in `prisma/schema.prisma`):
  - value sets: `games.color` and `moves.mover_color` in (`white`, `black`); `games.analysis_status` in (`pending`, `analyzed`, `failed`); `analysis_jobs.status` in (`queued`, `running`, `completed`, `failed`); `analysis_job_games.status` in (`pending`, `analyzing`, `done`, `failed`); `move_motifs.kind` in (`allowed`, `missed`); `time_controls.category` in (`bullet`, `blitz`, `rapid`, `classical`, `correspondence`).
  - ranges: `moves.ply > 0`; `games.total_plies`, clocks, time spent, time-control seconds, `cp_loss`, job counters and summary counts and averages `>= 0`; game ratings `>= 0` and puzzle ratings `> 0`; `move_evals.depth >= 0` (terminal positions use depth 0); engine depth, threads and hash `> 0`; `analysis_jobs.max_games > 0`; `since <= until` when both are set; `account_summary.accuracy_pct` between 0 and 100.
- Rules that need other rows, other tables or chess logic stay in the application and in the data-quality checks (`src/workers/dataQuality.js`): the `reason_code` format, depth 0 paired with `best_uci = 'none'`, one name per ECO code, `games.platform_id` equal to the account's platform, and move consistency (mover colour, SAN and UCI against the FEN).

### Indexing guidance
- Heavy-write tables (`moves`, `move_evals`): only the PK and the one UNIQUE.
- `analysis_jobs(status, created_at)` serves the claim query's `ORDER BY created_at` over queued and stale running jobs; besides the primary key, the only other index on the jobs table is the partial unique index above.
- Analytics indexes live on `games(player_account_id, played_at)`, `player_accounts(user_id)` and `move_motifs(motif_id)`. `move_classifications(classification_id)` has no index: the plans in `docs/explain/` join it by `move_id` (its primary key).
- All index decisions backed by `EXPLAIN ANALYZE` measurement stored in `docs/explain/`. At the measured 10k-game size the two added indexes made no measurable difference (REPORT.md section 5); they are kept for multi-user scale.

## 5. Write-amplification strategy

1. Parse one game into memory, then insert all its moves in **one** multi-row statement (`INSERT ... SELECT FROM unnest(...)`) via `pg`. One round trip per game, not per move.
2. Run each game's evaluation and persistence inside a single atomic transaction: all evals, mates, classifications, and motifs are buffered in memory and committed together. If a game fails mid-analysis, zero partial evals are written.
3. Do not update move rows after insert; evaluation rows are separate and written once.
4. Use `ON CONFLICT (platform_id, external_id) DO NOTHING` for idempotent re-imports.
5. Keep a small connection pool (`pg.Pool`, max about 10) shared by workers; Prisma is used for reads and low-volume writes.
6. Benchmark (`npm run bench`): synthetic 40-ply games, per-row Prisma `create` (~1,587 moves/sec) vs `createMany` (~10,203 moves/sec) vs raw `unnest` bulk insert (~13,033 moves/sec) on 1,000 games, plus a 10,000-game `unnest` run. Numbers and machine details are in REPORT.md section 3.

## 6. Worker concurrency (isolation) & Engine Architecture

Claim a job atomically with `pg`:

```sql
UPDATE analysis_jobs
SET status = 'running', locked_by = $1, locked_at = (NOW() AT TIME ZONE 'UTC'), heartbeat_at = (NOW() AT TIME ZONE 'UTC'), attempts = attempts + 1
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE (status = 'queued' AND attempts < 3)
     OR (status = 'running' AND attempts < 3
         AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2))
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`$2` is `JOB_STALE_SECONDS` (default 120). `claimNextJob` runs `sweepPoisonJobs` first, which fails queued or stale jobs that already reached 3 attempts.

### Engine Management & Resilience Rules:
- **One Persistent Engine per Worker**: Workers maintain a long-lived Stockfish process (`Threads=1`, `Hash=64`, fixed `depth=12`). `init()` is idempotent; concurrent calls await existing handshakes.
- **Dynamic Version Registration**: The engine's name and version are parsed dynamically from the `id name` line during the UCI handshake. `engine_versions` rows are immutable.
- **Position Eval Reuse (N+1 Calls)**: Each position is evaluated once. The previous move's "after" eval is reused as the next move's "before" eval (N+1 calls per N-ply game). The standard starting position eval is cached in memory per worker.
- **Terminal Positions Without Engine**: Positions that end the game are identified with `chess.js` and resolved without invoking Stockfish: checkmate gives `mate_after = 0` and `±MATE_CP`; stalemate, threefold repetition and the fifty-move rule give 0 cp. So a game that ends in mate makes N engine calls instead of N+1.
- **Every Eval from Stockfish**: Fallback static evals are forbidden. If Stockfish times out (10s per command) or crashes, the pending requests are rejected with `EngineError` and the next `init()` spawns a new process.
- **Error Partitioning**:
  - **Data Errors** (illegal move, corrupt FEN, invalid PGN): Thrown as `DataError`, marks that single game as `failed` with reason in `analysis_job_games`; the game is not retried, and the job continues.
  - **Engine Errors** (crash, 10s timeout): the game is retried up to 3 times on a restarted engine; after the third failure the job is marked `failed`. Games saved before that stay `analyzed`.
- **Standard Chess Filter**: Ingestion strictly accepts standard chess games (`startpos`). Non-standard variants (Chess960, etc.) and custom starting FENs are skipped and recorded in `skipped_games`.
- **User-Driven Cursor Sync**: Imports run only when the user asks. Player accounts track `last_synced_at` as an incremental watermark; a job's optional `since` replaces it as the start of the fetch and `until` bounds the end (`since <= until`). After a completed job the cursor moves to the newest stored game and never moves backwards.
- **One Active Job per Account**: the partial unique index above; `createImportJob` returns the existing queued or running job instead of creating a second one.
- **Heartbeat & Poison Recovery**: Workers update `heartbeat_at` every 25 seconds. A job whose heartbeat is older than `JOB_STALE_SECONDS` is reclaimed by the next worker; the sweeper marks jobs that reached 3 attempts as `failed`.
- **After each job**: the worker rebuilds the account's summary rows, advances the cursor and runs the data-quality checks for the account. A failure in any of these is logged and does not change the job's `completed` status.

## 7. Evaluation mathematics

All stored evals are **from White's perspective** in centipawns. For analysis, convert to the **mover's perspective**.

- `perspective(cp, color) = color == white ? cp : -cp`
- Forced mate: Stockfish returns `mate N` (positive = side to move mates). Map to a bounded score so arithmetic stays continuous:
  - `mate_to_cp(n) = sign(n) * max(1000, MATE_CP - |n| * 10)` with `MATE_CP = 10000`, so a faster mate scores higher and even a very long mate never drops below the ±1000 cp cap. Delivered mate is explicitly signed by mover color (`+MATE_CP` for White, `-MATE_CP` for Black).
  - Raw mate distance is stored in `move_mates`.
- **cp_loss** for a move = `perspective(eval_before) - perspective(eval_after)`, clamped at 0 from below.
- Cap evals at ±1000 cp for loss calculation so blunders in already-decided positions are not over-penalized.
- **Win probability** (for fair classification): `wp = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`, computed on the capped eval. Classify on the **win-probability drop** (rounded to 2 decimals), not raw cp.
  - Best: $\Delta WP < 1\%$
  - Good: $1\% \le \Delta WP < 5\%$
  - Inaccuracy: $5\% \le \Delta WP < 10\%$
  - Mistake: $10\% \le \Delta WP < 20\%$
  - Blunder: $\Delta WP \ge 20\%$
- **No early-ply masking:** classify **every** ply, including moves 1 to 10.
- Phase assignment (`src/chess/phase.js`), checked in order: endgame = total non-pawn, non-king material for both sides $\le 24$ (N=3, B=3, R=5, Q=9; the start position is 62); opening = ply $\le 20$ and both sides still have a queen; middlegame = everything else.
- Time pressure: `time_pressure = clock_remaining_ms < 10% of base time`. Moves without a clock or with a base time of 0 are left out of the time-pressure buckets and reported as `excludedMoves`.

## 8. Analytics queries (the product value)

Exposed as REST endpoints, implemented with Prisma and raw SQL:

1. **Opening blunder rate:** blunders per 100 moves grouped by opening and by ply bucket (1-10, 11-20, 21-30, 31+).
2. **Phase accuracy:** average accuracy and cp_loss by phase.
3. **Time decay:** blunder rate by clock-remaining bucket (>50%, 25-50%, 10-25%, <10%).
4. **Trend over time:** rolling 7-day average of accuracy and daily cp_loss (window function).
5. **Motif weakness:** tactical motif errors, reporting `errorsPer100Moves` as a move-frequency rate (errors per 100 of the owner's moves played across the user's analyzed games), not an opportunity-normalized rate.
6. **Point-in-time:** every query accepts `from` and `to` date filters (and `accountId`).
7. **Summary:** `GET /analytics/summary` reads the precomputed `account_summary` and `account_phase_summary` rows; it does not aggregate the base tables.

Every analytics query counts only the account owner's moves (`moves.mover_color = games.color`) in games with `analysis_status = 'analyzed'`.

## 9. Tactical motif tagging

Evaluated strictly on mistakes and blunders (`classification IN ('mistake', 'blunder')`):
- **Precision & Best Reply Tie-in**: Motif tags are strictly tied to Stockfish's actual best reply (`bestReplyUci`); speculative candidate moves are forbidden.
- **Kind Separation**: Tags distinguish between `kind='allowed'` (player move created a vulnerability or opponent best reply exploited it) and `kind='missed'` (player's best move would have executed the motif).
- **Supported Motifs**: `hanging_piece`, `fork`, `pin`, `skewer`, `back_rank`, `discovered_attack`, `missed_mate`. `missed_mate` follows the same mistake/blunder gate as the board motifs.
- **Rule-based**: detection is board geometry on the position after the move and after Stockfish's single best reply; it does not search further lines.
- **False-Positive Prevention**: Existing pins and skewers present before the move are ignored unless newly created or actively exploited by the opponent's best reply.

## 10. Training plan generation

1. Find the user's top 3 weakest motifs and top 2 weakest opening/phase combinations (`getWeakestOpeningPhases` requires minimum 20 moves per combination; no baseline fillers). With no weakness found, an empty plan is stored with a message asking for more analyzed games.
2. Select up to 3 puzzles per weakness from `puzzles` (joined through `puzzle_motifs` for motifs, by `phase_tag` for opening/phase combinations) within rating band $[rating - 250, rating + 250]$, where rating is the average player rating of the user's last 20 analyzed games (1500 when there is none). Puzzles the user already completed and puzzles already in the plan are skipped.
3. **Lichess Puzzle CSV Convention**: In Lichess puzzle CSV files, `FEN` is the position BEFORE the opponent's setup move, and `Moves[0]` is that opponent move. The solver applies `Moves[0]` automatically, orients for the solver's turn, and evaluates user moves against `Moves[1..]`.
4. Persist `training_plans` and `training_plan_items` with a structured `reason_code`.

## 11. API surface (v1, REST, resource-based)

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/me

GET    /api/v1/accounts
POST   /api/v1/accounts                   link a Lichess/Chess.com username
DELETE /api/v1/accounts/:id

POST   /api/v1/imports                    enqueue a platform import {accountId, maxGames, since, until}
GET    /api/v1/imports/:id                job status and progress
POST   /api/v1/uploads/pgn                multipart PGN upload (field `file`, optional `accountId`); stores the games and enqueues a job

GET    /api/v1/games                      ?accountId&from&to&opening&page
GET    /api/v1/games/:id                  game with moves and evals

GET    /api/v1/analytics/openings
GET    /api/v1/analytics/phases
GET    /api/v1/analytics/time-pressure
GET    /api/v1/analytics/trend
GET    /api/v1/analytics/motifs
GET    /api/v1/analytics/summary          precomputed per-account rollups

GET    /api/v1/training/plans
POST   /api/v1/training/plans             generate a new plan
PATCH  /api/v1/training/plans/:planId/items/:itemId
GET    /api/v1/health
```

Middleware chain: `requestLogger` -> `express.json` -> `rateLimit` (simple, hand-written; a stricter limiter on `/auth`) -> route-level `authenticate` -> controller -> `notFoundHandler` / `errorHandler`. `GET /health` is also served outside `/api/v1`, and the built client is served from `client/dist` with an SPA fallback for non-API GET requests.

## 12. Folder structure (MVC)

```
Pawnprint/
  ENGINEERING.md, DESIGN.md, REPORT.md, README.md
  docker-compose.yml, .env.example, package.json, vitest.config.js
  prisma/
    schema.prisma
    migrations/
    seed/          index.js, openings.json (platforms, results, phases, classifications, motifs, time controls, openings)
  src/
    server.js, worker.js, app.js
    config/        env.js, db.js (Prisma + pg Pool)
    routes/        v1/index.js, auth, accounts, imports, uploads, games, analytics, training
    controllers/   auth, account, import, upload, game, analytics, training, health
    services/      auth, account, import, upload, games, analytics, summary, training, drill, health
    repositories/  user.repo.js, game.repo.js, training.repo.js (Prisma), moveBulk.repo.js, analytics.repo.js (pg)
    middleware/    authenticate.js, errorHandler.js, requestLogger.js, rateLimit.js
    workers/       jobQueue.js, jobRunner.js, gameAnalyzer.js, engineRegistry.js, dataQuality.js, events.js
    chess/         pgnParser.js, stockfishClient.js, evalMath.js, phase.js, fen.js, motifs.js
    ingest/        lichessClient.js, chesscomClient.js, standardChess.js
    utils/         errors.js, logger.js
  tests/           one file per module or route group, plus integration.test.js (full pipeline)
  scripts/         importPuzzles.js, dataQuality.js, benchmarkInsert.js, benchmarkThroughput.js,
                   benchmarkQueries.js, explainAnalytics.js
  docs/            CONTRACTS.md, DEV_LOG.md, explain/, benchmarks/
  client/          React + Vite app
```

## 13. Build phases

1. **Foundation:** repo, Docker Compose Postgres, Prisma schema + migrations, seed scripts, Express skeleton with MVC, env config, health endpoint.
2. **Auth:** register, login, JWT middleware, `/me`, tests.
3. **Ingestion:** PGN parser (stream with `fs` + `readline`), Lichess and Chess.com clients, upload endpoint, bulk insert repo, idempotency, benchmark script.
4. **Workers:** job table, claim query, heartbeat, retries, EventEmitter events, concurrency test with 3 workers.
5. **Engine and eval math:** Stockfish UCI client, `evalMath.js` with unit tests, classification, phase assignment.
6. **Analytics:** the five endpoints, plus `EXPLAIN ANALYZE` pass and index tuning.
7. **Motifs and training:** motif tagger, puzzle import, plan generator, endpoints.
8. **React frontend:** auth pages, account linking, live import progress, dashboard charts, game viewer, training plan page.
9. **Polish:** README with architecture diagram, benchmark results, test coverage notes, demo seed data.

## 14. Testing priorities & invariants

Tests that need the Stockfish binary skip themselves with a message when `STOCKFISH_PATH` does not exist; everything else runs against a real Postgres.

1. `stockfish`, `stockfishResilience`: UCI handshake and option order, engine name and version from `id name`, 10s per-command timeout, crash handling, `hasCrashedTooManyTimes`, idempotent `init()`.
2. `evalMath`, `phase`, `fen`: perspective, win-probability classification, loss clamping at 1000 cp, delivered mate signed by the mover, mate distance progression, phase thresholds.
3. `parser`, `import.service`, `moveBulk`, `uploads`: PGN parsing, idempotent ingestion, variant and custom-FEN skipping, atomic per-game writes.
4. `jobRunner`, `gameAnalyzer`: N+1 engine calls, terminal positions without the engine, cursor progression, engine-error retry vs single-game failure on a data error.
5. `claim.concurrency`, `jobQueue`, `poisonJobs`, `crashRecovery`: 3 concurrent workers claim 40 jobs with zero collisions; dead-worker reclaim, engine kill mid-game, poison jobs, double delivery, clean shutdown.
6. `motifs`, `training`, `drill`, `importPuzzles`: pin and skewer precision and false-positive guards, missed mate, Black-side mates, plan generation, Lichess puzzle convention.
7. `analytics`, `summary`, `dataQuality`: endpoint maths, rollup tables, every data-quality check.
8. `auth`, `accounts`, `games` and the route tests: user A gets 404 for user B's accounts, games, jobs, analytics and plans.
9. `integration`: register, link an upload account, upload a 3-game PGN, analyze it with an in-process worker and the real engine, read games, analytics and a training plan over HTTP, and check data quality.

## 15. Key Architectural Decisions

- **Stockfish throughput**: Fixed depth 12 with 1 thread and 64 MB hash per worker provides predictable, low-latency analysis while preserving high tactical accuracy.
- **No Embedded Evals**: Every eval is produced by the engine during analysis to ensure uniform depth, consistent search parameters, and authoritative evaluations.
- **Rate limiting on platforms**: Ingest sequentially with polite delays (200 ms by default) to respect Lichess/Chess.com public API limits.
- **Standard chess only**: variants and custom starting positions are skipped at ingestion, so every stored game replays from the standard start position.
- **Summary tables over materialized views**: the rollups are plain tables rebuilt per account at job completion, so a dashboard read is a primary-key lookup and the refresh cost is paid once per import.
