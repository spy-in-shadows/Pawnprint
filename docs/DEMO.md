# 8-Minute System Demo Script

This script walks through an end-to-end demonstration of the Longitudinal Chess Analytics Engine in 8 minutes.

---

## 1. Environment & Service Startup (0:00 - 1:00)

1. **Start Database**:
   ```bash
   docker compose up -d
   ```
2. **Apply Migrations and Seed Relational Lookups**:
   ```bash
   npx prisma migrate deploy
   npm run seed
   ```
3. **Start API Server** (Terminal 1):
   ```bash
   npm run dev
   ```
4. **Start Analysis Worker Process** (Terminal 2):
   ```bash
   npm run worker
   ```
5. **Start Web Frontend** (Terminal 3):
   ```bash
   npm --prefix client run dev
   ```
6. Open your browser to `http://localhost:5173`.

**After a reboot**: start Docker Desktop, run `docker compose up -d` to start the database again, then start the API (`npm run dev`) and the worker (`npm run worker`) in their own terminals. The data is kept in the Docker volume, so there is no need to migrate or seed again.

---

## 2. Authentication, Account Linking & Game Ingestion (1:00 - 2:30)

1. **User Registration**:
   - Navigate to `/register`.
   - Register a user account (e.g. `demo@example.com` / `password123`).
   - Notice the automatic redirect to `/dashboard`.
2. **Link a Chess Account**:
   - Navigate to `/import`.
   - In "Link Account", select platform **Lichess** and enter a username (e.g. `DrNykterstein`, a public account with plenty of recent rapid and blitz games). Any account with at least 30 recent games works.
   - Click **Link Account**. The linked account appears in the Linked Accounts table.
3. **Trigger Ingestion**:
   - Click **Sync Games** on the newly linked account.
   - Enter `Max Games: 10` and submit.
   - Or, upload a standard PGN file via the **Upload PGN** file picker.
4. **Watch Progress**:
   - The Active Import Job card polls `/api/v1/imports/:id`.
   - Watch Terminal 2: the worker claims the job using `SKIP LOCKED`, launches Stockfish at depth 12, performs N+1 evaluations, detects tactical motifs, and commits evals in an atomic transaction.
   - The job completes with `status: completed` (transitioning `queued` -> `running` -> `completed`).

---

## 3. Analytics Dashboard Walkthrough (2:30 - 4:00)

1. Navigate to `/dashboard`.
2. **Summary Tiles**:
   - Notice the 4 top-level KPI tiles populated via sub-millisecond rollup `/api/v1/analytics/summary`:
     - **Analyzed Games** (e.g. 10 games, ~600 plies evaluated).
     - **Overall Accuracy** (win-probability based move rating).
     - **Blunders per 100 Moves**.
     - **Average Centipawn Loss**.
3. **Interactive Charts**:
   - **Opening Blunder Rate**: Top openings by moves sorted descending with ECO + Opening Name and ply bucket breakdown.
   - **Phase Accuracy**: Side-by-side accuracy comparison across Opening, Middlegame, and Endgame.
   - **Time Pressure Blunder Rate**: Blunder frequency across clock buckets strictly ordered: `>50%`, `25-50%`, `10-25%`, and `<10%`.
   - **Longitudinal Trend**: Daily accuracy plotted against 7-day rolling performance.
   - **Tactical Motif Weaknesses**: Dual-series bars comparing **Allowed** vs **Missed** errors per 100 moves, styled with distinct patterns for screen-reader and visual accessibility.
4. **Filter Controls**:
   - Change the account filter or date range; watch all charts reload simultaneously with error handling and empty states.

---

## 4. Games Explorer & Interactive Viewer (4:00 - 5:30)

1. Navigate to `/games`.
2. **Games List**:
   - Inspect pagination (20 games per page), columns for played date, win/loss result badge, opening ECO, time control, ratings, accuracy %, blunder count, and analysis status badge (with failure reason tooltip for failed games).
3. **Open Game Detail**:
   - Click on any analyzed game to navigate to `/games/:id`.
4. **Interactive Board Navigation**:
   - The chessboard is oriented according to the player's color (`white` or `black`).
   - Step forward and backward through plies using arrow buttons or keyboard Arrow Left / Right keys (`Home` / `End` for start/end).
   - Replay positions are computed accurately via `chess.js` and move FEN tracking.
5. **Evaluation Graph**:
   - Observe the White win-probability curve across plies.
   - Click any point on the graph to jump immediately to that move.
6. **Move Analysis Panel**:
   - Inspect the selected move details: classification (Best, Good, Inaccuracy `?!`, Mistake `?`, Blunder `??`), centipawn loss, engine best move converted to standard algebraic notation (SAN) via `chess.js`, clock remaining, and tactical motifs detected (`allowed` / `missed`).

---

## 5. Personalized Training & Interactive Puzzle Solver (5:30 - 6:45)

1. Navigate to `/training`.
2. **Generate Training Plan**:
   - Click **Generate New Plan**.
   - The server queries the user's weakest tactical motifs and weakest opening phases, computes their rating band, and pulls matching puzzles from the imported Lichess puzzle bank.
3. **Drill Organization**:
   - Puzzles are organized into categorized groups (`Tactical Motif Weakness` and `Opening Phase Weakness`).
4. **Drag-and-Drop Puzzle Solving**:
   - Select an uncompleted puzzle.
   - The board faces the solver's side; the opponent's setup move is already applied per Lichess convention.
   - Try a wrong move: the board snaps the piece back and flashes error feedback.
   - Click **Hint**: the from-square of the required solver move highlights in amber.
   - Make the correct move: the opponent automatically replies after a 350 ms delay.
   - Complete the final move: a success banner displays, and an asynchronous `PATCH` marks the drill as completed (`✓`).

---

## 6. System Verification, Benchmarks & Resiliency (6:45 - 7:30)

1. **Data Quality Verification**:
   ```bash
   npm run dq
   ```
   Show that all 9 relational integrity checks pass: `analyzed_games_have_all_evals`, `plies_contiguous`, `every_eval_has_classification`, `eval_ranges`, `mate_rows_consistent`, `failed_games_have_reason`, `no_orphan_progress`, `one_active_job_per_account`, and `engine_versions_unreferenced_dupes`.
2. **Crash-Recovery & Queue Concurrency**:
   ```bash
   npx vitest run tests/claim.concurrency.test.js
   npx vitest run tests/crashRecovery.test.js
   ```
   Highlight that `claim.concurrency.test.js` proves PostgreSQL `SKIP LOCKED` concurrency guarantees: three parallel workers race for 40 queued jobs with exactly 40 jobs claimed and zero double claims, plus single-job and stale-job races where exactly one worker claims the target job. In `crashRecovery.test.js`, worker process crash recovery automatically respawns Stockfish and resumes incomplete jobs without duplicate evaluation rows.
3. **Performance Benchmarks**:
   - Show `docs/benchmarks/insert.md`: PostgreSQL `UNNEST` delivers an 8.2x speedup over per-row ORM creates.
   - Show `docs/benchmarks/queries.md`: Precomputed summary tables answer in about 0.3 ms instead of about 242 ms for the base-table aggregate.

---

## 7. Key Architecture Questions & Answers (7:30 - 8:00)

### Q1: How does job claiming prevent race conditions between concurrent workers?
**Answer**:
Workers claim jobs with a single atomic PostgreSQL query:
```sql
UPDATE analysis_jobs
SET status = 'running', locked_by = $1, locked_at = NOW(), heartbeat_at = NOW(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE status = 'queued'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```
`FOR UPDATE SKIP LOCKED` causes transactions to skip any rows currently locked by other workers rather than waiting. Because the row lock and status transition occur in the same statement, exactly one worker claims each job without lock contention, deadlocks, or read-then-update race conditions.

### Q2: Why are all evaluations stored in White's perspective?
**Answer**:
Storing evaluations in White-perspective centipawns ensures positional scores are absolute and independent of whose turn it is. This allows:
1. Direct longitudinal evaluation graphs (like the win-probability chart) without alternating signs.
2. Safe position eval reuse: the "after" position of move K is identical to the "before" position of move K+1 without sign manipulation.
3. Centipawn loss and move quality are computed cleanly via `evalMath.js` by converting White-perspective scores to mover perspective only during the delta loss calculation.

### Q3: Why does PostgreSQL UNNEST outperform row-by-row ORM inserts?
**Answer**:
A standard 40-move chess game contains 40 to 80 plies. In a row-by-row ORM approach:
- Each move executes an independent `INSERT` query.
- This creates 40+ round trips across the network and forces 40+ write-ahead log (WAL) fsyncs.
Using PostgreSQL `UNNEST`:
- Moves are passed as parallel typed arrays (`ply[]`, `san[]`, `uci[]`, `fen[]`, `clock[]`).
- The entire game is inserted in a single multi-row `INSERT INTO moves ... SELECT FROM UNNEST(...)` statement within one transaction.
- This reduces write amplification to exactly 1 database round trip and 1 WAL flush per game, achieving ~13,000 moves/sec (8.2x faster than per-row creates).
