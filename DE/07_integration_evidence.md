# 7. Integration evidence

This file shows that the application reads and writes the database described in files 1 to 6: (a) which code serves each feature, (b) how the backend talks to PostgreSQL, and (c) a live run in which data entered through the API is checked in the database and read back through the API.

## 7.1 Feature map

Request flow: route (`src/routes/*.routes.js`, mounted under `/api/v1` in `src/routes/v1/index.js`) -> controller (`src/controllers/`) -> service (`src/services/`) -> repository (`src/repositories/`) -> PostgreSQL. All routes except register, login and health go through the `authenticate` middleware. File and line references were checked with `grep -n` on the current `main`.

| Feature | Endpoint | Controller | Service | Repository or data function | SQL or Prisma call |
|---|---|---|---|---|---|
| Register | `POST /auth/register` | `register`, `src/controllers/auth.controller.js:3` | `register`, `src/services/auth.service.js:32` | `findByEmail`, `create`, `src/repositories/user.repo.js:3`, `:15` | Prisma `user.findUnique`, `user.create` (`users`) |
| Login | `POST /auth/login` | `login`, `src/controllers/auth.controller.js:13` | `login`, `src/services/auth.service.js:67` | `findByEmail`, `src/repositories/user.repo.js:3` | Prisma `user.findUnique`, then bcrypt compare |
| Link account | `POST /accounts` | `link`, `src/controllers/account.controller.js:12` | `linkAccount`, `src/services/account.service.js:34` | Prisma in the service | `platform.findUnique`, `playerAccount.findUnique` on `(platform_id, username)`, `playerAccount.create` |
| List accounts | `GET /accounts` | `list`, `src/controllers/account.controller.js:3` | `listAccounts`, `src/services/account.service.js:24` | Prisma in the service | `playerAccount.findMany` with `platform` |
| Unlink account | `DELETE /accounts/:id` | `unlink`, `src/controllers/account.controller.js:21` | `deleteAccount`, `src/services/account.service.js:87` | Prisma in the service | `playerAccount.delete`; the database cascades to games, moves, evaluations, jobs and summaries |
| Platform import | `POST /imports` | `create`, `src/controllers/import.controller.js:5` | `createImportJob`, `src/services/import.service.js:29` | Prisma in the service | `analysisJob.findFirst` (active job), `analysisJob.create`; a race on `idx_analysis_jobs_active_unique` returns the existing job |
| Import status | `GET /imports/:id` | `status`, `src/controllers/import.controller.js:36` | `getJobStatus`, `src/services/import.service.js:98` | Prisma in the service | `analysisJob.findUnique` with `jobGames` |
| PGN upload | `POST /uploads/pgn` | `uploadPgn`, `src/controllers/upload.controller.js:3` | `processPgnUpload`, `src/services/upload.service.js:7`, then `ingestParsedGames`, `src/services/import.service.js:139` | `insertGameWithMoves`, `src/repositories/moveBulk.repo.js:67` | `pg` transaction: `INSERT INTO games ... ON CONFLICT (platform_id, external_id) DO NOTHING`, `INSERT INTO moves ... SELECT FROM UNNEST(...)` |
| Analysis job (worker) | none (`npm run worker`) | none | `JobRunner.processJob`, `src/workers/jobRunner.js:181` | `claimNextJob`, `src/workers/jobQueue.js:78`; `saveGameAnalysis`, `src/repositories/moveBulk.repo.js:281`; `markJobFinished`, `src/workers/jobQueue.js:128` | `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`; UNNEST inserts into `move_evals`, `move_mates`, `move_classifications`, `move_motifs` in one transaction |
| Games list | `GET /games` | `list`, `src/controllers/game.controller.js:3` | `listGames`, `src/services/games.service.js:7` | `list`, `src/repositories/game.repo.js:5` | Prisma `game.count`, `game.findMany` (`orderBy playedAt desc`, `include` result, opening, time control, move classifications) |
| Game detail | `GET /games/:id` | `getDetail`, `src/controllers/game.controller.js:12` | `getGameDetail`, `src/services/games.service.js:55` | `getDetail`, `src/repositories/game.repo.js:129` | Prisma `game.findFirst` with moves, phase, eval, mate, classification, motifs |
| Analytics: openings | `GET /analytics/openings` | `openings`, `src/controllers/analytics.controller.js:3` | `getOpenings`, `src/services/analytics.service.js:46` | `getOpenings`, `src/repositories/analytics.repo.js:258` | raw SQL `OPENINGS_SQL` (`:3`) |
| Analytics: phases | `GET /analytics/phases` | `phases`, `:12` | `getPhases`, `:51` | `getPhases`, `:263` | raw SQL `PHASES_SQL` (`:39`), query Q07 |
| Analytics: time pressure | `GET /analytics/time-pressure` | `timePressure`, `:21` | `getTimePressure`, `:56` | `getTimePressure`, `:268` | raw SQL `TIME_PRESSURE_COUNT_SQL` (`:70`), `TIME_PRESSURE_BUCKETS_SQL` (`:85`), query Q08 |
| Analytics: trend | `GET /analytics/trend` | `trend`, `:30` | `getTrend`, `:61` | `getTrend`, `:280` | raw SQL `TREND_SQL` (`:136`) with a window function |
| Analytics: motifs | `GET /analytics/motifs` | `motifs`, `:39` | `getMotifs`, `:66` | `getMotifs`, `:285` | raw SQL `MOTIFS_SQL` (`:179`), query Q10 |
| Summary | `GET /analytics/summary` | `summary`, `src/controllers/analytics.controller.js:48` | `getSummary`, `src/services/analytics.service.js:79`, then `getAccountSummary`, `src/services/summary.service.js:136` | `pgPool.query` in the service | `SELECT ... FROM account_summary`, `account_phase_summary`; `refreshAccountSummary` (`:4`) upserts with `ON CONFLICT DO UPDATE` |
| Training plan: generate | `POST /training/plans` | `create`, `src/controllers/training.controller.js:14` | `generatePlan`, `src/services/training.service.js:51` | `getWeakestMotifs`, `src/repositories/analytics.repo.js:295`; `getWeakestOpeningPhases`, `:290`; `findPuzzlesForMotif`, `src/repositories/training.repo.js:66`; `createPlanWithItems`, `:114` | raw SQL for weaknesses; Prisma `puzzle.findMany`, nested `trainingPlan.create` with items |
| Training plan: list | `GET /training/plans` | `list`, `src/controllers/training.controller.js:5` | `listPlans`, `src/services/training.service.js:46` | `listUserPlans`, `src/repositories/training.repo.js:3` | Prisma `trainingPlan.findMany` with items, puzzle, motif |
| Training item done | `PATCH /training/plans/:planId/items/:itemId` | `updateItem`, `src/controllers/training.controller.js:23` | `setItemCompletion`, `src/services/training.service.js:132` | `findPlanById`, `updateItemCompletion`, `src/repositories/training.repo.js:19`, `:138` | Prisma `trainingPlan.findFirst` (owner check), `trainingPlanItem.updateMany` |

(Line numbers without a file name refer to the same file as in the first analytics row of that column.)

## 7.2 How the backend talks to the database

`src/config/db.js` creates the two database clients that every repository imports. Prisma is used for CRUD on identity, accounts, jobs and training (and owns the schema and migrations); a `pg` connection pool is used where we need exact SQL: the bulk inserts, the job queue and the analytics.

`src/config/db.js:17-26`, the two clients:

```js
export const prisma = new PrismaClient({
  log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

export const pgPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

`src/config/db.js:32-49`, the transaction helper used by `insertGameWithMoves`, `saveGameAnalysis` and `refreshAccountSummary`: one pooled connection, `BEGIN`, the caller's statements, then `COMMIT`, or `ROLLBACK` on any error:

```js
export async function withTransaction(fn) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Error rolling back transaction', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}
```

`src/repositories/moveBulk.repo.js:238-258`, all moves of one game in one statement (parallel typed arrays unnested into rows):

```js
      SELECT
        $1,
        u.ply,
        u.san,
        u.uci,
        u.fen_before,
        u.mover_color,
        u.clock_remaining_ms,
        u.time_spent_ms,
        u.phase_id
      FROM UNNEST(
        $2::int[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::int[],
        $8::int[],
        $9::int[]
      ) AS u(ply, san, uci, fen_before, mover_color, clock_remaining_ms, time_spent_ms, phase_id)
      ORDER BY u.ply ASC;
```

`src/workers/jobQueue.js:60-76`, the job claim (selection and update in one statement under a row lock):

```js
const CLAIM_SQL = `
  UPDATE analysis_jobs
  SET status = 'running',
      locked_by = $1,
      locked_at = (NOW() AT TIME ZONE 'UTC'),
      heartbeat_at = (NOW() AT TIME ZONE 'UTC'),
      attempts = attempts + 1
  WHERE id = (
    SELECT id FROM analysis_jobs
    WHERE (status = 'queued' AND attempts < ${MAX_ATTEMPTS})
       OR (status = 'running' AND attempts < ${MAX_ATTEMPTS}
           AND heartbeat_at < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => $2))
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *`;
```

`src/services/account.service.js:75-84`, a typical Prisma write:

```js
  return prisma.playerAccount.create({
    data: {
      userId,
      platformId: platformRecord.id,
      username: normalizedUsername,
    },
    include: {
      platform: true,
    },
  });
```

Migrations are applied with `npx prisma migrate deploy`; Prisma records them in `_prisma_migrations`. The only hand-written SQL in a migration is the partial unique index at the end of `20261112062647_puzzles_training_jobs`, because Prisma's schema language cannot express a partial index.

## 7.3 Live walkthrough

Setup, on 2026-11-22:

- Database: the demo database (`docker compose -p pawnprint-demo`, port 5435, as in `.env`). Its row counts before the walkthrough are listed in `05_sample_records.md`.
- API: `node src/server.js` (port 3000; `GET /api/v1/health` returned `{"status":"ok","database":{"pgPool":"connected","prisma":"connected"}}`). Worker: `node src/worker.js` with Stockfish 19 at depth 12. Both were started in the background as `README.md` describes and stopped at the end.
- `$S` below is a scratch directory. `$S/psql.sh` is a one-line wrapper around `docker compose -p pawnprint-demo exec -T db psql -U chess -d chess_analytics "$@"`, and `$S/token.txt` holds the JWT from the login step.
- The repository has no PGN in `tests/fixtures` (only `puzzles.csv`), so the upload used `$S/w_de-evidence.pgn`, a file with three well-known historical games, checked with the project's own parser (`parsePgnString`) before the run: 33, 21 and 82 plies, no parse errors.

```
[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0

[Event "Vienna"]
[Site "Vienna AUT"]
[Date "1910.??.??"]
[White "Richard Reti"]
[Black "Savielly Tartakower"]
[Result "1-0"]

1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nf6 5. Qd3 e5 6. dxe5 Qa5+ 7. Bd2 Qxe5 8. O-O-O Nxe4 9. Qd8+ Kxd8 10. Bg5+ Kc7 11. Bd8# 1-0

[Event "Rosenwald Memorial"]
[Site "New York USA"]
[Date "1956.10.17"]
[White "Donald Byrne"]
[Black "Robert James Fischer"]
[Result "0-1"]

1. Nf3 Nf6 2. c4 g6 3. Nc3 Bg7 4. d4 O-O 5. Bf4 d5 6. Qb3 dxc4 7. Qxc4 c6 8. e4 Nbd7 9. Rd1 Nb6 10. Qc5 Bg4 11. Bg5 Na4 12. Qa3 Nxc3 13. bxc3 Nxe4 14. Bxe7 Qb6 15. Bc4 Nxc3 16. Bc5 Rfe8+ 17. Kf1 Be6 18. Bxb6 Bxc4+ 19. Kg1 Ne2+ 20. Kf1 Nxd4+ 21. Kg1 Ne2+ 22. Kf1 Nc3+ 23. Kg1 axb6 24. Qb4 Ra4 25. Qxb6 Nxd1 26. h3 Rxa2 27. Kh2 Nxf2 28. Re1 Rxe1 29. Qd8+ Bf8 30. Nxe1 Bd5 31. Nf3 Ne4 32. Qb8 b5 33. h4 h5 34. Ne5 Kg7 35. Kg1 Bc5+ 36. Kf1 Ng3+ 37. Ke1 Bb4+ 38. Kd1 Bb3+ 39. Kc1 Ne2+ 40. Kb1 Nc3+ 41. Kc1 Rc2# 0-1
```

JSON responses are trimmed with `jq` to the fields that matter; the commands show the filter used.

### Steps 1 to 4: register, log in, link an account, upload games

```
### Step 1: register
$ curl -s -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' -d '{"email":"de-evidence@example.com","password":"evidence-pass-1"}' | jq '{user}'
{
  "user": {
    "id": 4,
    "email": "de-evidence@example.com"
  }
}

$ $S/psql.sh -c "SELECT id, email, created_at FROM users WHERE email = 'de-evidence@example.com'"
 id |          email          |       created_at       
----+-------------------------+------------------------
  4 | de-evidence@example.com | 2026-11-22 15:25:34.14
(1 row)


### Step 2: login
$ curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"de-evidence@example.com","password":"evidence-pass-1"}' | jq '{user, token: (.token[0:12] + "...")}'
{
  "user": {
    "id": 4,
    "email": "de-evidence@example.com"
  },
  "token": "eyJhbGciOiJI..."
}

### Step 3: link a Lichess account
$ curl -s -X POST http://localhost:3000/api/v1/accounts -H "Authorization: Bearer $(cat $S/token.txt)" -H 'Content-Type: application/json' -d '{"platform":"lichess","username":"de_evidence_player"}' | jq '{id, userId, username, platform: .platform.name, lastSyncedAt}'
{
  "id": 4,
  "userId": 4,
  "username": "de_evidence_player",
  "platform": "lichess",
  "lastSyncedAt": null
}

$ $S/psql.sh -c "SELECT pa.id, pa.user_id, p.name AS platform, pa.username, pa.last_synced_at FROM player_accounts pa JOIN platforms p ON p.id = pa.platform_id JOIN users u ON u.id = pa.user_id WHERE u.email = 'de-evidence@example.com'"
 id | user_id | platform |      username      | last_synced_at 
----+---------+----------+--------------------+----------------
  4 |       4 | lichess  | de_evidence_player | 
(1 row)


### Step 4: upload a PGN with three games
$ curl -s -X POST http://localhost:3000/api/v1/uploads/pgn -H "Authorization: Bearer $(cat $S/token.txt)" -F 'file=@$S/w_de-evidence.pgn' | jq '{insertedCount, skippedCount, job: {id: .job.id, status: .job.status, maxGames: .job.maxGames}}'
{
  "insertedCount": 3,
  "skippedCount": 0,
  "job": {
    "id": 8,
    "status": "queued",
    "maxGames": 3
  }
}

$ $S/psql.sh -c "SELECT g.id, p.name AS platform, g.external_id, g.played_at, g.color, r.code AS result, g.total_plies, g.analysis_status, (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS move_rows FROM games g JOIN platforms p ON p.id = g.platform_id JOIN results r ON r.id = g.result_id JOIN player_accounts pa ON pa.id = g.player_account_id JOIN users u ON u.id = pa.user_id WHERE u.email = 'de-evidence@example.com' ORDER BY g.id"
 id | platform |           external_id            |        played_at        | color | result | total_plies | analysis_status | move_rows 
----+----------+----------------------------------+-------------------------+-------+--------+-------------+-----------------+-----------
 85 | upload   | 47e05509adf0e56cb59b9a4505683838 | 2026-11-22 15:25:34.559 | white | win    |          33 | pending         |        33
 86 | upload   | 3e409b71882ec38ad14d8158efd7f46b | 2026-11-22 15:25:34.561 | white | win    |          21 | pending         |        21
 87 | upload   | d86a5f4b9b4a20b7082bc21fad4a4faf | 1956-10-17 00:00:00     | white | loss   |          82 | pending         |        82
(3 rows)
```

The upload created a second player account for the user on the `upload` platform (account 5, username taken from the email), stored three games with `analysis_status = 'pending'` and their 136 move rows, and queued job 8. The account id (5) and job id (8) are higher than one might expect because sequences had already advanced in earlier runs of `queries.sql` (rolled back inserts still use sequence values).

Note on `played_at`: the first two games have only a year in their `Date` header (`1858.??.??`, `1910.??.??`). The parser replaces each `?` with `01`, which gives an invalid date, so it falls back to the import time. The third game has a full date and was stored as 1956-10-17. This is listed under Known limitations.

### Step 5: the worker analyses the games

The worker claimed job 8 and finished it about 3 seconds later. Its two log lines for the job, shortened to the message fields (the timestamp and the worker id, which contains the host name, are left out):

```
"msg":"Job started","jobId":8,"accountId":5
"msg":"Job finished","jobId":8,"accountId":5,"insertedGames":0,"analyzedGames":3,"failedGames":0,"skippedGames":0
```

```
### Step 5: job status through the API and in the database
$ curl -s http://localhost:3000/api/v1/imports/8 -H "Authorization: Bearer $(cat $S/token.txt)" | jq '{id, status, totalGames, completedGames, failedGames, skippedGames}'
{
  "id": 8,
  "status": "completed",
  "totalGames": 3,
  "completedGames": 3,
  "failedGames": 0,
  "skippedGames": 0
}

$ $S/psql.sh -c "SELECT j.id, j.player_account_id, j.status, j.attempts, j.max_games, j.failed_games, j.finished_at IS NOT NULL AS finished FROM analysis_jobs j WHERE j.id = 8" -c "SELECT job_id, game_id, status, error FROM analysis_job_games WHERE job_id = 8 ORDER BY game_id"
 id | player_account_id |  status   | attempts | max_games | failed_games | finished 
----+-------------------+-----------+----------+-----------+--------------+----------
  8 |                 5 | completed |        1 |         3 |            0 | t
(1 row)

 job_id | game_id | status | error 
--------+---------+--------+-------
      8 |      85 | done   | 
      8 |      86 | done   | 
      8 |      87 | done   | 
(3 rows)


$ $S/psql.sh -c "SELECT g.id AS game_id, g.analysis_status, COUNT(m.id) AS moves, COUNT(e.move_id) AS move_evals, COUNT(mc.move_id) AS move_classifications, COUNT(mm.move_id) AS move_mates, (SELECT COUNT(*) FROM move_motifs x JOIN moves y ON y.id = x.move_id WHERE y.game_id = g.id) AS move_motifs FROM games g JOIN moves m ON m.game_id = g.id LEFT JOIN move_evals e ON e.move_id = m.id LEFT JOIN move_classifications mc ON mc.move_id = m.id LEFT JOIN move_mates mm ON mm.move_id = m.id WHERE g.id IN (85, 86, 87) GROUP BY g.id ORDER BY g.id"
 game_id | analysis_status | moves | move_evals | move_classifications | move_mates | move_motifs 
---------+-----------------+-------+------------+----------------------+------------+-------------
      85 | analyzed        |    33 |         33 |                   33 |          4 |           4
      86 | analyzed        |    21 |         21 |                   21 |          6 |           1
      87 | analyzed        |    82 |         82 |                   82 |         12 |           2
(3 rows)
```

Every move now has exactly one `move_evals` row and one `move_classifications` row; `move_mates` and `move_motifs` rows exist only for the moves that need them.

### Step 6: API responses match SQL on the same data

```
### Step 6: API responses compared with SQL
$ curl -s 'http://localhost:3000/api/v1/games?accountId=5' -H "Authorization: Bearer $(cat $S/token.txt)" | jq '{total, items: [.items[] | {id, color, result, totalPlies, analysisStatus, blunders, accuracyPct: (.accuracyPct*10|round/10)}]}'
{
  "total": 3,
  "items": [
    {
      "id": 86,
      "color": "white",
      "result": "win",
      "totalPlies": 21,
      "analysisStatus": "analyzed",
      "blunders": 0,
      "accuracyPct": 100
    },
    {
      "id": 85,
      "color": "white",
      "result": "win",
      "totalPlies": 33,
      "analysisStatus": "analyzed",
      "blunders": 1,
      "accuracyPct": 88.2
    },
    {
      "id": 87,
      "color": "white",
      "result": "loss",
      "totalPlies": 82,
      "analysisStatus": "analyzed",
      "blunders": 0,
      "accuracyPct": 92.7
    }
  ]
}

$ $S/psql.sh -c "SELECT g.id, g.color, r.code AS result, g.total_plies, g.analysis_status, COUNT(*) FILTER (WHERE c.name = 'blunder') AS blunders, ROUND(100.0 * COUNT(*) FILTER (WHERE c.name IN ('best','good')) / COUNT(m.id), 1) AS accuracy_pct FROM games g JOIN results r ON r.id = g.result_id JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color LEFT JOIN move_classifications mc ON mc.move_id = m.id LEFT JOIN classifications c ON c.id = mc.classification_id WHERE g.player_account_id = 5 GROUP BY g.id, g.color, r.code ORDER BY g.played_at DESC"
 id | color | result | total_plies | analysis_status | blunders | accuracy_pct 
----+-------+--------+-------------+-----------------+----------+--------------
 86 | white | win    |          21 | analyzed        |        0 |        100.0
 85 | white | win    |          33 | analyzed        |        1 |         88.2
 87 | white | loss   |          82 | analyzed        |        0 |         92.7
(3 rows)


$ curl -s 'http://localhost:3000/api/v1/analytics/summary' -H "Authorization: Bearer $(cat $S/token.txt)" | jq '.accounts[] | {accountId, totalGames, analyzedGames, totalMoves, inaccuracies, mistakes, blunders, avgCpLoss, accuracyPct, phases}'
{
  "accountId": 4,
  "totalGames": 0,
  "analyzedGames": 0,
  "totalMoves": 0,
  "inaccuracies": 0,
  "mistakes": 0,
  "blunders": 0,
  "avgCpLoss": 0,
  "accuracyPct": 0,
  "phases": [
    {
      "phase": "opening",
      "moves": 0,
      "blunders": 0,
      "avgCpLoss": 0
    },
    {
      "phase": "middlegame",
      "moves": 0,
      "blunders": 0,
      "avgCpLoss": 0
    },
    {
      "phase": "endgame",
      "moves": 0,
      "blunders": 0,
      "avgCpLoss": 0
    }
  ]
}
{
  "accountId": 5,
  "totalGames": 3,
  "analyzedGames": 3,
  "totalMoves": 69,
  "inaccuracies": 2,
  "mistakes": 2,
  "blunders": 1,
  "avgCpLoss": 28,
  "accuracyPct": 92.8,
  "phases": [
    {
      "phase": "opening",
      "moves": 29,
      "blunders": 0,
      "avgCpLoss": 12.9
    },
    {
      "phase": "middlegame",
      "moves": 40,
      "blunders": 1,
      "avgCpLoss": 39
    },
    {
      "phase": "endgame",
      "moves": 0,
      "blunders": 0,
      "avgCpLoss": 0
    }
  ]
}

$ $S/psql.sh -c "SELECT player_account_id, total_games, analyzed_games, total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct FROM account_summary WHERE player_account_id IN (4, 5)" -c "SELECT aps.player_account_id, p.name AS phase, aps.moves, aps.blunders, aps.avg_cp_loss FROM account_phase_summary aps JOIN phases p ON p.id = aps.phase_id WHERE aps.player_account_id = 5 ORDER BY p.id"
 player_account_id | total_games | analyzed_games | total_moves | inaccuracies | mistakes | blunders | avg_cp_loss | accuracy_pct 
-------------------+-------------+----------------+-------------+--------------+----------+----------+-------------+--------------
                 5 |           3 |              3 |          69 |            2 |        2 |        1 |          28 |         92.8
                 4 |           0 |              0 |           0 |            0 |        0 |        0 |           0 |            0
(2 rows)

 player_account_id |   phase    | moves | blunders | avg_cp_loss 
-------------------+------------+-------+----------+-------------
                 5 | opening    |    29 |        0 |        12.9
                 5 | middlegame |    40 |        1 |          39
                 5 | endgame    |     0 |        0 |           0
(3 rows)
```

The games list (Prisma, computed in `src/repositories/game.repo.js`) and the SQL aggregate agree on every game: same order, results, blunder counts and accuracy. The summary endpoint returns exactly the stored `account_summary` and `account_phase_summary` rows. The summary row for the linked Lichess account 4 (no games) did not exist before this call; `getAccountSummary` created it on first read with `refreshAccountSummary`.

### Steps 7 and 8: update and delete through the API

```
### Step 7: generate a training plan and complete one item
$ curl -s -X POST http://localhost:3000/api/v1/training/plans -H "Authorization: Bearer $(cat $S/token.txt)" | jq '{message, plan: {id: .plan.id, items: [.plan.items[] | {id, puzzleId, motifId, reasonCode, completedAt}]}}'
{
  "message": null,
  "plan": {
    "id": 3,
    "items": [
      {
        "id": 26,
        "puzzleId": 16,
        "motifId": 1,
        "reasonCode": "MOTIF_WEAKNESS:hanging_piece",
        "completedAt": null
      },
      {
        "id": 27,
        "puzzleId": 150,
        "motifId": 1,
        "reasonCode": "MOTIF_WEAKNESS:hanging_piece",
        "completedAt": null
      },
      {
        "id": 28,
        "puzzleId": 187,
        "motifId": 1,
        "reasonCode": "MOTIF_WEAKNESS:hanging_piece",
        "completedAt": null
      },
      {
        "id": 29,
        "puzzleId": 84,
        "motifId": 3,
        "reasonCode": "MOTIF_WEAKNESS:pin",
        "completedAt": null
      },
      {
        "id": 30,
        "puzzleId": 97,
        "motifId": 3,
        "reasonCode": "MOTIF_WEAKNESS:pin",
        "completedAt": null
      },
      {
        "id": 31,
        "puzzleId": 137,
        "motifId": 3,
        "reasonCode": "MOTIF_WEAKNESS:pin",
        "completedAt": null
      },
      {
        "id": 32,
        "puzzleId": 11,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME",
        "completedAt": null
      },
      {
        "id": 33,
        "puzzleId": 12,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME",
        "completedAt": null
      },
      {
        "id": 34,
        "puzzleId": 14,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME",
        "completedAt": null
      },
      {
        "id": 35,
        "puzzleId": 61,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_OPENING",
        "completedAt": null
      },
      {
        "id": 36,
        "puzzleId": 203,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_OPENING",
        "completedAt": null
      },
      {
        "id": 37,
        "puzzleId": 227,
        "motifId": null,
        "reasonCode": "OPENING_PHASE_WEAKNESS:Unknown_OPENING",
        "completedAt": null
      }
    ]
  }
}

$ $S/psql.sh -c "SELECT tp.id AS plan_id, tp.user_id, tpi.id AS item_id, tpi.puzzle_id, tpi.motif_id, tpi.reason_code, tpi.completed_at FROM training_plans tp JOIN training_plan_items tpi ON tpi.plan_id = tp.id WHERE tp.id = 3 ORDER BY tpi.id"
 plan_id | user_id | item_id | puzzle_id | motif_id |                reason_code                | completed_at 
---------+---------+---------+-----------+----------+-------------------------------------------+--------------
       3 |       4 |      26 |        16 |        1 | MOTIF_WEAKNESS:hanging_piece              | 
       3 |       4 |      27 |       150 |        1 | MOTIF_WEAKNESS:hanging_piece              | 
       3 |       4 |      28 |       187 |        1 | MOTIF_WEAKNESS:hanging_piece              | 
       3 |       4 |      29 |        84 |        3 | MOTIF_WEAKNESS:pin                        | 
       3 |       4 |      30 |        97 |        3 | MOTIF_WEAKNESS:pin                        | 
       3 |       4 |      31 |       137 |        3 | MOTIF_WEAKNESS:pin                        | 
       3 |       4 |      32 |        11 |          | OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME | 
       3 |       4 |      33 |        12 |          | OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME | 
       3 |       4 |      34 |        14 |          | OPENING_PHASE_WEAKNESS:Unknown_MIDDLEGAME | 
       3 |       4 |      35 |        61 |          | OPENING_PHASE_WEAKNESS:Unknown_OPENING    | 
       3 |       4 |      36 |       203 |          | OPENING_PHASE_WEAKNESS:Unknown_OPENING    | 
       3 |       4 |      37 |       227 |          | OPENING_PHASE_WEAKNESS:Unknown_OPENING    | 
(12 rows)


$ curl -s -X PATCH http://localhost:3000/api/v1/training/plans/3/items/26 -H "Authorization: Bearer $(cat $S/token.txt)" -H 'Content-Type: application/json' -d '{"completed":true}' | jq '{item: {id: .item.id, reasonCode: .item.reasonCode, completedAt: .item.completedAt}}'
{
  "item": {
    "id": 26,
    "reasonCode": "MOTIF_WEAKNESS:hanging_piece",
    "completedAt": "2026-11-22T15:26:13.438Z"
  }
}

$ $S/psql.sh -c "SELECT id, plan_id, reason_code, completed_at FROM training_plan_items WHERE id = 26"
 id | plan_id |         reason_code          |      completed_at       
----+---------+------------------------------+-------------------------
 26 |       3 | MOTIF_WEAKNESS:hanging_piece | 2026-11-22 15:26:13.438
(1 row)


### Step 8: unlink both accounts through the API and check the cascade
$ $S/psql.sh -c "SELECT pa.id AS account_id, (SELECT COUNT(*) FROM games g WHERE g.player_account_id = pa.id) AS games, (SELECT COUNT(*) FROM moves m JOIN games g ON g.id = m.game_id WHERE g.player_account_id = pa.id) AS moves, (SELECT COUNT(*) FROM move_evals e JOIN moves m ON m.id = e.move_id JOIN games g ON g.id = m.game_id WHERE g.player_account_id = pa.id) AS move_evals, (SELECT COUNT(*) FROM analysis_jobs j WHERE j.player_account_id = pa.id) AS jobs, (SELECT COUNT(*) FROM account_summary s WHERE s.player_account_id = pa.id) AS summaries FROM player_accounts pa WHERE pa.user_id = 4 ORDER BY pa.id" -c "SELECT (SELECT COUNT(*) FROM moves) AS all_moves, (SELECT COUNT(*) FROM move_evals) AS all_move_evals, (SELECT COUNT(*) FROM move_motifs) AS all_move_motifs"
 account_id | games | moves | move_evals | jobs | summaries 
------------+-------+-------+------------+------+-----------
          4 |     0 |     0 |          0 |    0 |         1
          5 |     3 |   136 |        136 |    1 |         1
(2 rows)

 all_moves | all_move_evals | all_move_motifs 
-----------+----------------+-----------------
      7243 |           7243 |             318
(1 row)


$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE http://localhost:3000/api/v1/accounts/4 -H "Authorization: Bearer $(cat $S/token.txt)"
HTTP 204

$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE http://localhost:3000/api/v1/accounts/5 -H "Authorization: Bearer $(cat $S/token.txt)"
HTTP 204

$ $S/psql.sh -c "SELECT COUNT(*) AS accounts_left FROM player_accounts WHERE user_id = 4" -c "SELECT COUNT(*) AS games_left FROM games WHERE id IN (85, 86, 87)" -c "SELECT COUNT(*) AS job_rows_left FROM analysis_jobs WHERE id = 8" -c "SELECT (SELECT COUNT(*) FROM moves) AS all_moves, (SELECT COUNT(*) FROM move_evals) AS all_move_evals, (SELECT COUNT(*) FROM move_motifs) AS all_move_motifs"
 accounts_left 
---------------
             0
(1 row)

 games_left 
------------
          0
(1 row)

 job_rows_left 
---------------
             0
(1 row)

 all_moves | all_move_evals | all_move_motifs 
-----------+----------------+-----------------
      7107 |           7107 |             311
(1 row)


$ curl -s 'http://localhost:3000/api/v1/games' -H "Authorization: Bearer $(cat $S/token.txt)" | jq '{total}'
{
  "total": 0
}
```

The training plan has 12 items: 3 puzzles each for the two weakest motifs and for the two weakest opening and phase combinations (the games have no ECO header, so the opening is `Unknown`). `PATCH` set `completed_at`, and psql shows the same timestamp. Deleting the two accounts through the API returned `204 No Content`; in the database the games, job and summary rows of the accounts are gone, and the totals of `moves` (7,243 to 7,107), `move_evals` (7,243 to 7,107) and `move_motifs` (318 to 311) fell by exactly the user's 136 moves and 7 motif tags. The user's training plan is still there, because plans belong to the user, not to an account.

### Step 9: clean-up

There is no API endpoint to delete a user, so the throwaway user was removed with SQL; `ON DELETE CASCADE` on `training_plans.user_id` and `training_plan_items.plan_id` removed the plan. The importer had also added the time control `(0, 0)` (the games had no `TimeControl` header); it is unused after the delete, so it was removed too.

```
### Step 9: clean up the throwaway user
$ $S/psql.sh -c "DELETE FROM users WHERE email = 'de-evidence@example.com' RETURNING id, email"
 id |          email          
----+-------------------------
  4 | de-evidence@example.com
(1 row)

DELETE 1

$ $S/psql.sh -c "DELETE FROM time_controls tc WHERE tc.base_seconds = 0 AND tc.increment_seconds = 0 AND NOT EXISTS (SELECT 1 FROM games g WHERE g.time_control_id = tc.id) RETURNING id, base_seconds, increment_seconds, category"
 id  | base_seconds | increment_seconds | category  
-----+--------------+-------------------+-----------
 115 |            0 |                 0 | classical
(1 row)

DELETE 1

$ $S/psql.sh -c "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM player_accounts) AS player_accounts, (SELECT COUNT(*) FROM games) AS games, (SELECT COUNT(*) FROM moves) AS moves, (SELECT COUNT(*) FROM move_evals) AS move_evals, (SELECT COUNT(*) FROM analysis_jobs) AS analysis_jobs, (SELECT COUNT(*) FROM training_plans) AS training_plans, (SELECT COUNT(*) FROM training_plan_items) AS training_plan_items, (SELECT COUNT(*) FROM time_controls) AS time_controls"
 users | player_accounts | games | moves | move_evals | analysis_jobs | training_plans | training_plan_items | time_controls 
-------+-----------------+-------+-------+------------+---------------+----------------+---------------------+---------------
     2 |               2 |    80 |  7107 |       7107 |             3 |              2 |                  25 |            11
(1 row)
```

A `diff` of the row counts of all 25 tables against the counts taken before the walkthrough printed nothing: the demo data is back to its original state.

## 7.4 Known limitations seen during the walkthrough

1. Partial PGN dates (`1858.??.??`) are stored as the import time instead of a date in that year (`src/chess/pgnParser.js`, the `headers.Date` branch replaces each `?` with `01`).
2. Importing a game without a `TimeControl` header creates or updates the `(0, 0)` row of `time_controls` (see `03_normalization.md`, Known limitations, item 3).
3. Users cannot be deleted through the API; only accounts can be unlinked.
4. `time_controls.id` jumped to 115 for the new row, because `INSERT ... ON CONFLICT DO UPDATE` takes a sequence value on every call, also when it updates an existing row. This only affects id values, not data.
