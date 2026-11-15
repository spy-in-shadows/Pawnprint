# Longitudinal Chess Analytics Engine: Final Report

## 1. Problem and design
A single game tells a player little; patterns across hundreds of games (which openings go wrong, whether accuracy drops in the endgame or under time pressure, which tactics keep being missed) need every move of every game evaluated the same way and stored so it can be queried over time.

The system imports a player's games from Lichess, Chess.com or a PGN upload, evaluates every ply with Stockfish, stores the results in a normalized PostgreSQL schema and serves longitudinal analytics and a puzzle training plan over a REST API with a React client.

- **Two processes, one database.** The Express API (`src/server.js`) only enqueues `analysis_jobs` rows. Workers (`src/worker.js`, any number) claim them with a single `UPDATE ... FOR UPDATE SKIP LOCKED` statement, keep a heartbeat, and a stale job is reclaimed by another worker. One active job per account is enforced by a partial unique index.
- **Engine.** Each worker keeps one persistent Stockfish process (Threads 1, Hash 64 MB, fixed depth 12). The engine name and version come from the UCI handshake and are stored in immutable `engine_versions` rows. Every eval comes from Stockfish, never from a fallback. Each position is searched once, so an N-ply game needs N+1 engine calls, and positions that end the game are resolved with chess.js without the engine.
- **Storage.** Moves go in with one `UNNEST` insert per game. Evals, mates, classifications and motif tags live in separate narrow tables and are written in one transaction when the game's analysis finishes, so a failed game leaves no partial rows. Data errors fail one game without retry; engine errors are retried 3 times on a restarted engine.
- **Analysis.** Stored evals are White-perspective centipawns. Moves are classified on the drop in win probability, phases come from material and ply, and rule-based motif tags are tied to Stockfish's best reply (`allowed` or `missed`).
- **Product.** Analytics endpoints for openings, phases, time pressure, trend and motifs aggregate the owner's moves; per-account summary tables serve the dashboard; the training plan picks Lichess puzzles that match the weakest motifs and opening/phase combinations.

DESIGN.md is the full design; ENGINEERING.md lists the decisions and rules.

## 2. Team and workflow
| Person | Area |
|---|---|
| A (07shlokjoshi) | Infrastructure and CI, config and logging, schema and seeds, PGN parser, bulk insert repository, platform clients and import service, insert benchmark, puzzle importer |
| B (spy-in-shadows, repository owner) | Eval maths, phases, FEN validation, Stockfish client, job queue, game analyzer and job runner, data-quality checks, motif detection, crash-recovery tests, throughput benchmark, end-to-end test, design documents |
| C (Shailja-Vatsa) | Auth and games endpoints, analytics endpoints, accounts, imports and uploads, training plans and middleware, query evidence and summary tables, React client |

**Workflow.** Each PR was built on its own branch from a short sequence of prompts, rebased onto `main` before review and merged with a rebase merge after another team member approved it. `docs/CONTRACTS.md` fixed every cross-owner module signature up front, so work in one area could start before the modules it called existed; signature changes needed B's approval. `scripts/preflight.sh` checked each commit and branch for files outside the author's area, debug output and style problems before it was pushed. Non-trivial problems went into `docs/DEV_LOG.md`.

**Merged PRs, in merge order (waves by dependency).**

| Wave | PR | Title | Merged |
|---|---|---|---|
| 1. Foundation | #1 | PR-B1: Evaluation math, phase classifier and FEN validation | 2026-11-11 |
| | #3 | PR-A1: Infrastructure, config loader, logging and CI | 2026-11-12 |
| | #4 | PR-B2: Stockfish UCI client and resilience | 2026-11-12 |
| | #5 | PR-A2: Database schema, seeds, Prisma client and pg pool | 2026-11-12 |
| | #2 | PR-C6: Client scaffold, auth pages, accounts and import views | 2026-11-12 |
| 2. Ingestion and API | #6 | PR-A3: Streaming PGN parser and transactional bulk repository | 2026-11-12 |
| | #7 | PR-C1: Authentication and games endpoints | 2026-11-12 |
| | #8 | PR-B3: Postgres job queue and concurrency test | 2026-11-13 |
| | #9 | Audit fixes after round 3 | 2026-11-13 |
| | #10 | PR-C3: Analytics endpoints | 2026-11-13 |
| | #11 | PR-A4: Platform clients and import service | 2026-11-13 |
| 3. Pipeline and product | #12 | PR-B4: Game analyzer, job runner and error partitioning | 2026-11-13 |
| | #13 | PR-C3: Accounts, imports and PGN upload | 2026-11-13 |
| | #14 | PR-C5: Training plans, health, middleware and static serving | 2026-11-13 |
| 4. Quality and performance | #15 | PR-B5: Data-quality checks and tactical motif detection | 2026-11-14 |
| | #16 | PR-A5: Insert benchmark and puzzle importer | 2026-11-14 |
| | #17 | PR-C4: Query evidence, indexes, summary tables and query benchmark | 2026-11-14 |
| 5. Verification | #18 | PR-B6: Crash-recovery tests, throughput benchmark and end-to-end test | 2026-11-14 |
| | #19 | PR-C7: Dashboard, game viewer and training page | 2026-11-14 |
| | #20 | PR-B7: Final audit Person B | 2026-11-15 |

## 3. Schema and insert benchmark

### Database Schema Design
The engine stores historical chess game trajectories in PostgreSQL using a normalized schema managed with Prisma:
- **`games`**: Stores game metadata including player account reference (`player_account_id`), platform (`platform_id`), external platform ID (`external_id`), played timestamp, player color, game result reference (`result_id`), opening classification (`opening_id`), time control reference (`time_control_id`), and analysis status (`pending`, `analyzed`, `failed`; per-job progress, including `analyzing`, lives in `analysis_job_games`). Idempotency is enforced by a unique index on `(platform_id, external_id)`.
- **`moves`**: Represents individual move plies belonging to a game (`game_id`, `ply`, `san`, `uci`, `fen_before`, `mover_color`, `clock_remaining_ms`, `time_spent_ms`, `phase_id`). Plies are uniquely constrained on `(game_id, ply)`.
- **`move_evals`**, **`move_mates`**, **`move_classifications`**, **`move_motifs`**: Store engine evaluations, mate distances, accuracy classifications, and tactical motifs detected per move.
- **Cascades and Integrity**: Deletion cascades from `users` through `player_accounts` down to `games` and `moves`, allowing atomic cleanup of accounts and games while maintaining strict relational integrity.

### Ingestion Write Amplification & UNNEST Ingestion
A typical chess game contains 40 to 80 plies. Naive object-relational mapping (ORM) insertions process each ply as an isolated `INSERT` query. In a 40-move game, this requires 41 round trips over the database connection and 41 write-ahead log (WAL) flushes.

To eliminate write amplification, `src/repositories/moveBulk.repo.js` implements `insertGameWithMoves(accountId, parsedGame)` using PostgreSQL `UNNEST` over parallel typed arrays:
```sql
INSERT INTO moves (
  game_id, ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id
)
SELECT
  $1, u.ply, u.san, u.uci, u.fen_before, u.mover_color, u.clock_remaining_ms, u.time_spent_ms, u.phase_id
FROM UNNEST(
  $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[]
) AS u(ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id);
```
This collapses all moves of a game into a single SQL statement inside a single transaction, requiring exactly 1 round trip and 1 WAL flush per game.

### Benchmark Methodology and Results
We evaluated move insertion throughput across three ingestion strategies on Apple M4 (10 cores), 16 GB RAM, Node.js v26.13.0, and PostgreSQL 16.15 using deterministic synthetic games (40 plies per game):
1. **Prisma create (per-row)**: Sequential per-move row insertions via Prisma Client.
2. **Prisma createMany**: Batch-inserting all moves of a game via Prisma `createMany`.
3. **pg UNNEST (`insertGameWithMoves`)**: Transactional bulk insertion using PostgreSQL typed arrays and `UNNEST`.

#### Comparative Benchmark (1,000 Games / 40,000 Plies)
| Strategy | Games | Plies / Game | Total Plies | Duration | Moves / sec | Speedup |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| Prisma create (per-row) | 1,000 | 40 | 40,000 | 25.21s * | 1,587 | 1.0x (baseline) |
| Prisma createMany | 1,000 | 40 | 40,000 | 3.92s | 10,203 | 6.4x |
| pg UNNEST (insertGameWithMoves) | 1,000 | 40 | 40,000 | 3.07s | 13,033 | 8.2x |

\* Extrapolated from 500-game sample (12.61s).

#### Scale Validation (10,000 Games / 400,000 Plies)
We executed the full scale ingestion run using the `unnest` strategy across 10,000 games (400,000 plies):
- **Total games**: 10,000
- **Total plies**: 400,000
- **Elapsed time**: 52.92s
- **Throughput**: 7,559 moves/sec

#### Key Takeaways
- Per-row ORM creates suffer heavy latency penalties due to per-ply connection round trips and transaction overhead (~1,587 moves/sec).
- Prisma `createMany` achieves a 6.4x improvement (~10,203 moves/sec) by batching moves per game, but incurs overhead in parameter preparation.
- PostgreSQL `UNNEST` delivers peak throughput (~13,033 moves/sec on 1,000 games, 8.2x faster than per-row) while preserving transactional atomicity and idempotency.

## 4. Pipeline and throughput

`node scripts/benchmarkThroughput.js --games 30 --workers 1,2,3` on an Apple M4 (10 cores: 4 performance, 6 efficiency, 16 GB), Stockfish 19 at depth 12, 1 thread and 64 MB hash per worker, PostgreSQL 16 in Docker. Full method and machine details are in `docs/benchmarks/throughput.md`.

| Workers | Games | Plies | Wall time | Games / min | Plies / sec | Engine calls / game | Speedup | Failed jobs |
| ------: | ----: | ----: | --------: | ----------: | ----------: | ------------------: | ------: | ----------: |
| 1 | 30 | 1200 | 35.4 s | 50.9 | 33.9 | 40.03 | 1.00x | 0 |
| 2 | 30 | 1200 | 20.4 s | 88.2 | 58.8 | 40.07 | 1.73x | 0 |
| 3 | 30 | 1200 | 12.6 s | 142.9 | 95.2 | 40.10 | 2.81x | 0 |

- Throughput scales almost linearly up to 3 workers because each worker is one single-threaded Stockfish search on its own core; the work is engine-bound, and Postgres (one atomic write per game plus job heartbeats) is idle for most of the run.
- The 2-worker run is below 2x because parallelism is per account: one 15-game job took 19.9 s and the other 15.7 s, so wall time follows the slower job. Engine calls stay at N + 1 per game, plus one start-position search per worker.
- On this machine the limit beyond 3 to 4 workers is the 4 performance cores (further workers land on slower efficiency cores), then the per-account job split; each worker also adds its own 64 MB hash, and Postgres only becomes a factor once many workers commit at the same time.

## 5. Analytics and query benchmarks

### Analytics Architecture and Workloads
Longitudinal chess analytics span multi-table aggregations across games, plies, engine evaluations, accuracy classifications, and tactical motifs. The API surfaces diagnostic endpoints for opening blunder rates, phase accuracies, time pressure decay, rolling 7-day performance trends, motif weakness frequencies, and personalized weak spots.

### Query Performance and Rollup Benchmark
Benchmark measured across 20 iterations (3 warm-up runs) against a 10,000-game dataset (400,000 moves, 40,000 motif tags; note the earlier explain analysis in `docs/explain/` ran against an 80,003-tag dataset from an earlier unnest run) on Apple M4 (10 cores), 16 GB RAM, PostgreSQL 16.15:

#### Analytics Queries (Without vs With C6 Indexes)

| Query / Workload | Without C6 Indexes (p50 / p95) | With C6 Indexes (p50 / p95) | Speedup (p50) |
| :--- | :---: | :---: | :---: |
| 1. Opening Blunder Rate | 69.64 ms / 73.85 ms | 69.32 ms / 71.18 ms | 1.00x |
| 2. Phase Accuracy | 64.93 ms / 65.47 ms | 64.76 ms / 66.24 ms | 1.00x |
| 3. Time Pressure Buckets | 70.61 ms / 77.02 ms | 69.84 ms / 70.55 ms | 1.01x |
| 4. Performance Trend (Rolling 7d) | 91.23 ms / 92.65 ms | 92.47 ms / 98.11 ms | 0.99x |
| 5. Motif Weakness Frequency | 34.25 ms / 34.99 ms | 34.20 ms / 34.55 ms | 1.00x |
| 6. Weakest Opening Phases | 194.83 ms / 197.57 ms | 194.13 ms / 196.49 ms | 1.00x |

#### Summary Rollup vs Base Table Aggregation

| Base aggregation (p50 / p95) | Summary table (p50 / p95) | Speedup |
| :---: | :---: | :---: |
| 242.25 ms / 247.96 ms | 0.34 ms / 0.43 ms | 710.94x |

### Observations and Analysis
- The targeted indexes (`idx_player_accounts_user_id` and `idx_move_motifs_motif_id`) made no measurable difference at this dataset size (0.99x-1.01x) because the tables are small enough for the planner to favor sequential scans; they remain as projections for multi-user scale.
- Reading precomputed summary rollups via `GET /api/v1/analytics/summary` executes in 0.34 ms (p50), providing a 710x speedup over full multi-table aggregation across 400,000 moves.
- `refreshAccountSummary` is a synchronous step at job completion that adds ~267 ms per job and moves aggregation cost off dashboard reads.

## 6. Demo and results

### What the Demo Shows
The live system demonstration (`docs/DEMO.md`) provides an 8-minute end-to-end walkthrough of the complete pipeline across browser and terminal workflows:
1. **User Onboarding and Ingestion**:
   - Registering a user account and linking a Lichess platform account (`POST /api/v1/accounts`).
   - Triggering game synchronization with optional date range bounds (`POST /api/v1/imports`) or uploading PGN files.
   - Real-time job polling tracking worker status (`queued` -> `running` -> `completed`).
2. **Analysis Worker Execution**:
   - Multi-worker concurrent processing with atomic `SKIP LOCKED` job claiming.
   - Persistent Stockfish process (depth 12, 1 thread, 64 MB hash) evaluating games via N+1 searches with cached starting position evals.
   - Detection of tactical motifs (`allowed` opponent tactics vs `missed` player opportunities).
   - Atomic completion with single-transaction persistence and automatic `account_summary` refresh.
3. **Analytics Dashboard Walkthrough**:
   - High-level KPIs from summary rollup tables (analyzed games, win-probability accuracy %, blunders per 100 moves, average centipawn loss).
   - Visualizing opening blunder rates with ECO and ply bucket breakdowns.
   - Phase accuracy comparison across opening, middlegame, and endgame.
   - Clock time-pressure decay across ordered remaining time buckets (`>50%`, `25-50%`, `10-25%`, `<10%`).
   - Longitudinal 7-day rolling performance trends against raw daily accuracies.
   - Dual-series tactical motif weakness analysis (allowed vs missed rates).
4. **Interactive Game Viewer**:
   - Paginated games list with result badges, ratings, ECO openings, and failure reason tooltips.
   - Interactive board oriented to the player's color with keyboard navigation (`Left`, `Right`, `Home`, `End`).
   - Win-probability evaluation graph with click-to-move navigation.
   - Move details panel featuring move classifications, centipawn loss, engine best move in algebraic notation (SAN), clock stats, and motif badges.
5. **Personalized Tactical Training**:
   - Synthesizing a tailored training plan (`POST /api/v1/training/plans`) based on weakest motifs and opening phases.
   - Interactive puzzle board displaying Lichess puzzles with pre-applied setup moves and proper board orientation.
   - Drag-and-drop solving with 350ms opponent auto-reply, wrong-move snap-back, hint square highlight, and asynchronous completion tracking.
6. **Integrity and Resiliency Verification**:
   - Running data quality checks (`npm run dq`) validating all database integrity invariants.
   - Demonstrating worker process crash recovery and poison job quarantine.

### UI Screens in the Application
- **`/login` and `/register`**: JWT-based authentication views with form validation and error handling.
- **`/dashboard`**: Longitudinal analytics dashboard featuring 4 summary tiles and 5 Recharts data visualizations with accessible data table fallbacks.
- **`/import`**: Account linking for Lichess and Chess.com, PGN file upload dropzone, and active import job polling cards.
- **`/games`**: Paginated games explorer (page size 20) with multi-criteria filters (account, date range, ECO) and status badges.
- **`/games/:id`**: Interactive game replay studio with chessboard, win-probability graph, move list, and tactical details panel.
- **`/training`**: Personalized training plan dashboard with grouped puzzle drills and interactive drag-and-drop solver.

### Key Numbers Summary
- **Move Insertion Throughput**: 13,033 moves/sec via PostgreSQL `UNNEST` (8.2x faster than per-row ORM creates).
- **Analysis Worker Throughput**: 142.9 games/min (95.2 plies/sec) across 3 parallel workers on Apple M4.
- **Summary Table Speedup**: 0.34 ms summary query latency vs 242.25 ms base aggregation (710x speedup).
- **Engine Call Efficiency**: N+1 engine calls for an N-ply game (40.03 to 40.10 engine calls per 40-ply game).
- **Automated Test Coverage**: 356 server tests (38 test suites) and 43 client unit tests (6 test suites) passing.

## 7. Development log summary

### Totals by Person
| Person | Role | Logged Time (min) | Issues Handled |
| :--- | :--- | :---: | :---: |
| **A** (07shlokjoshi) | Ingestion & Infra | 10 min | 1 |
| **B** (spy-in-shadows) | Engine & Pipeline | 151 min | 16 |
| **C** (Shailja-Vatsa) | Analytics & Client | 0 min | 0 |
| **Total** | | **161 min** | **17 non-trivial issues** |

### Totals by Cause
| Cause Category | Time (min) | Frequency | Description |
| :--- | :---: | :---: | :--- |
| **Database & Environment Conflicts** | 35 min | 3 | Host port 5432 binding conflicts, volume WAL corruption, and fixture contamination in shared DB. |
| **Timezone & Serialization Mismatches** | 20 min | 1 | Local timezone serialization in `pg` driver vs UTC wall-clock in Prisma shifting timestamps by UTC offset. |
| **Specification & Schema Constraints** | 45 min | 4 | Inherent schema unique constraints rejecting test seeds, task text overlapping rules, and specification ambiguities. |
| **Engine Search & Concurrency Edge Cases** | 23 min | 3 | Process crash queue rejection epochs, retried job eval differences due to hash state, and engine error test assertions. |
| **Integration & Status Mismatches** | 25 min | 3 | Job status enum mismatch (`done` vs `completed`), `validateFen` return contract shape, and foreign fixture isolation. |
| **Tooling & Setup** | 13 min | 3 | npm 11 allow-scripts lifecycle policies, fast-forward branch conflict, and FEN call counting in test stubs. |

### Three Most Expensive Problems
1. **Host Timezone vs UTC Serialization (B10, 20 minutes)**:
   - *What happened*: On an IST host (+5:30), `claimNextJob` received `since` 5:30h early, and `last_synced_at` cursors and `played_at` timestamps were shifted.
   - *Cause*: `timestamp` columns store UTC wall-clock time in Prisma, but `pg` serializes and parses JavaScript `Date` instances in the host's local timezone.
   - *Fix*: Configured explicit UTC timestamp parsing per query on `pgPool`, and converted cursor timestamps with `AT TIME ZONE 'UTC'`.
2. **PostgreSQL Port 5432 Collisions and Shared Fixture Contamination (B5, 15 minutes)**:
   - *What happened*: `docker compose up -d` failed to bind port 5432 due to local host PostgreSQL daemons; once started, claim tests picked up leftover queued jobs from earlier test runs.
   - *Cause*: Port 5432 was occupied by existing host services; concurrent test files left unfinished job fixtures in the shared database.
   - *Fix*: Configured a separate container on port 5433 and added pre-test cleanup clearing queued/running jobs before concurrency assertions.
3. **Data Quality Test Seeding Blocked by Schema Constraints (B12, 15 minutes)**:
   - *What happened*: Data-quality checks designed to catch orphaned jobs, duplicate active jobs, and duplicate engine versions could not be seeded because PostgreSQL schema constraints rejected invalid rows.
   - *Cause*: Foreign keys, partial unique indexes, and immutable engine version constraints enforce relational invariants at the database level.
   - *Fix*: Inserted test fixtures using `SET LOCAL session_replication_role = replica` and temporary index teardown/recreation in isolated test blocks.

## 8. Limitations and future work

**Rule-based or approximate**
- Motif tags are board-geometry rules applied to the position after the move and after Stockfish's single best reply. They look one reply deep and can mislabel: in the end-to-end test, the Fool's-mate blunder 2. g4 is tagged `back_rank` and `pin` rather than as allowing a mate.
- Move classification uses fixed win-probability thresholds on a cp-to-win-probability curve; neither has been calibrated against human ratings.
- Game phases come from a material and ply threshold, not from a trained model, so transitions are approximate.
- `errors_per_100_moves` is a move-frequency rate. It does not count how often a motif was actually possible, so it cannot separate "rarely faced" from "rarely missed".
- Depth 12 with one thread is shallow for deep tactics, and evals do not repeat exactly between runs: a retried game differed by up to about 12 cp (classifications matched) because the hash table differs after a restart.
- Openings come only from the ECO header of the game; there is no move-based opening classifier, and the seeded opening table is small.
- The training plan compares the player's game rating with Lichess puzzle ratings, which are on different scales. Puzzle phase tags come only from the puzzle themes.
- Time-pressure analytics leave out every move without a clock (most hand-written PGNs), and correspondence games.

**Known issues**
- `GET /imports/:id` counts `completedGames` from `analysis_job_games.status = 'completed'`, but the worker writes `done`, so the count stays at 0. Job `status`, `totalGames` and `failedGames` are correct.
- Raw `pg` writes of JS Dates in `moveBulk.repo.js` use the host's local time zone, while Prisma stores UTC wall-clock time (DEV_LOG, B10). CI on UTC hides it; on another zone `played_at` is shifted.
- The rate limiter keeps its counters in process memory, so it does not hold across several API processes.
- Data-quality checks only log violations after each job; nothing alerts or repairs.

**Untested or measured only at small scale**
- The Lichess and Chess.com clients are tested against mocked `fetch` responses; no test calls the live APIs.
- Throughput was measured with 1 to 3 workers on one laptop; more workers, several hosts and API load were not tested.
- Query timings come from one 10k-game dataset for a single user; multi-user indexes were added on projection, not on measurement.
- The React client has no browser end-to-end test; the end-to-end test drives the HTTP API.

**Future work**
- Fix the two known issues above (job progress count, `pg` date handling).
- Detect motifs from the engine's principal variation instead of one reply, and normalize motif rates by opportunities.
- Scheduled background sync per account, and incremental summary refresh instead of a full rebuild.
- Multi-PV or deeper searches for critical positions only, keeping depth 12 elsewhere.
