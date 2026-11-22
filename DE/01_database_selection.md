# 1. Database selection: PostgreSQL

Pawnprint stores a player's chess games, every move of every game, an engine evaluation for every move, and the summaries and training plans derived from them. We chose PostgreSQL 16 (run through `docker-compose.yml`, image `postgres:16`) instead of a document database such as MongoDB. This file explains why, based on the data the project actually holds.

All counts below come from the demo database (`chess_analytics`, see `DE/README.md` for how to connect) on 2026-11-22.

## 1.1 Nature of the data

| Kind of data | Tables | Rows in the demo database | Behaviour |
|---|---|---:|---|
| Identity | `users`, `player_accounts` | 2, 2 | Few rows, updated rarely (sync cursor `last_synced_at`) |
| Reference (lookup) data | `platforms`, `results`, `phases`, `classifications`, `motifs`, `time_controls`, `openings`, `engine_versions` | 3, 3, 3, 5, 7, 11, 500, 1 | Seeded once by `prisma/seed/index.js`, read on every insert and every analytics query |
| Game headers | `games` | 80 | One row per imported game |
| Move-level, time-series-like data | `moves`, `move_evals`, `move_classifications`, `move_mates`, `move_motifs` | 7,107, 7,107, 7,107, 127, 311 | Insert-only, written in bulk once per game, ordered by `ply` inside a game |
| Puzzle bank | `puzzles`, `puzzle_motifs` | 50,000, 16,600 | Imported once from the Lichess puzzle CSV |
| Work queue | `analysis_jobs`, `analysis_job_games` | 3, 80 | Small, but written concurrently by several worker processes |
| Derived summaries | `account_summary`, `account_phase_summary`, `training_plans`, `training_plan_items` | 2, 6, 2, 25 | Rebuilt or generated from the base tables |

Volume per game: the 80 demo games have between 9 and 166 plies, 88.8 on average, so one imported game produces about 80 to 150 `moves` rows plus the same number of `move_evals` and `move_classifications` rows, a few `move_mates` rows (127 for 7,107 moves) and a few `move_motifs` rows (311 for 7,107 moves). The move-level tables are by far the largest part of the game data (`moves` alone is 1,288 kB of the 21 MB database, which is otherwise dominated by the 50,000 puzzles).

## 1.2 Why a relational database fits this data

1. **Strongly related entities.** A user has player accounts; an account has games; a game has moves; a move has exactly one evaluation, one classification, at most one mate record and any number of motif tags. Every one of these links is a foreign key in the schema (28 foreign keys in total, listed in `02_er_diagram.md`).
2. **Many-to-many links.** Moves and motifs (`move_motifs`), puzzles and motifs (`puzzle_motifs`) and jobs and games (`analysis_job_games`) are many-to-many. In SQL they are plain link tables with a composite primary key. In a document store each of them would have to be embedded on one side and duplicated or looked up on the other.
3. **Aggregation across moves is the product.** Every analytics endpoint (`src/repositories/analytics.repo.js`) joins `moves`, `games`, `player_accounts`, `move_classifications`, `classifications` and a lookup table such as `phases`, `openings` or `time_controls`, then groups and counts. The trend endpoint uses a window function (`AVG(...) OVER (ORDER BY day RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW)`). These are single SQL statements in PostgreSQL (see queries Q05 to Q11 in `06_queries.md`).
4. **Constraints the database enforces for us.**
   - Unique keys: `games(platform_id, external_id)` makes imports idempotent; `player_accounts(platform_id, username)` stops two users from linking the same platform account; `moves(game_id, ply)` stops a move from being stored twice.
   - Foreign keys with `ON DELETE CASCADE` remove a game's moves and evaluations when an account is unlinked (query Q03).
   - A partial unique index, `idx_analysis_jobs_active_unique ON analysis_jobs(player_account_id) WHERE status IN ('queued','running')`, allows any number of finished jobs per account but only one active one (query Q16b shows the violation).
5. **Transactions.** `insertGameWithMoves` (`src/repositories/moveBulk.repo.js`) writes the game header and all its moves in one transaction, and `saveGameAnalysis` writes all evaluations, mates, classifications and motif tags of a game in one transaction. A crash in the middle leaves no half-analysed game.
6. **Concurrency.** Several workers claim jobs from the same table with one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` statement (`src/workers/jobQueue.js`). Row-level locks make this safe without a separate message broker (query Q12).
7. **Indexing.** B-tree indexes on the access paths we use (`games(player_account_id, played_at)` for the games list, `player_accounts(user_id)`, `move_motifs(motif_id)`, `analysis_jobs(status, created_at)` for the claim query). The evidence is in `docs/explain/` and `06_queries.md`.

## 1.3 What would be awkward in a document database

- **Cross-collection aggregation.** A "blunders by phase for all my games" query needs games, moves, classifications and phases together. If moves were embedded in a game document, every analytics query would have to unwind every move array of every game of the user; if moves were a separate collection, every query becomes a multi-stage `$lookup` pipeline, which is what a relational join already is.
- **Join-heavy analytics with lookups.** Opening names, phase names, classification names and time-control categories are stored once in lookup tables. In a document model they would be copied into every move or game document, and a rename would have to touch every copy.
- **Uniqueness across documents.** "One game per (platform, external id)" and "one active job per account" are rules about the whole collection, not about one document. A partial unique index across documents with a status filter is exactly what PostgreSQL offers directly.
- **Atomic multi-table writes.** Saving one game's analysis writes into four tables. With separate collections this needs multi-document transactions; with embedding it means rewriting a large game document after analysis.
- **Job queue semantics.** `FOR UPDATE SKIP LOCKED` has no direct equivalent; a document store would need find-and-modify loops or an external queue.

## 1.4 Trade-offs and how we handled them

The relational model is not free. The move tables are write-heavy: importing and analysing one game of average length inserts about 3 x 89 rows (`moves`, `move_evals`, `move_classifications`) plus its mate and motif rows, and storing one row per move costs more space than a compact array would (for example a full FEN string per move in `moves.fen_before`). We handled this in three ways. First, moves and evaluations are inserted with one `INSERT ... SELECT FROM UNNEST(...)` statement per table per game through the `pg` pool, not one statement per row; `docs/benchmarks/insert.md` measured 13,033 moves per second with UNNEST against 1,587 with per-row Prisma creates (8.2x). Second, the move tables carry only their primary key and one unique constraint, with no extra secondary indexes, so each insert updates as few index structures as possible (rejected index candidates are listed in `docs/explain/README.md`). Third, the expensive account-level aggregates are precomputed into `account_summary` and `account_phase_summary` after each job, so the dashboard does not re-aggregate the move tables on every page load (`docs/benchmarks/queries.md`: 0.29 ms for the summary read against 242.35 ms for the base-table aggregate at 10,000 games).
