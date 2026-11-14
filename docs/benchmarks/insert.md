# Game Ingestion and Move Insertion Benchmark

## Environment
- **CPU**: Apple M4 (10 cores)
- **RAM**: 16.0 GB
- **Node.js**: v26.13.0
- **PostgreSQL**: PostgreSQL 16.15
- **OS**: Darwin 27.0.0 (arm64)

## Comparative Benchmark (1,000 Games / 40,000 Plies)
| Strategy                        | Games | Plies / Game | Total Plies | Duration | Moves / sec |         Speedup |
| :------------------------------ | ----: | -----------: | ----------: | -------: | ----------: | --------------: |
| Prisma create (per-row)         | 1,000 |           40 |      40,000 | 41.55s * |         963 | 1.0x (baseline) |
| Prisma createMany               | 1,000 |           40 |      40,000 |    5.09s |       7,851 |            8.2x |
| pg UNNEST (insertGameWithMoves) | 1,000 |           40 |      40,000 |    3.22s |      12,405 |           12.9x |

\* Extrapolated from 500-game sample (20.77s).

## Scale Validation (10,000 Games / 400,000 Plies)
| Strategy                        |  Games | Plies / Game | Total Plies | Duration | Moves / sec |
| :------------------------------ | -----: | -----------: | ----------: | -------: | ----------: |
| pg UNNEST (insertGameWithMoves) | 10,000 |           40 |     400,000 |   52.92s |       7,559 |

## Analysis
- **Write Amplification in Per-Row ORM**: Inserting each move as an isolated row (`prisma.move.create`) produces significant network overhead and transaction commit overhead (one round trip and WAL flush per ply).
- **Prisma createMany**: Batching moves into a single `createMany` per game eliminates ply-level round trips, bringing moves/sec up by ~8.2x compared to per-row, but remains bounded by client-side query generation and parameter serialization.
- **PostgreSQL UNNEST**: In `insertGameWithMoves`, all moves of a game are passed as parallel typed arrays to an `INSERT INTO moves ... SELECT ... FROM UNNEST(...)` statement within a single transaction. This completes in a single network round trip and single WAL flush per game, achieving ~12.9x speedup over the per-row baseline and successfully ingesting 400,000 plies at scale.
