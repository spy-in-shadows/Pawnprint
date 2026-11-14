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
| Prisma create (per-row) | 1,000 | 40 | 40,000 | 41.55s * | 963 | 1.0x (baseline) |
| Prisma createMany | 1,000 | 40 | 40,000 | 5.09s | 7,851 | 8.2x |
| pg UNNEST (insertGameWithMoves) | 1,000 | 40 | 40,000 | 3.22s | 12,405 | 12.9x |

\* Extrapolated from 500-game sample (20.77s).

#### Scale Validation (10,000 Games / 400,000 Plies)
We executed the full scale ingestion run using the `unnest` strategy across 10,000 games (400,000 plies):
- **Total games**: 10,000
- **Total plies**: 400,000
- **Elapsed time**: 52.92s
- **Throughput**: 7,559 moves/sec

#### Key Takeaways
- Per-row ORM creates suffer heavy latency penalties due to per-ply connection round trips and transaction overhead (~963 moves/sec).
- Prisma `createMany` achieves an 8.2x improvement (~7,851 moves/sec) by batching moves per game, but incurs overhead in parameter preparation.
- PostgreSQL `UNNEST` delivers peak throughput (~12,405 moves/sec on 1,000 games, 12.9x faster than per-row) while preserving transactional atomicity and idempotency.

## 4. Pipeline and throughput
TODO(B)

## 5. Analytics and query benchmarks
TODO(C)

## 6. Demo and results
TODO(C)

## 7. Development log summary
TODO(all)

## 8. Limitations and future work
TODO(B)
