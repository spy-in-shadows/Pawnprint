# Longitudinal Chess Analytics Engine: Design Document

## 1. Goal

Ingest a player's games (Lichess, Chess.com, PGN upload), evaluate every move with Stockfish, store everything in a fully normalized PostgreSQL schema, aggregate it into longitudinal diagnostics (by opening, game phase, time pressure, tactical motif), and turn those diagnostics into a personalized puzzle training plan.

## 2. Tech stack (mapped to your syllabus)

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
- `player_accounts(id, user_id, platform_id, username, UNIQUE(platform_id, username))`
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
- `puzzles(id, lichess_id, fen, moves_uci, rating)`: imported from the Lichess puzzle CSV
- `puzzle_motifs(puzzle_id, motif_id)`: from the puzzle themes column
- `training_plans(id, user_id, created_at)`
- `training_plan_items(id, plan_id, puzzle_id, motif_id, reason_code, completed_at)`

### Jobs
- `analysis_jobs(id, player_account_id, status, attempts, max_games, failed_games, skipped_games, since, until, locked_by, locked_at, heartbeat_at, error, created_at, finished_at)`
- Partial unique index: `CREATE UNIQUE INDEX idx_analysis_jobs_active_unique ON analysis_jobs(player_account_id) WHERE status IN ('queued', 'running');` ensures only one active import job per account.
- `analysis_job_games(job_id, game_id, status, error)`: per-game progress so a crashed job can resume without re-analyzing completed games.

### Indexing guidance
- Heavy-write tables (`moves`, `move_evals`): only the PK and the one UNIQUE.
- Analytics indexes live on `games(player_account_id, played_at)`, `player_accounts(user_id)`, `move_motifs(motif_id)`, and `move_classifications(classification_id)`.
- All index decisions backed by `EXPLAIN ANALYZE` measurement stored in `docs/explain/`.

## 5. Write-amplification strategy

1. Parse one game into memory, then insert all its moves in **one** multi-row statement (`INSERT ... SELECT FROM unnest(...)`) via `pg`. One round trip per game, not per move.
2. Run each game's evaluation and persistence inside a single atomic transaction: all evals, mates, classifications, and motifs are buffered in memory and committed together. If a game fails mid-analysis, zero partial evals are written.
3. Do not update move rows after insert; evaluation rows are separate and written once.
4. Use `ON CONFLICT (platform_id, external_id) DO NOTHING` for idempotent re-imports.
5. Keep a small connection pool (`pg.Pool`, max about 10) shared by workers; Prisma is used for reads and low-volume writes.
6. Benchmark: ingest 10k synthetic games, compare per-row Prisma `create` (~4,577 moves/sec) vs `createMany` (~10,230 moves/sec) vs raw `unnest` bulk insert (~42,252 moves/sec), and record the numbers in the README.

## 6. Worker concurrency (isolation) & Engine Architecture

Claim a job atomically with `pg`:

```sql
UPDATE analysis_jobs
SET status = 'running', locked_by = $1, locked_at = (NOW() AT TIME ZONE 'UTC'), heartbeat_at = (NOW() AT TIME ZONE 'UTC'), attempts = attempts + 1
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE (status = 'queued' AND attempts < 3)
     OR (status = 'running' AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 minutes' AND attempts < 3)
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

### Engine Management & Resilience Rules:
- **One Persistent Engine per Worker**: Workers maintain a long-lived Stockfish process (`Threads=1`, `Hash=64`, fixed `depth=12`). `init()` is idempotent; concurrent calls await existing handshakes.
- **Dynamic Version Registration**: The engine's name and version are parsed dynamically from the `id name` line during the UCI handshake. `engine_versions` rows are immutable.
- **Position Eval Reuse (N+1 Calls)**: Each position is evaluated once. The previous move's "after" eval is reused as the next move's "before" eval (N+1 calls per N-ply game). The standard starting position eval is cached in memory per worker.
- **Terminal Positions Without Engine**: Checkmate and stalemate positions are identified using `chess.js` (`isCheckmate()` / `isStalemate()`) and resolved immediately without invoking Stockfish.
- **Every Eval from Stockfish**: Fallback static evals are forbidden. If Stockfish times out (10s limit) or crashes, the process is terminated and respawned.
- **Error Partitioning**:
  - **Data Errors** (illegal move, corrupt FEN, invalid PGN): Thrown as `DataError`, marks that single game as `failed` with reason in `analysis_job_games`; the game is not retried, and the job continues.
  - **Engine Errors** (crash, 10s timeout): Retried up to 3 times per job.
- **Standard Chess Filter**: Ingestion strictly accepts standard chess games (`startpos`). Non-standard variants (Chess960, etc.) and custom starting FENs are skipped and recorded in `skipped_games`.
- **User-Driven Cursor Sync**: Player accounts track `last_synced_at` as an incremental watermark. Users can optionally specify `since` and `until` date ranges (`since <= until`).
- **Heartbeat & Poison Recovery**: Workers update `heartbeat_at` every 25 seconds. Sweeper marks jobs exceeding 3 attempts as `failed`.

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
- Time pressure: `time_pressure = clock_remaining_ms < 10% of base time`.

## 8. Analytics queries (the product value)

Exposed as REST endpoints, implemented with Prisma and raw SQL:

1. **Opening blunder rate:** blunders per 100 moves grouped by opening and by ply bucket (1-10, 11-20, 21-30, 31+).
2. **Phase accuracy:** average accuracy and cp_loss by phase.
3. **Time decay:** blunder rate by clock-remaining bucket (>50%, 25-50%, 10-25%, <10%).
4. **Trend over time:** rolling 7-day average of accuracy and daily cp_loss (window function).
5. **Motif weakness:** tactical motif errors, reporting `errors_per_100_moves` as a player move-frequency metric (errors per 100 player moves played).
6. **Point-in-time:** every query accepts `from` and `to` date filters.

## 9. Tactical motif tagging

Evaluated strictly on mistakes and blunders (`classification IN ('mistake', 'blunder')`):
- **Precision & Best Reply Tie-in**: Motif tags are strictly tied to Stockfish's actual best reply (`bestReplyUci`); speculative candidate moves are forbidden.
- **Kind Separation**: Tags distinguish between `kind='allowed'` (player move created a vulnerability or opponent best reply exploited it) and `kind='missed'` (player's best move would have executed the motif).
- **Supported Motifs**: `hanging_piece`, `fork`, `pin`, `skewer`, `back_rank`, `missed_mate`.
- **False-Positive Prevention**: Existing pins and skewers present before the move are ignored unless newly created or actively exploited by the opponent's best reply.

## 10. Training plan generation

1. Find the user's top 3 weakest motifs and top 2 weakest opening/phase combinations (`getWeakestOpeningPhases` requires minimum 20 moves per combination; no baseline fillers).
2. Select puzzles from `puzzles` joined through `puzzle_motifs` matching weaknesses within rating band $[rating - 250, rating + 250]$.
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

POST   /api/v1/imports                    enqueue import (platform fetch or PGN upload)
GET    /api/v1/imports/:id                job status and progress
POST   /api/v1/uploads/pgn                multipart PGN upload

GET    /api/v1/games                      ?accountId&from&to&opening&page
GET    /api/v1/games/:id                  game with moves and evals

GET    /api/v1/analytics/openings
GET    /api/v1/analytics/phases
GET    /api/v1/analytics/time-pressure
GET    /api/v1/analytics/trend
GET    /api/v1/analytics/motifs

GET    /api/v1/training/plans
POST   /api/v1/training/plans             generate a new plan
PATCH  /api/v1/training/plans/:planId/items/:itemId
GET    /api/v1/health
```

Middleware chain: `requestLogger` -> `express.json` -> `rateLimit` (simple, hand-written) -> route-level `authenticate` -> controller -> `errorHandler`.

## 12. Folder structure (MVC)

```
chess-analytics/
  ENGINEERING.md
  DESIGN.md
  docker-compose.yml
  .env.example
  package.json
  prisma/
    schema.prisma
    migrations/
    seed/ (platforms, phases, classifications, motifs, openings)
  src/
    server.js
    worker.js
    app.js
    config/        env.js, db.js (Prisma + pg Pool)
    routes/        v1/index.js, auth.routes.js, ...
    controllers/   auth.controller.js, health.controller.js, ...
    services/      auth, import, analysis, analytics, training, health
    repositories/  game.repo.js (Prisma), moveBulk.repo.js (pg), analytics.repo.js
    middleware/    authenticate.js, errorHandler.js, requestLogger.js, rateLimit.js
    workers/       jobQueue.js, jobRunner.js, events.js
    chess/         pgnParser.js, stockfishClient.js, evalMath.js, phase.js, motifs.js
    ingest/        lichessClient.js, chesscomClient.js
  tests/
    evalMath.test.js, claim.concurrency.test.js, parser.test.js, platformImport.test.js,
    motifsAndTraining.test.js, stockfishResilience.test.js, auth.test.js, poisonJobs.test.js
  scripts/
    importPuzzles.js, seedOpenings.js, benchmarkInsert.js, generateSyntheticGames.js
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

1. `stockfishResilience`: Tests 10s per-position timeout, unexpected process crash handling, `hasCrashedTooManyTimes`, idempotent `init()`, and ordering of UCI handshake options.
2. `evalMath`: Unit tests for perspective, sigmoid accuracy, loss clamping at 1000 cp, explicit delivered mate, and mate distance progression.
3. `platformImport`: Atomic game transactions, cursor progression, retry on engine failure vs. single-game abort on data error, and variant/custom FEN skipping.
4. `motifsAndTraining`: Pin and skewer precision, false-positive checks, missed mate distance maintenance, Black-side mate handling, and Lichess puzzle sequence execution with wrong-move snapback.
5. `claim.concurrency`: Concurrency test with 3 concurrent workers claiming 40 jobs with zero collisions using `SKIP LOCKED`.
6. `auth`: Comprehensive 404 security checks asserting User A cannot access User B's games, accounts, imports, analytics, or training plans.

## 15. Key Architectural Decisions

- **Stockfish throughput**: Fixed depth 12 with 1 thread and 64 MB hash per worker provides predictable, low-latency analysis while preserving high tactical accuracy.
- **No Embedded Evals**: Every eval is produced by the engine during analysis to ensure uniform depth, consistent search parameters, and authoritative evaluations.
- **Rate limiting on platforms**: Ingest sequentially with polite delays to respect Lichess/Chess.com public API limits.
