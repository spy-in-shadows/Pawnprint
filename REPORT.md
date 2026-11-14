# Longitudinal Chess Analytics Engine: Final Report

## 1. Problem and design
TODO(B)

## 2. Team and workflow
TODO(B)

## 3. Schema and insert benchmark

### Database Schema Design
The engine stores historical chess game trajectories in PostgreSQL using a normalized schema managed with Prisma:
- **`games`**: Stores game metadata including player account reference (`player_account_id`), platform (`platform_id`), external platform ID (`external_id`), played timestamp, player color, game result reference (`result_id`), opening classification (`opening_id`), time control reference (`time_control_id`), and analysis status (`pending`, `analyzing`, `analyzed`, `failed`). Idempotency is enforced by a unique index on `(platform_id, external_id)`.
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
TODO(C)

## 7. Development log summary
TODO(all)

## 8. Limitations and future work
TODO(B)
