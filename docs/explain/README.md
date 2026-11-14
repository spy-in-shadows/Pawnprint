# Analytics Query Plans and Index Analysis

This directory documents execution plans before and after targeted indexing, measured against a benchmark dataset of 10,000 games (400,000 moves, 400,000 evaluations, and 80,000 move motifs) on PostgreSQL 16 using `EXPLAIN (ANALYZE, BUFFERS)`.

## Before / After Comparison

| Query | Before (ms) | After (ms) | Change | Index Used |
| :--- | :---: | :---: | :---: | :--- |
| `1_opening_blunder_rate` | 127.62 | 130.02 | +1.9% | `idx_player_accounts_user_id` (via user filter), `games_player_account_id_played_at_idx` |
| `2_phase_accuracy` | 90.67 | 88.75 | -2.1% | `idx_player_accounts_user_id`, `games_player_account_id_played_at_idx` |
| `3_time_pressure` | 104.19 | 89.96 | -13.7% | `idx_player_accounts_user_id`, `games_player_account_id_played_at_idx` |
| `4_performance_trend` | 129.07 | 118.12 | -8.5% | `idx_player_accounts_user_id`, `games_player_account_id_played_at_idx` |
| `5_motif_weaknesses` | 85.53 | 82.43 | -3.6% | `idx_player_accounts_user_id`, `idx_move_motifs_motif_id` |
| `6_weakest_opening_phases` | 205.88 | 205.57 | -0.2% | `idx_player_accounts_user_id`, `games_player_account_id_played_at_idx` |

## Targeted Indexes Added

1. **`player_accounts(user_id)` (`idx_player_accounts_user_id`)**
   - **Justification**: Every analytics query filters by `pa.user_id = $1`. Without an index on `user_id`, retrieving the accounts belonging to a user requires a sequential scan on `player_accounts`. The index replaces sequential scans with targeted index scans as the table scales with more registered users and linked accounts.
2. **`move_motifs(motif_id)` (`idx_move_motifs_motif_id`)**
   - **Justification**: In `move_motifs`, the primary key is `(move_id, motif_id, kind)`. While index lookups by `move_id` are covered by the primary key, filtering or joining directly on `motif_id` (such as looking up tactical motifs or aggregating motif errors) required sequential scans. The index enables bitmap index scans and efficient hash joins.

## Rejected Index Candidates

- **`move_classifications(classification_id)`**:
  - *Analysis*: Tested bitmap index scan vs sequential scan. In analytics aggregations, moves across a player's games span all classification buckets (best, good, inaccuracy, mistake, blunder) across hundreds of thousands of rows. When joining across a user's analyzed games, the query planner prefers scanning via `move_id` (the primary key) or sequential scan over low-selectivity filtering on 5 classification IDs. Indexing `classification_id` added write amplification to move ingestion without providing join speedups in the multi-table analytics pipelines.
- **`moves(game_id, mover_color)`**:
  - *Analysis*: Rejected because `moves` is an ultra-hot write-heavy table. `moves` already has `UNIQUE (game_id, ply)`. Adding compound indexes to `moves` would degrade bulk insert throughput during ingestion while existing index scans on `(game_id, ply)` already provide fast per-game move retrieval.
- **`move_evals(engine_version_id)` / `move_mates(...)`**:
  - *Analysis*: Rejected in accordance with the repository design rules (`moves`, `move_evals`, and `move_mates` remain index-free except for primary keys and existing constraints defined by architecture). Stored evaluations and mates are joined strictly on `move_id` (their primary keys). Speculative secondary indexes on evaluation tables would increase storage and write amplification during worker analysis without benefiting analytics queries.
