# Analytics Query Plans and Index Analysis

This directory documents execution plans before and after targeted indexing, measured against a benchmark dataset of 10,000 games (400,000 moves, 400,000 evaluations, and 80,003 move motifs) on PostgreSQL 16 using `EXPLAIN (ANALYZE, BUFFERS)`.

## Before / After Comparison

| Query | Before (ms) | After (ms) | Change | Indexes in After Plan |
| :--- | :---: | :---: | :---: | :--- |
| `1_opening_blunder_rate` | 127.62 | 130.02 | +1.9% | None (all sequential scans) |
| `2_phase_accuracy` | 90.67 | 88.75 | -2.1% | None (all sequential scans) |
| `3_time_pressure` | 104.19 | 89.96 | -13.7% | None (all sequential scans) |
| `4_performance_trend` | 129.07 | 118.12 | -8.5% | None (all sequential scans) |
| `5_motif_weaknesses` | 85.53 | 82.43 | -3.6% | None (all sequential scans) |
| `6_weakest_opening_phases` | 205.88 | 205.57 | -0.2% | `openings_pkey`, `moves_game_id_ply_key`, `move_classifications_pkey` |

The measured execution time changes (-13.7% to +1.9%) are within run-to-run noise on a warm cache.

## Targeted Indexes Added

1. **`player_accounts(user_id)` (`idx_player_accounts_user_id`)**
   - **Justification**: Projected for scale. At 10,000 games with a handful of users and accounts, `player_accounts` fits in a single block and the query planner selects a sequential scan. This index is kept for production environments with many registered users and accounts where filtering by `pa.user_id = $1` becomes selective enough for index scans.
2. **`move_motifs(motif_id)` (`idx_move_motifs_motif_id`)**
   - **Justification**: Projected for scale. In `move_motifs`, the primary key is `(move_id, motif_id, kind)`. At current volume where queries join against the entire table or low selectivity sets, the planner continues to sequential-scan `move_motifs`. This index is retained for selective single-motif lookups and larger tables where an index scan or bitmap scan on `motif_id` outperforms sequential scanning.

## Rejected Index Candidates

- **`move_classifications(classification_id)`**:
  - *Analysis*: Tested bitmap index scan vs sequential scan. In analytics aggregations, moves across a player's games span all classification buckets (best, good, inaccuracy, mistake, blunder) across hundreds of thousands of rows. When joining across a user's analyzed games, the query planner prefers scanning via `move_id` (the primary key) or sequential scan over low-selectivity filtering on 5 classification IDs. Indexing `classification_id` added write amplification to move ingestion without providing join speedups in the multi-table analytics pipelines.
- **`moves(game_id, mover_color)`**:
  - *Analysis*: Rejected because `moves` is an ultra-hot write-heavy table. `moves` already has `UNIQUE (game_id, ply)`. Adding compound indexes to `moves` would degrade bulk insert throughput during ingestion while existing index scans on `(game_id, ply)` already provide fast per-game move retrieval.
- **`move_evals(engine_version_id)` / `move_mates(...)`**:
  - *Analysis*: Rejected in accordance with the repository design rules (`moves`, `move_evals`, and `move_mates` remain index-free except for primary keys and existing constraints defined by architecture). Stored evaluations and mates are joined strictly on `move_id` (their primary keys). Speculative secondary indexes on evaluation tables would increase storage and write amplification during worker analysis without benefiting analytics queries.
