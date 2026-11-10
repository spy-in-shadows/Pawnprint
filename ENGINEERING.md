# Engineering conventions

Team conventions for the Longitudinal Chess Analytics Engine. Every contributor follows them. Read `DESIGN.md` first; it is the source of truth for schema, API, eval math, and build phases.

## Stack and conventions
- Node.js 20+, **ES Modules** (`"type": "module"`), async/await everywhere, no callbacks.
- Express with strict **MVC + service/repository layering**: routes -> controllers -> services -> repositories. Controllers never touch the DB directly.
- Prisma for schema, migrations, reads and low-volume writes. Raw `pg` Pool only for hot paths (bulk move inserts, job claiming). Do not use Prisma per-row creates for moves.
- PostgreSQL runs via `docker-compose.yml`. Config comes from `.env` (never commit it); keep `.env.example` current.
- Stockfish path comes from `STOCKFISH_PATH` (or auto-detected system binary).
- React frontend lives in `client/` (Vite). It talks to `/api/v1/*` only.

## Key Architectural & Implementation Decisions
1. **Engine Architecture**: One persistent Stockfish instance per worker process (`Threads=1`, `Hash=64`, fixed `depth=12`). Engine name and version are dynamically parsed from the `id name` UCI handshake line. `engine_versions` records are strictly immutable (unique on name, version, depth, threads, hash).
2. **Every Eval from Stockfish**: Every evaluation comes directly from Stockfish (never store a fallback or embedded eval). If engine fails or times out, the attempt fails cleanly.
3. **Position Eval Reuse (N+1 calls)**: Each position is evaluated once. The previous move's "after" evaluation is reused as the next move's "before" evaluation (yielding N+1 engine calls for an N-ply game, instead of 2N). Starting position evals are cached in memory per worker.
4. **Terminal Positions**: Positions with no legal moves (checkmate and stalemate) are resolved via `chess.js` without calling Stockfish (checkmate = explicit mate score from mover perspective; stalemate = 0 cp).
5. **Standard Chess Only**: Only standard chess (`startpos`) is imported. Variants (Chess960, Crazyhouse, etc.) and custom starting FENs are skipped during ingestion and counted in `skipped_games`.
6. **Error Separation**:
   - **Data errors** (illegal moves, corrupted FENs, invalid PGNs): Mark that individual game as `failed` in `analysis_job_games` with reason; the game is NOT retried, and the job continues.
   - **Engine errors** (timeout, process crash): Entire job keeps a 3-attempt retry before marking the job `failed`.
7. **One Active Job per Account**: Enforced at the database level via a partial unique index on `analysis_jobs(player_account_id) WHERE status IN ('queued', 'running')`. `POST /imports` returns the existing active job instead of creating a duplicate.
8. **Game Analysis Status**: Games track `analysis_status` (`pending`, `analyzed`, `failed`) and `failure_reason`. The unanalyzed games query strictly selects `pending` games. Evals are collected in memory and committed atomically in one transaction at game completion.
9. **User-Driven Cursor Sync**: Ingestion uses `lastSyncedAt` as cursor with support for optional `since` and `until` date range overrides (`since <= until` validated on UI and API).
10. **Motif Tag Precision**:
    - Motif tags are tied strictly to Stockfish's actual best reply (`bestReplyUci`), with no speculative candidate replies.
    - Tags distinguish between `kind='allowed'` (player's error allowed a tactic) and `kind='missed'` (player's best move would have executed a tactic or mate).
11. **Move-Frequency Metric**: `errors_per_100_moves` in `GET /api/v1/analytics/motifs` is an overall move-frequency rate (errors per 100 player moves played), not an opportunity-normalized rate.
12. **Lichess Puzzle Convention**: In puzzle CSVs, `FEN` is the board BEFORE the opponent's setup move, and `Moves[0]` is that opponent move. The solver applies `Moves[0]` automatically, orients the board for the solver's side, and validates user moves against `Moves[1..]`.

## Rules that must not be broken
1. Schema stays fully normalized: no JSON blobs for move data, no wide NULL-heavy tables. Mate data goes in `move_mates`, not nullable columns on `move_evals`.
2. Every ply is evaluated and classified, **including early plies**. No opening-skip heuristics.
3. Stored evals are White-perspective centipawns; all loss maths converts to mover perspective via `src/chess/evalMath.js`. Mate scores map to bounded centipawns per DESIGN.md section 7.
4. Jobs are claimed only through the `FOR UPDATE SKIP LOCKED` query. Never read-then-update.
5. All imports are idempotent (`ON CONFLICT DO NOTHING` on `platform_id, external_id`).
6. Passwords hashed with bcrypt; JWT secret from env; every non-auth route requires the `authenticate` middleware, and every query is scoped to the authenticated user.
7. Write tests for `evalMath`, the PGN parser, and the multi-worker claim concurrency. Don't mark a phase done while its tests fail.

## Commands
- `docker compose up -d` : start Postgres
- `npx prisma migrate dev` : apply migrations
- `npm run seed` : seed lookup tables
- `node scripts/importPuzzles.js` : import puzzle bank
- `npm run dev` : API server
- `npm run worker` : one worker (run several in separate terminals)
- `npm test` : run Vitest test suite
- `npm run bench` : insert benchmark

## Allowed dependencies
Adding any package not listed here needs B's approval (update this list in the same PR).
- Server: express, @prisma/client, pg, bcrypt, jsonwebtoken, chess.js, multer, dotenv.
- Server dev: prisma, vitest. **supertest is NOT used**: HTTP tests use `fetch` against `app.listen(0)`.
- Client (`client/`): react, react-dom, react-router-dom, vite, @vitejs/plugin-react, tailwindcss, recharts, react-chessboard, chess.js, vitest.
