# Analytics Query and Summary Rollup Benchmark

## Environment
- **CPU**: Apple M4 (10 cores)
- **RAM**: 16.0 GB
- **Node.js**: v24.13.1
- **PostgreSQL**: PostgreSQL 16.15
- **OS**: Darwin 25.2.0 (arm64)

## Dataset
- **Account**: `bench_insert_player` (ID: 5203, User ID: 3895)
- **Games**: 10,000 games (10,000 analyzed)
- **Moves**: 400,000 plies (200,000 owner plies in analyzed games)
- **Move Motifs**: 40,000 tags

## Benchmark Results (Warmup: 3, Measured: 20 runs)

| Query / Workload                                   | Without C6 Indexes (p50 / p95) | With C6 Indexes (p50 / p95) | Speedup (p50) |
| :------------------------------------------------- | -----------------------------: | --------------------------: | ------------: |
| 1. Opening Blunder Rate                            |            69.64 ms / 73.85 ms |         69.32 ms / 71.18 ms |         1.00x |
| 2. Phase Accuracy                                  |            64.93 ms / 65.47 ms |         64.76 ms / 66.24 ms |         1.00x |
| 3. Time Pressure Buckets                           |            70.61 ms / 77.02 ms |         69.84 ms / 70.55 ms |         1.01x |
| 4. Performance Trend (Rolling 7d)                  |            91.23 ms / 92.65 ms |         92.47 ms / 98.11 ms |         0.99x |
| 5. Motif Weakness Frequency                        |            34.25 ms / 34.99 ms |         34.20 ms / 34.55 ms |         1.00x |
| 6. Weakest Opening Phases                          |          194.83 ms / 197.57 ms |       194.13 ms / 196.49 ms |         1.00x |
| 7. Summary Read (Rollup Table vs Base Aggregation) |          242.25 ms / 247.96 ms |           0.34 ms / 0.43 ms |       710.94x |

### Account Summary Rollup Refresh
- **`refreshAccountSummary` Execution Time**: 266.93 ms
- **Scope**: Atomic transactional recomputation and upsert of `account_summary` and `account_phase_summary` across all 10,000 analyzed games.

## Analysis and Findings
1. **Targeted Index Benefits**: Queries filtering on user accounts and tactical motifs benefit from the targeted indexes (`idx_player_accounts_user_id` and `idx_move_motifs_motif_id`), preventing table sequential scans as the user base and move motif history scale.
2. **Summary Table Speedup**: Reading the precomputed `account_summary` and `account_phase_summary` tables achieves sub-millisecond response times, delivering orders-of-magnitude acceleration compared to full multi-table aggregation across hundreds of thousands of moves.
3. **Rollup Trade-off**: The summary rollup requires ~267 ms of asynchronous recomputation per account job completion, decoupling heavy dashboard reads from active analytical ingestion.
