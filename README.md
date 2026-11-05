# Pawnprint — Chess Longitudinal Analytics Engine

A system that takes a player's chess games, evaluates every move with Stockfish, stores
everything in a normalized PostgreSQL schema, and shows where that player keeps losing
points — by opening, game phase, and time pressure. It then generates a ranked list of
drills from the player's own blunders.

> **Pipeline:** PGN ingestion → Postgres → Stockfish workers (safe job queue) →
> aggregation queries → dashboard + drills.

The project's focus is the engineering, not the chess: measured schema trade-offs,
crash-safe concurrent workers, a documented and tested evaluation model, and opening
blunders that are not hidden.

## Stack

| Component | Choice |
|---|---|
| Language | Python 3.11+ |
| Database | PostgreSQL via Docker Compose |
| Chess logic | `python-chess` |
| Engine | Stockfish binary |
| Driver | `psycopg` |
| UI | Streamlit (or one simple FastAPI page) |

## Assumptions

- **Data source:** Lichess PGN exports. Lichess database files carrying `[%eval]` and
  `[%clk]` tags are used for bulk-load benchmarks. Stockfish runs only on the demo
  player's games.
- **Fixed Stockfish depth** (~12) or node limit — the same for all runs.
- **Single user**, no authentication, runs locally.
- Early plies are kept in the data and only flagged as "book" — never excluded.
- A "training regimen" = a ranked list of drills built from the player's own blunders
  (FEN plus best move).

## Repository Layout (planned)

```
schema.sql        # THE contract — owned by Data Engineer, changes via PR only
pgn_loader/       # PGN parser + batch loader (COPY / execute_values)
workers/          # Stockfish job-queue workers (1–4 processes)
eval/             # Evaluation math module (win probability, classification)
analytics/        # Aggregation SQL: opening / phase / time-pressure breakdowns
drills/           # Drill generator (top-10 worst positions)
ui/               # Streamlit dashboard
tests/            # Unit tests for eval math + worker behavior
benchmarks/       # Schema comparison harness + results
```

## Roles

| Role | Owns |
|---|---|
| **A — Data Engineer** | Schema, ingestion, bulk loading, schema benchmark. Tables: `players`, `games`, `moves` (one row per ply, with clock), `positions` (deduplicated by FEN hash), `evaluations` (position, depth, score type, score), `jobs`, `openings`. PGN parser + batch loader using `COPY`/`execute_values`. Index design. Benchmark of (a) JSONB blob vs (b) wide table vs (c) normalized schema — measuring rows/sec, WAL bytes (`pg_current_wal_lsn`), table/index size, query latency. |
| **B — Engine Engineer** | Stockfish workers, job queue, evaluation math, tests. Queue on `jobs` table with `FOR UPDATE SKIP LOCKED`, lease timeouts, retry counts. Idempotent eval writes with `ON CONFLICT`. Worker process evaluating unevaluated positions (1–4 workers). Eval module: perspective normalization, mate-score mapping, centipawn→win-probability, win-probability loss per move, move classification (best/good/inaccuracy/mistake/blunder). Unit tests: mate in N, black to move, mate lost, mate delayed. Crash-recovery demo: kill a worker mid-batch → zero lost, zero duplicate evals. |
| **C — Product & Analytics** | Aggregation queries, drills, UI, demo and report. SQL aggregations: avg win-probability loss by opening/ECO, by phase (opening/middlegame/endgame), by time-pressure bucket. Drill generator: top-10 worst positions ranked by loss (FEN, played move, best move). Streamlit dashboard: username/file input, three breakdown charts, drill list. Demo script, slides, final report. |