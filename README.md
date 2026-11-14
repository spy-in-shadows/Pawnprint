# Pawnprint — Longitudinal Chess Analytics Engine

A longitudinal chess analytics engine that ingests games from Lichess, Chess.com, and PGN files, evaluates every move using Stockfish, normalizes trajectories in PostgreSQL, and synthesizes personalized tactical training plans from persistent player weaknesses.

## Architecture

```
                    +---------------------------+
                    |    React SPA (Vite)       |
                    | /dashboard, /games, /plan |
                    +-------------+-------------+
                                  |
                                  | HTTP / JSON (/api/v1/*)
                                  v
                    +---------------------------+
                    |    Express REST API       |
                    | (MVC, Auth, Ingest, Jobs) |
                    +------+-------------+------+
                           |             |
           Enqueue / Read  |             | Read / Query
                           v             v
                    +---------------------------+
                    |   PostgreSQL 16 Database  |
                    | (Normalized Schema / pg)  |
                    +-------------+-------------+
                                  ^
                                  | SKIP LOCKED Claim / Atomic Commit
                                  |
                    +-------------+-------------+
                    |     Worker Processes      |
                    | (N parallel worker procs) |
                    +-------------+-------------+
                                  |
                                  | UCI Protocol (stdio)
                                  v
                    +---------------------------+
                    |      Stockfish Engine     |
                    | (Threads=1, Hash=64, d=12)|
                    +---------------------------+
```

## Setup from Zero

### Prerequisites
- **Node.js 20+**
- **Docker** and Docker Compose
- **Stockfish engine binary**
  - macOS (Homebrew): `brew install stockfish` (default binary at `/opt/homebrew/bin/stockfish`)
  - Ubuntu/Debian: `sudo apt-get install stockfish` (binary at `/usr/games/stockfish`)
- Optional for puzzles: `zstd` (`brew install zstd` or `apt-get install zstd`)

### Environment & Database
1. Copy the environment configuration:
   ```bash
   cp .env.example .env
   ```
2. Start the PostgreSQL container:
   ```bash
   docker compose up -d
   ```
3. Apply database migrations:
   ```bash
   npx prisma migrate deploy
   ```
4. Seed lookup tables (platforms, results, phases, classifications, motifs, time controls, openings):
   ```bash
   npm run seed
   ```

### Puzzle Bank Import
Import tactical training puzzles from the Lichess puzzle bank into the database:
- Full uncompressed CSV:
  ```bash
  node scripts/importPuzzles.js /path/to/lichess_db_puzzle.csv
  ```
- Streaming decompress with zstd:
  ```bash
  zstd -d lichess_db_puzzle.csv.zst
  node scripts/importPuzzles.js lichess_db_puzzle.csv
  ```
- Partial-sample trick (e.g. 50,000 puzzles):
  ```bash
  zstd -dc lichess_db_puzzle.csv.zst 2>/dev/null | head -n 50001 > sample.csv
  node scripts/importPuzzles.js sample.csv
  ```

### Running the System
- **Start the API Server**:
  ```bash
  npm run dev
  ```
- **Start Worker Processes**:
  ```bash
  npm run worker
  ```
  *(Multiple worker processes can be started in separate terminals; each worker will concurrently process jobs for different accounts without colliding).*
- **Build and Run Client SPA**:
  ```bash
  npm --prefix client run build
  npm --prefix client run dev
  ```
- **Running Tests**:
  ```bash
  npm test
  npm --prefix client test
  ```

## Command Reference

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the Express API server (default port 3000) |
| `npm run worker` | Starts an analysis worker process running persistent Stockfish |
| `npm test` | Runs the Vitest test suite across server units, services, and routes |
| `npm run seed` | Seeds core relational lookups in PostgreSQL via Prisma |
| `npm run bench` | Runs the comparative move insertion benchmark (`benchmarkInsert.js`) |
| `npm run bench:throughput` | Runs the multi-worker analysis throughput benchmark |
| `npm run bench:queries` | Measures execution time across analytics queries with/without indexes and rollups |
| `npm run dq` | Runs data-quality verification checks across database consistency and invariants |
| `npm --prefix client run build` | Compiles the React SPA with Vite for production |
| `npm --prefix client test` | Runs client-side unit tests in Vitest |

## Benchmark Results

### 1. Game Ingestion and Move Insertion Throughput
Comparison between per-row ORM creates, batch `createMany`, and PostgreSQL typed-array `UNNEST` over 1,000 games (40,000 plies) on Apple M4:

| Strategy | Games | Plies / Game | Total Plies | Duration | Moves / sec | Speedup |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| Prisma create (per-row) | 1,000 | 40 | 40,000 | 25.21s * | 1,587 | 1.0x (baseline) |
| Prisma createMany | 1,000 | 40 | 40,000 | 3.92s | 10,203 | 6.4x |
| pg UNNEST (`insertGameWithMoves`) | 1,000 | 40 | 40,000 | 3.07s | 13,033 | 8.2x |

\* Extrapolated from 500-game sample. Scale validation over 10,000 games (400,000 plies) completed in 52.92s (7,559 moves/sec).

### 2. Multi-Worker Engine Throughput
Analysis throughput over 30 games (1,200 plies) with Stockfish 19 at depth 12 (`Threads=1`, `Hash=64MB`):

| Workers | Games | Plies | Wall time | Games / min | Plies / sec | Engine calls / game | Speedup | Failed jobs |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | 30 | 1,200 | 35.4 s | 50.9 | 33.9 | 40.03 | 1.00x | 0 |
| 2 | 30 | 1,200 | 20.4 s | 88.2 | 58.8 | 40.07 | 1.73x | 0 |
| 3 | 30 | 1,200 | 12.6 s | 142.9 | 95.2 | 40.10 | 2.81x | 0 |

### 3. Analytics Queries and Summary Rollup Acceleration
Query performance measured across 20 iterations (warmup 3) against 10,000 games (400,000 moves, 40,000 motif tags):

| Query / Workload | Without C6 Indexes (p50 / p95) | With C6 Indexes (p50 / p95) | Speedup |
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

## API Endpoints

All data routes require `Authorization: Bearer <jwt>`. Accessing another user's resource returns `404 Not Found`.

### Auth
- `POST /api/v1/auth/register` — Create user account (`{email, password}`)
- `POST /api/v1/auth/login` — Authenticate and receive JWT (`{email, password}`)
- `GET /api/v1/auth/me` — Inspect authenticated user profile

### Accounts & Ingestion
- `GET /api/v1/accounts` — List user's linked chess accounts
- `POST /api/v1/accounts` — Link a Lichess or Chess.com username
- `POST /api/v1/imports` — Enqueue import job (`{accountId, maxGames, since, until}`)
- `GET /api/v1/imports/:id` — Inspect import job status and progress
- `POST /api/v1/uploads/pgn` — Upload PGN file multipart for parsing and ingestion

### Games
- `GET /api/v1/games` — Paginated games list with filters (`accountId`, `from`, `to`, `opening`, `page`, `pageSize`)
- `GET /api/v1/games/:id` — Full game detail with ply moves, evaluations, classifications, and motifs

### Analytics
- `GET /api/v1/analytics/openings` — Blunder rates by ECO opening and ply bucket
- `GET /api/v1/analytics/phases` — Move counts, blunders, and accuracy across opening, middlegame, and endgame
- `GET /api/v1/analytics/time-pressure` — Blunder rate across clock buckets (`>50%`, `25-50%`, `10-25%`, `<10%`)
- `GET /api/v1/analytics/trend` — Daily accuracy and rolling 7-day average accuracy
- `GET /api/v1/analytics/motifs` — Tactical motif weaknesses (allowed vs missed rates per 100 moves)
- `GET /api/v1/analytics/summary` — Fast sub-millisecond account rollup metrics from summary tables

### Training & System
- `GET /api/v1/training/plans` — List personalized training plans and items with prepared drills
- `POST /api/v1/training/plans` — Synthesize new training plan matching user weaknesses
- `PATCH /api/v1/training/plans/:planId/items/:itemId` — Mark puzzle drill completed
- `GET /health` or `GET /api/v1/health` — System and database health status

## Design Rules

1. **Normalized Schema**: No JSON blobs for move data; no wide NULL-heavy tables. Mate counts live in `move_mates`, not nullable columns on `move_evals`.
2. **Every Ply Evaluated**: Every ply is analyzed and classified, including early plies. No opening-skip heuristics.
3. **White-Perspective Centipawns**: All stored evals are White-perspective centipawns; loss math converts to mover perspective via `evalMath.js`. Forced mates map to bounded centipawns.
4. **SKIP LOCKED Job Claims**: Jobs are claimed atomically via `FOR UPDATE SKIP LOCKED`. Never read-then-update.
5. **Idempotent Imports**: All imports are idempotent (`ON CONFLICT DO NOTHING` on `platform_id, external_id`).
6. **Authentication and Isolation**: Passwords hashed with bcrypt; JWT secret from environment; all queries scoped strictly to the authenticated user.
7. **N+1 Engine Calls**: Each position is evaluated once; the after-evaluation of move K is reused as the before-evaluation of move K+1. Terminal positions (checkmate/stalemate) are evaluated with chess.js without calling Stockfish.
8. **Partitioned Errors**: Corrupted FENs or illegal moves fail individual games (`status='failed'`) without retrying; engine process crashes retry 3 times with engine respawn.
9. **One Active Job per Account**: Guaranteed by a partial unique index on `analysis_jobs(player_account_id) WHERE status IN ('queued', 'running')`.

## Known Limitations

- **Standard Chess Only**: Variants (Chess960, Crazyhouse, King of the Hill) and custom non-standard starting FENs are skipped during ingestion.
- **Fixed Engine Depth 12**: Stockfish is pinned to depth 12 with 1 thread and 64 MB hash per worker process.
- **Account Concurrency**: One active import job per account; multiple workers run in parallel only across distinct player accounts.
- **Rule-Based Tactical Motifs**: Tactical motif detection inspects board geometry after the move and after Stockfish's single best reply. Deep motifs or missed tactics beyond one reply are not identified.
- **Move-Frequency Rates**: `errors_per_100_moves` measures blunder occurrences per 100 moves played by the user, rather than opportunity-normalized tactical rates.
- **External Platform Formats**: Third-party API rate limits and upstream format changes on Lichess or Chess.com can impact streaming ingestion.
- **Puzzle Bank Sampling**: Puzzle bank import relies on sampling or subset selection when importing from multi-gigabyte Lichess puzzle archives.
