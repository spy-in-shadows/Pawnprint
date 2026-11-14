# Game Ingestion and Move Insertion Benchmark

## Environment
- **CPU**: Apple M4 (10 cores)
- **RAM**: 16.0 GB
- **Node.js**: v26.13.0
- **PostgreSQL**: PostgreSQL 16.15
- **OS**: Darwin 27.0.0 (arm64)

## Benchmark Results
| Strategy                        | Games | Plies / Game | Total Plies | Duration | Moves / sec |         Speedup |
| :------------------------------ | ----: | -----------: | ----------: | -------: | ----------: | --------------: |
| Prisma create (per-row)         | 1,000 |           40 |      40,000 | 25.21s * |       1,587 | 1.0x (baseline) |
| Prisma createMany               | 1,000 |           40 |      40,000 |    3.92s |      10,203 |            6.4x |
| pg UNNEST (insertGameWithMoves) | 1,000 |           40 |      40,000 |    3.07s |      13,033 |            8.2x |

\* Extrapolated from 500-game sample (12.61s).

## Analysis
- **Write Amplification in Per-Row ORM**: Inserting each move as an isolated row (`prisma.move.create`) produces significant network overhead and transaction commit overhead (one round trip and WAL flush per ply).
- **Prisma createMany**: Batching moves into a single `createMany` per game eliminates ply-level round trips, bringing moves/sec up by 6.4x compared to per-row, but remains bounded by client-side query generation and parameters limit.
- **PostgreSQL UNNEST**: In `insertGameWithMoves`, moves are passed as parallel typed arrays to an `INSERT INTO moves ... SELECT ... FROM UNNEST(...)` statement within a single transaction. This completes in a single network round trip and single WAL flush per game, achieving 8.2x speedup over the per-row baseline.
