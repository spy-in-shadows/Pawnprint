# 5. Sample records

Every table has a sample in `DE/sample_data/<table>.csv`. The files were exported from the demo database with one `COPY (SELECT ...) TO STDOUT WITH (FORMAT csv, HEADER)` per table, using exactly the `SELECT` shown above each table below:

```
docker compose -p pawnprint-demo exec -T db psql -U chess -d chess_analytics \
  -c "COPY (<select>) TO STDOUT WITH (FORMAT csv, HEADER)" > DE/sample_data/<table>.csv
```

No value was edited after the export. Two things were left out on purpose, inside the export queries: `users.password_hash` is replaced by the literal `<hash omitted>`, and `analysis_jobs.locked_by` is not selected because it contains the host name of the machine that ran the worker. Only the demo user (`demo@example.com`) and that user's rows are exported.

The move-level samples all come from the same eight moves (plies 67 to 74 of game 20, move ids 1626 to 1633), so the rows of `moves`, `move_evals`, `move_mates`, `move_classifications` and `move_motifs` line up by `move_id`. Empty cells are NULL.

## Row counts of all tables

Counted on 2026-11-22 before the queries and the walkthrough, and again after them (unchanged):

```
      table_name       | rows  
-----------------------+-------
 account_phase_summary |     6
 account_summary       |     2
 analysis_job_games    |    80
 analysis_jobs         |     3
 classifications       |     5
 engine_versions       |     1
 games                 |    80
 motifs                |     7
 move_classifications  |  7107
 move_evals            |  7107
 move_mates            |   127
 move_motifs           |   311
 moves                 |  7107
 openings              |   500
 phases                |     3
 platforms             |     3
 player_accounts       |     2
 _prisma_migrations    |     6
 puzzle_motifs         | 16600
 puzzles               | 50000
 results               |     3
 time_controls         |    11
 training_plan_items   |    25
 training_plans        |     2
 users                 |     2
(25 rows)
```

`_prisma_migrations` is Prisma's own bookkeeping table and is not part of the data model.

## Samples

### 5.1 `users` (1 row, file [`sample_data/users.csv`](sample_data/users.csv))

The demo user only. The password hash is replaced by the literal text `<hash omitted>` in the export query; all other values are real.

```sql
SELECT id, email, '<hash omitted>' AS password_hash, created_at FROM users WHERE email = 'demo@example.com'
```

| `id` | `email` | `password_hash` | `created_at` |
|---|---|---|---|
| 1 | demo@example.com | `<hash omitted>` | 2026-11-15 05:03:51.763 |

### 5.2 `platforms` (3 rows, file [`sample_data/platforms.csv`](sample_data/platforms.csv))

All rows. The three sources a game can come from; `games.platform_id` and `player_accounts.platform_id` point here.

```sql
SELECT id, name FROM platforms ORDER BY id
```

| `id` | `name` |
|---|---|
| 1 | lichess |
| 2 | chesscom |
| 3 | upload |

### 5.3 `player_accounts` (1 row, file [`sample_data/player_accounts.csv`](sample_data/player_accounts.csv))

The demo user's linked Lichess account. `last_synced_at` is the import cursor (the newest stored game).

```sql
SELECT id, user_id, platform_id, username, last_synced_at, created_at FROM player_accounts WHERE user_id = 1 ORDER BY id
```

| `id` | `user_id` | `platform_id` | `username` | `last_synced_at` | `created_at` |
|---|---|---|---|---|---|
| 1 | 1 | 1 | DrNykterstein | 2026-10-14 18:04:06 | 2026-11-15 05:06:21.067 |

### 5.4 `results` (3 rows, file [`sample_data/results.csv`](sample_data/results.csv))

All rows. Results are stored from the account owner's side, so a `1-0` game is `win` for a white owner and `loss` for a black one.

```sql
SELECT id, code FROM results ORDER BY id
```

| `id` | `code` |
|---|---|
| 1 | win |
| 2 | loss |
| 3 | draw |

### 5.5 `time_controls` (10 rows, file [`sample_data/time_controls.csv`](sample_data/time_controls.csv))

The first 10 of 11 rows by clock. Shows the natural key (base, increment) and the derived category.

```sql
SELECT id, base_seconds, increment_seconds, category FROM time_controls ORDER BY base_seconds, increment_seconds LIMIT 10
```

| `id` | `base_seconds` | `increment_seconds` | `category` |
|---|---|---|---|
| 1 | 60 | 0 | bullet |
| 2 | 60 | 1 | bullet |
| 3 | 120 | 1 | bullet |
| 4 | 180 | 0 | blitz |
| 5 | 180 | 2 | blitz |
| 6 | 300 | 0 | blitz |
| 7 | 300 | 3 | blitz |
| 8 | 600 | 0 | rapid |
| 9 | 600 | 5 | rapid |
| 10 | 900 | 10 | rapid |

### 5.6 `openings` (8 rows, file [`sample_data/openings.csv`](sample_data/openings.csv))

The openings of the demo user's games 1 to 8 (8 of the 500 seeded rows). One name per ECO code.

```sql
SELECT o.id, o.eco, o.name FROM openings o WHERE o.id IN (SELECT opening_id FROM games WHERE player_account_id = 1 AND id <= 8) ORDER BY o.eco
```

| `id` | `eco` | `name` |
|---|---|---|
| 1 | A00 | Uncommon Opening |
| 77 | A50 | Indian Defense: Normal Variation |
| 126 | B02 | Alekhine Defense |
| 130 | B06 | Modern Defense |
| 134 | B13 | Caro-Kann Defense: Exchange Variation |
| 169 | B51 | Sicilian Defense: Moscow Variation |
| 308 | D01 | Rapport-Jobava System |
| 462 | E61 | King's Indian Defense |

### 5.7 `games` (5 rows, file [`sample_data/games.csv`](sample_data/games.csv))

Four recent games of the demo account plus game 20, whose moves are shown below. `opening_id`, `time_control_id` and `result_id` point to the lookup tables above.

```sql
SELECT id, player_account_id, platform_id, external_id, played_at, color, result_id, opening_id, time_control_id, player_rating, opponent_rating, total_plies, analysis_status, failure_reason FROM games WHERE id IN (1, 2, 3, 4, 20) ORDER BY id
```

| `id` | `player_account_id` | `platform_id` | `external_id` | `played_at` | `color` | `result_id` | `opening_id` | `time_control_id` | `player_rating` | `opponent_rating` | `total_plies` | `analysis_status` | `failure_reason` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | HqjDTU4A | 2026-10-14 18:04:06 | white | 1 | 77 | 4 | 3177 | 2848 | 91 | analyzed |  |
| 2 | 1 | 1 | iVshKPMF | 2026-10-14 18:02:18 | black | 1 | 308 | 4 | 3177 | 2230 | 34 | analyzed |  |
| 3 | 1 | 1 | J3C5rR4Z | 2026-10-14 18:00:01 | black | 1 | 169 | 4 | 3153 | 2853 | 36 | analyzed |  |
| 4 | 1 | 1 | zR8HRccT | 2026-10-06 15:42:25 | white | 1 | 1 | 1 | 3254 | 3029 | 127 | analyzed |  |
| 20 | 1 | 1 | G3tGP3Qv | 2026-03-17 23:05:19 | black | 1 | 147 | 1 | 3277 | 3015 | 74 | analyzed |  |

### 5.8 `phases` (3 rows, file [`sample_data/phases.csv`](sample_data/phases.csv))

All rows. Every move points to one phase (`moves.phase_id`).

```sql
SELECT id, name FROM phases ORDER BY id
```

| `id` | `name` |
|---|---|
| 1 | opening |
| 2 | middlegame |
| 3 | endgame |

### 5.9 `moves` (8 rows, file [`sample_data/moves.csv`](sample_data/moves.csv))

Plies 67 to 74 of game 20 (the account played black and won by mate on ply 74). These eight moves are the ones used by every move-level sample below.

```sql
SELECT id, game_id, ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id FROM moves WHERE game_id = 20 AND ply BETWEEN 67 AND 74 ORDER BY ply
```

| `id` | `game_id` | `ply` | `san` | `uci` | `fen_before` | `mover_color` | `clock_remaining_ms` | `time_spent_ms` | `phase_id` |
|---|---|---|---|---|---|---|---|---|---|
| 1626 | 20 | 67 | Rf1 | h1f1 | 6k1/5p2/3pp1n1/pp4P1/2b1P3/r2BK1P1/2P4R/7R w - - 0 34 | white | 27000 | 2000 | 3 |
| 1627 | 20 | 68 | Ne5 | g6e5 | 6k1/5p2/3pp1n1/pp4P1/2b1P3/r2BK1P1/2P4R/5R2 b - - 1 34 | black | 27000 | 2000 | 3 |
| 1628 | 20 | 69 | Rd1 | f1d1 | 6k1/5p2/3pp3/pp2n1P1/2b1P3/r2BK1P1/2P4R/5R2 w - - 2 35 | white | 26000 | 1000 | 3 |
| 1629 | 20 | 70 | Ng4+ | e5g4 | 6k1/5p2/3pp3/pp2n1P1/2b1P3/r2BK1P1/2P4R/3R4 b - - 3 35 | black | 26000 | 1000 | 3 |
| 1630 | 20 | 71 | Kf4 | e3f4 | 6k1/5p2/3pp3/pp4P1/2b1P1n1/r2BK1P1/2P4R/3R4 w - - 4 36 | white | 23000 | 3000 | 3 |
| 1631 | 20 | 72 | Nxh2 | g4h2 | 6k1/5p2/3pp3/pp4P1/2b1PKn1/r2B2P1/2P4R/3R4 b - - 5 36 | black | 26000 | 0 | 3 |
| 1632 | 20 | 73 | Bxc4 | d3c4 | 6k1/5p2/3pp3/pp4P1/2b1PK2/r2B2P1/2P4n/3R4 w - - 0 37 | white | 23000 | 0 | 3 |
| 1633 | 20 | 74 | Rf3# | a3f3 | 6k1/5p2/3pp3/pp4P1/2B1PK2/r5P1/2P4n/3R4 b - - 0 37 | black | 25000 | 1000 | 3 |

### 5.10 `engine_versions` (1 row, file [`sample_data/engine_versions.csv`](sample_data/engine_versions.csv))

The only row: every evaluation in the demo data was made by Stockfish 19 at depth 12 with 1 thread and 64 MB hash.

```sql
SELECT id, name, version, default_depth, threads, hash_size FROM engine_versions ORDER BY id
```

| `id` | `name` | `version` | `default_depth` | `threads` | `hash_size` |
|---|---|---|---|---|---|
| 1 | Stockfish | 19 | 12 | 1 | 64 |

### 5.11 `move_evals` (8 rows, file [`sample_data/move_evals.csv`](sample_data/move_evals.csv))

The evaluations of the same eight moves (one row per move). Scores are White-perspective centipawns; `eval_before_cp` of each ply equals `eval_after_cp` of the previous ply.

```sql
SELECT e.move_id, e.eval_before_cp, e.eval_after_cp, e.best_uci, e.depth, e.engine_version_id FROM move_evals e JOIN moves m ON m.id = e.move_id WHERE m.game_id = 20 AND m.ply BETWEEN 67 AND 74 ORDER BY m.ply
```

| `move_id` | `eval_before_cp` | `eval_after_cp` | `best_uci` | `depth` | `engine_version_id` |
|---|---|---|---|---|---|
| 1626 | -59 | -241 | e3d2 | 12 | 1 |
| 1627 | -241 | -209 | g6e5 | 12 | 1 |
| 1628 | -209 | -606 | h2h5 | 12 | 1 |
| 1629 | -606 | -606 | e5g4 | 12 | 1 |
| 1630 | -606 | -558 | e3f4 | 12 | 1 |
| 1631 | -558 | -540 | g4h2 | 12 | 1 |
| 1632 | -540 | -9990 | g3g4 | 12 | 1 |
| 1633 | -9990 | -10000 | a3f3 | 12 | 1 |

### 5.12 `move_mates` (2 rows, file [`sample_data/move_mates.csv`](sample_data/move_mates.csv))

Only two of the eight moves have a mate row: before ply 73 there was no forced mate yet (`mate_before` empty) and after it Black mates in 1 (`-1`; mate distances are stored from White's side like the centipawn scores, see `src/chess/stockfishClient.js`); ply 74 delivers mate (`mate_after` 0). The other six moves have no row, which is why this table is sparse.

```sql
SELECT mm.move_id, mm.mate_before, mm.mate_after FROM move_mates mm JOIN moves m ON m.id = mm.move_id WHERE m.game_id = 20 AND m.ply BETWEEN 67 AND 74 ORDER BY m.ply
```

| `move_id` | `mate_before` | `mate_after` |
|---|---|---|
| 1632 |  | -1 |
| 1633 | -1 | 0 |

### 5.13 `classifications` (5 rows, file [`sample_data/classifications.csv`](sample_data/classifications.csv))

All rows. The five move classes, ordered from best to worst.

```sql
SELECT id, name FROM classifications ORDER BY id
```

| `id` | `name` |
|---|---|
| 1 | best |
| 2 | good |
| 3 | inaccuracy |
| 4 | mistake |
| 5 | blunder |

### 5.14 `move_classifications` (8 rows, file [`sample_data/move_classifications.csv`](sample_data/move_classifications.csv))

Classification and centipawn loss of the same eight moves (one row per move, joined to `classifications` by id).

```sql
SELECT mc.move_id, mc.classification_id, mc.cp_loss FROM move_classifications mc JOIN moves m ON m.id = mc.move_id WHERE m.game_id = 20 AND m.ply BETWEEN 67 AND 74 ORDER BY m.ply
```

| `move_id` | `classification_id` | `cp_loss` |
|---|---|---|
| 1626 | 4 | 182 |
| 1627 | 2 | 32 |
| 1628 | 5 | 397 |
| 1629 | 1 | 0 |
| 1630 | 1 | 0 |
| 1631 | 1 | 18 |
| 1632 | 3 | 460 |
| 1633 | 1 | 0 |

### 5.15 `motifs` (7 rows, file [`sample_data/motifs.csv`](sample_data/motifs.csv))

All rows. The seven tactical motifs detected by `src/chess/motifs.js`.

```sql
SELECT id, name FROM motifs ORDER BY id
```

| `id` | `name` |
|---|---|
| 1 | hanging_piece |
| 2 | fork |
| 3 | pin |
| 4 | skewer |
| 5 | back_rank |
| 6 | discovered_attack |
| 7 | missed_mate |

### 5.16 `move_motifs` (2 rows, file [`sample_data/move_motifs.csv`](sample_data/move_motifs.csv))

The motif tags of the same eight moves: ply 67 allowed a pin (motif 3) and ply 69 allowed a fork (motif 2). Both moves are white moves, the opponent's, classified `mistake` and `blunder` above.

```sql
SELECT mt.move_id, mt.motif_id, mt.kind FROM move_motifs mt JOIN moves m ON m.id = mt.move_id WHERE m.game_id = 20 AND m.ply BETWEEN 67 AND 74 ORDER BY m.ply, mt.motif_id, mt.kind
```

| `move_id` | `motif_id` | `kind` |
|---|---|---|
| 1626 | 3 | allowed |
| 1628 | 2 | allowed |

### 5.17 `puzzles` (8 rows, file [`sample_data/puzzles.csv`](sample_data/puzzles.csv))

The puzzles referenced by those plan items.

```sql
SELECT id, lichess_id, fen, moves_uci, rating, phase_tag FROM puzzles WHERE id IN (SELECT puzzle_id FROM training_plan_items WHERE plan_id = 1 ORDER BY id LIMIT 8) ORDER BY id
```

| `id` | `lichess_id` | `fen` | `moves_uci` | `rating` | `phase_tag` |
|---|---|---|---|---|---|
| 1211 | 00jmD | 8/1pp5/8/PP4p1/3k1pP1/8/1bbBB3/5K2 b - - 2 41 | c2d3 e2d3 d4d3 d2e1 d3c4 a5a6 b7a6 b5a6 b2d4 e1f2 | 2991 | endgame |
| 3272 | 023Uk | 4r1k1/7p/pR4p1/2p5/2qrppQ1/P6P/2P2PP1/1R4K1 b - - 1 33 | e4e3 b6g6 g8h8 g4f5 h7g6 f5f6 | 2993 | endgame |
| 3981 | 02TvL | 2k4r/p1p3q1/P4p2/2p5/Q1NP4/2P2K1P/6p1/R7 w - - 0 28 | a1g1 h8h3 f3e2 g7g6 c4d6 c8d8 a4e8 g6e8 d6e8 d8e8 g1g2 h3c3 | 3001 | endgame |
| 10950 | 06oZg | 1rb2rk1/6bp/1qppp1p1/2n3P1/p3PP2/1PN2B2/P1PB3Q/2KR3R b - - 1 19 | a4b3 h2h7 g8f7 c3b5 b6b5 d2c3 | 2991 | middlegame |
| 13756 | 08X30 | 8/4R1pp/p2R4/1p2P3/1b6/4k3/6PP/r2B2K1 b - - 2 33 | b4d6 e5d6 e3d2 e7f7 | 2988 | endgame |
| 15844 | 09oCo | 1r2r3/4pRbk/p2pP1p1/q1p3Bp/4P2P/2NQ4/p5P1/K4R2 w - - 2 27 | g5e7 a5a3 f7g7 h7h8 d3d2 b8b1 | 3056 | middlegame |
| 41981 | 0Q7iD | 6rk/1p6/3P1b1p/p4b1q/7P/2P3Q1/PP4BK/R4R2 w - - 1 38 | g3f4 f6h4 h2g1 h5g6 f4e5 g8g7 | 3090 | middlegame |
| 44685 | 0Rokb | 5rk1/1b3N2/pq4p1/1p1p4/3r4/1P3Q2/P6P/R4R1K b - - 0 25 | d4h4 f7h6 g8h7 f3f8 d5d4 h1g1 d4d3 f1f2 b6e3 h6f5 e3g5 g1f1 g6f5 f8f7 | 3042 | middlegame |

### 5.18 `puzzle_motifs` (4 rows, file [`sample_data/puzzle_motifs.csv`](sample_data/puzzle_motifs.csv))

The motif tags of those puzzles that match one of the seven motifs.

```sql
SELECT pm.puzzle_id, pm.motif_id FROM puzzle_motifs pm WHERE pm.puzzle_id IN (SELECT puzzle_id FROM training_plan_items WHERE plan_id = 1 ORDER BY id LIMIT 8) ORDER BY pm.puzzle_id, pm.motif_id
```

| `puzzle_id` | `motif_id` |
|---|---|
| 10950 | 3 |
| 13756 | 6 |
| 41981 | 3 |
| 44685 | 6 |

### 5.19 `training_plans` (1 row, file [`sample_data/training_plans.csv`](sample_data/training_plans.csv))

The demo user's training plan.

```sql
SELECT id, user_id, created_at FROM training_plans WHERE user_id = 1 ORDER BY id
```

| `id` | `user_id` | `created_at` |
|---|---|---|
| 1 | 1 | 2026-11-15 05:07:41.834 |

### 5.20 `training_plan_items` (8 rows, file [`sample_data/training_plan_items.csv`](sample_data/training_plan_items.csv))

The first 8 items of that plan. Motif items carry `motif_id`; opening and phase items have no motif and a structured `reason_code`.

```sql
SELECT id, plan_id, puzzle_id, motif_id, reason_code, completed_at FROM training_plan_items WHERE plan_id = 1 ORDER BY id LIMIT 8
```

| `id` | `plan_id` | `puzzle_id` | `motif_id` | `reason_code` | `completed_at` |
|---|---|---|---|---|---|
| 1 | 1 | 10950 | 3 | MOTIF_WEAKNESS:pin | 2026-11-15 05:10:19.789 |
| 2 | 1 | 41981 | 3 | MOTIF_WEAKNESS:pin |  |
| 3 | 1 | 13756 | 6 | MOTIF_WEAKNESS:discovered_attack |  |
| 4 | 1 | 44685 | 6 | MOTIF_WEAKNESS:discovered_attack |  |
| 5 | 1 | 1211 |  | OPENING_PHASE_WEAKNESS:B01_ENDGAME |  |
| 6 | 1 | 3272 |  | OPENING_PHASE_WEAKNESS:B01_ENDGAME |  |
| 7 | 1 | 3981 |  | OPENING_PHASE_WEAKNESS:B01_ENDGAME |  |
| 8 | 1 | 15844 |  | OPENING_PHASE_WEAKNESS:A00_MIDDLEGAME |  |

### 5.21 `analysis_jobs` (2 rows, file [`sample_data/analysis_jobs.csv`](sample_data/analysis_jobs.csv))

The demo account's two completed jobs. The `locked_by` column is left out of the export because it holds the worker's host name; all other columns are shown.

```sql
SELECT id, player_account_id, status, attempts, max_games, since, until, locked_at, heartbeat_at, error, failed_games, skipped_games, created_at, finished_at FROM analysis_jobs WHERE player_account_id = 1 ORDER BY id
```

| `id` | `player_account_id` | `status` | `attempts` | `max_games` | `since` | `until` | `locked_at` | `heartbeat_at` | `error` | `failed_games` | `skipped_games` | `created_at` | `finished_at` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | completed | 1 | 30 |  |  | 2026-11-15 05:06:21.817 | 2026-11-15 05:07:11.823 |  | 0 | 0 | 2026-11-15 05:06:21.116 | 2026-11-15 05:07:22.702 |
| 2 | 1 | completed | 1 | 10 |  |  | 2026-11-15 05:08:45.143 | 2026-11-15 05:08:45.148 |  | 0 | 0 | 2026-11-15 05:08:44.351 | 2026-11-15 05:08:45.564 |

### 5.22 `analysis_job_games` (5 rows, file [`sample_data/analysis_job_games.csv`](sample_data/analysis_job_games.csv))

Progress rows of job 1 for the five games above; all reached `done`.

```sql
SELECT job_id, game_id, status, error FROM analysis_job_games WHERE job_id = 1 AND game_id IN (1, 2, 3, 4, 20) ORDER BY game_id
```

| `job_id` | `game_id` | `status` | `error` |
|---|---|---|---|
| 1 | 1 | done |  |
| 1 | 2 | done |  |
| 1 | 3 | done |  |
| 1 | 4 | done |  |
| 1 | 20 | done |  |

### 5.23 `account_summary` (1 row, file [`sample_data/account_summary.csv`](sample_data/account_summary.csv))

The demo account's rollup row (derived, rebuilt after each job).

```sql
SELECT player_account_id, total_games, analyzed_games, total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct, last_game_at, refreshed_at FROM account_summary WHERE player_account_id = 1
```

| `player_account_id` | `total_games` | `analyzed_games` | `total_moves` | `inaccuracies` | `mistakes` | `blunders` | `avg_cp_loss` | `accuracy_pct` | `last_game_at` | `refreshed_at` |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 30 | 30 | 1194 | 68 | 45 | 17 | 29.3 | 89.1 | 2026-10-14 18:04:06 | 2026-11-15 05:08:45.566 |

### 5.24 `account_phase_summary` (3 rows, file [`sample_data/account_phase_summary.csv`](sample_data/account_phase_summary.csv))

The demo account's rollup per phase (phase ids 1 to 3).

```sql
SELECT player_account_id, phase_id, moves, blunders, avg_cp_loss FROM account_phase_summary WHERE player_account_id = 1 ORDER BY phase_id
```

| `player_account_id` | `phase_id` | `moves` | `blunders` | `avg_cp_loss` |
|---|---|---|---|---|
| 1 | 1 | 293 | 0 | 15.2 |
| 1 | 2 | 531 | 14 | 37.7 |
| 1 | 3 | 370 | 3 | 28.3 |
