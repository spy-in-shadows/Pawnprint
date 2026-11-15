# Analytics Query and Summary Rollup Benchmark

## Environment
- **CPU**: Apple M4 (10 cores)
- **RAM**: 16.0 GB
- **Node.js**: v26.5.0
- **PostgreSQL**: PostgreSQL 16.15
- **OS**: Darwin 25.6.0 (arm64)

## Dataset
Produced by `node scripts/benchmarkInsert.js --games 10000 --strategy unnest --keep` followed by `node scripts/benchmarkQueries.js --synthetic-analysis`: evaluations, classifications and motif tags are synthetic (seeded, classified with `src/chess/evalMath.js`), not engine output.

- **Account**: `bench_insert_player` (ID: 14171, User ID: 9839)
- **Games**: 10,000 games (10,000 analyzed)
- **Moves**: 400,000 plies (200,000 owner plies in analyzed games)
- **Move Motifs**: 7,742 tags

## Benchmark Results (Warmup: 3, Measured: 20 runs)

| Query / Workload                                   | Without C6 Indexes (p50 / p95) | With C6 Indexes (p50 / p95) | Speedup (p50) |
| :------------------------------------------------- | -----------------------------: | --------------------------: | ------------: |
| 1. Opening Blunder Rate                            |            70.17 ms / 74.39 ms |         71.10 ms / 72.21 ms |         0.99x |
| 2. Phase Accuracy                                  |            66.32 ms / 67.94 ms |         66.83 ms / 67.66 ms |         0.99x |
| 3. Time Pressure Buckets                           |            70.06 ms / 70.80 ms |         70.48 ms / 71.36 ms |         0.99x |
| 4. Performance Trend (Rolling 7d)                  |            85.52 ms / 91.71 ms |         85.63 ms / 86.76 ms |         1.00x |
| 5. Motif Weakness Frequency                        |            26.88 ms / 28.13 ms |         26.89 ms / 27.69 ms |         1.00x |
| 6. Weakest Opening Phases                          |          199.91 ms / 204.22 ms |       197.46 ms / 200.29 ms |         1.01x |
| 7. Summary Read (Rollup Table vs Base Aggregation) |          242.35 ms / 244.45 ms |           0.29 ms / 0.58 ms |       833.18x |

Row 7 compares the equivalent aggregate over the base tables (left column) with the summary-table read (right column).

### Account Summary Rollup Refresh
- **`refreshAccountSummary` Execution Time**: 262.50 ms
- **Scope**: Atomic transactional recomputation and upsert of `account_summary` and `account_phase_summary` across all 10,000 analyzed games.

## Analysis and Findings
1. **Targeted indexes**: `idx_player_accounts_user_id` and `idx_move_motifs_motif_id` made no measurable difference on this dataset (p50 ratio 0.99x to 1.01x); the planner still prefers sequential scans at this size.
2. **Summary tables**: reading `account_summary` and `account_phase_summary` is 833.2x faster at p50 than the equivalent aggregate over the base tables.
3. **Rollup cost**: `refreshAccountSummary` took 263 ms for this account; the worker pays it once at the end of each completed job.
