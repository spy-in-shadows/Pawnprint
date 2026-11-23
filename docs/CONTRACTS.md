# Interface contracts

This file is the single source of truth for module signatures. Changes need B's approval.

All modules are ES modules. Schema and routes follow DESIGN.md sections 4 and 11, plus the additions below.

**Schema additions beyond DESIGN.md**
- `games.analysis_status` (`pending` | `analyzed` | `failed`, default `pending`) and `games.failure_reason`.
- `analysis_jobs`: `max_games` (default 50), `since`, `until`, `failed_games`, `skipped_games`; partial unique index allowing one `queued`/`running` job per account.
- `player_accounts.last_synced_at`.
- `analysis_job_games.status` is `pending` | `analyzing` | `done` | `failed`.
- `move_motifs.kind` (`allowed` | `missed`), primary key `(move_id, motif_id, kind)`.
- `engine_versions` unique on `(name, version, default_depth, threads, hash_size)`; rows are immutable.
- `puzzles.phase_tag` (`opening` | `middlegame` | `endgame` | null).
- All child relations use `onDelete: Cascade` (account -> games -> moves -> evals/mates/classifications/motifs; account -> jobs -> job_games; user -> accounts and plans -> items).
- C adds two summary tables in C7: `account_summary(player_account_id PK, total_games, analyzed_games, total_moves, inaccuracies, mistakes, blunders, avg_cp_loss, accuracy_pct, last_game_at, refreshed_at)` and `account_phase_summary(player_account_id, phase_id, moves, blunders, avg_cp_loss, PRIMARY KEY(player_account_id, phase_id))`.
- C adds `GET /api/v1/analytics/summary` (reads the summary tables) in C7. Analytics count only the account owner's moves (`moves.mover_color = games.color`) in analyzed games.
- All raw SQL timestamps use `(NOW() AT TIME ZONE 'UTC')`.

**Modules**

| Module | Exports |
|---|---|
| `src/config/env.js` (A) | default `config`: `{port, nodeEnv, databaseUrl, jwtSecret, accessTokenTtl='15m', refreshTokenTtlDays=7, stockfishPath, engineDepth=12, engineThreads=1, engineHashMb=64, pgPoolMax=10, logLevel, jobStaleSeconds=120, corsOrigins=[], prismaLogQueries=false}` (`JWT_EXPIRES_IN` is no longer read; use `ACCESS_TOKEN_TTL`) |
| `src/config/db.js` (A) | `prisma`, `pgPool`, `withTransaction(fn)`, `closeDb()` |
| `src/utils/logger.js` (A) | `logger.{debug,info,warn,error}(msg, meta?)`, `logger.child(baseMeta)` returns a logger that merges `baseMeta` into every line |
| `src/utils/errors.js` (B) | `AppError(status, message, code)`, `NotFoundError`, `ValidationError`, `UnauthorizedError` (401, `UNAUTHORIZED`), `ForbiddenError` (403, `FORBIDDEN`), `ConflictError` (409, `CONFLICT`), `DataError` (`isDataError=true`), `EngineError` (`isEngineError=true`) |
| `src/chess/evalMath.js` (B) | `MATE_CP=10000`, `EVAL_CAP_CP=1000`, `perspective(cp,color)`, `mateToCp(mateMoves, moverColor)`, `winProbability(cp)`, `evaluateMoveQuality({evalBeforeCp, evalAfterCp, moverColor})` returns `{cpLoss, wpDrop, classification}` |
| `src/chess/phase.js` (B) | `classifyPhase(fen, ply)` returns `'opening'`/`'middlegame'`/`'endgame'` |
| `src/chess/fen.js` (B) | `validateFen(fen)` returns `{ok, error}` |
| `src/chess/pgnParser.js` (A) | `parsePgnStream(readable)` async generator of **ParsedGame**; `async parsePgnString(str)` resolves to an array of **ParsedGame**; `parseClockToMs`, `parseTimeControl` |
| `src/ingest/*Client.js` (A) | `fetchUserGames(username, {max, since, until, delayMs, stats})` async generator of ParsedGame; `stats.skippedGames` counts skipped; `isStandardChess(game)` |
| `src/repositories/moveBulk.repo.js` (A) | `insertGameWithMoves(accountId, parsedGame)` returns `{gameId, isNew}`; `saveGameAnalysis({gameId, engineVersionId, moves})`; `markGameFailed(gameId, reason)` |
| `src/services/import.service.js` (A) | `createImportJob(userId, {accountId, maxGames, since, until})`; `getJobStatus(userId, jobId)`; `ingestParsedGames(accountId, games)` returns `{insertedCount, insertedGameIds, newestPlayedAt}`; `getPendingGameIds(accountId, limit)` |
| `src/workers/jobQueue.js` (B) | `claimNextJob(workerId)`, `heartbeat(jobId)`, `sweepPoisonJobs(maxAttempts=3)`, `updateGameProgress(jobId, gameId, status, error?)`, `markJobFinished(jobId, {failedGames, skippedGames})`, `markJobFailed(jobId, message)` |
| `src/chess/stockfishClient.js` (B) | class `StockfishClient({binaryPath, depth, threads, hashSize, positionTimeoutMs=10000, maxCrashes=3, spawnFn})` (defaults from `config`): `init()`, `newGame()`, `evaluatePosition(fen, depth?)` returns `{evalCp, mate, bestUci, depth}` (**all White perspective**: `evalCp` is always a number, the bounded centipawn equivalent via `mateToCp` when the engine reports a mate; `mate` is `null` or the White-perspective mate distance, positive = White mates), `quit()`; props `engineName`, `engineVersion`, `threads`, `hashSize`, `depth`, `crashCount`, `hasCrashedTooManyTimes` |
| `src/chess/motifs.js` (B) | `detectMotifs({fenBefore, fenAfter, moveUci, bestUci, bestReplyUci, classification})` returns `[{name, kind}]`; `isMissedMate(mateBefore, mateAfter, moverColor)` |
| `src/services/summary.service.js` (C) | `refreshAccountSummary(accountId)` (rebuilds `account_summary` and `account_phase_summary` rows for the account; idempotent); `getAccountSummary(userId, accountId?)` returns `{accounts:[...]}` |
| `src/services/drill.js` (C) | `prepareDrill(puzzle)` returns `{startFen, solverColor, setupMove, solverMoves[], opponentReplies[]}` using the Lichess convention (Moves[0] is the opponent's setup move) |
| `src/workers/engineRegistry.js` (B) | `registerEngineVersion(engine)` returns the `engine_versions` id for the engine's `(engineName, engineVersion, depth, threads, hashSize)`; inserts a row only when none exists, never updates one |
| `src/workers/dataQuality.js` (B) | `CHECK_NAMES`; `runDataQualityChecks({accountId?})` returns `{ok, violations:[{check, count, sample}]}` (whole database when `accountId` is null) |
| `src/workers/gameAnalyzer.js` (B) | `analyzeGame({moves}, engine, {engineVersionId, startCache?})` returns the move rows for `saveGameAnalysis`; throws `DataError` for illegal moves/invalid FENs and lets engine errors propagate |
| `src/workers/events.js` (B) | default `workerEvents` (EventEmitter) emitting `job:started`, `game:done`, `job:failed`, `job:finished` |
| `src/workers/jobRunner.js` (B) | class `JobRunner(workerId)`: `start()`, `stop()`, `processJob(job)` |

**ParsedGame**: `{externalId, white, black, whiteElo, blackElo, resultRaw ('1-0'|'0-1'|'1/2-1/2'|'*'), eco, openingName, timeControl:{baseSeconds, incrementSeconds, category}, playedAt (Date), totalPlies, parseError (string|null), moves:[{ply, san, uci, fenBefore, moverColor ('white'|'black'), phase, clockRemainingMs|null, timeSpentMs|null}]}`.

**`saveGameAnalysis` move rows**: `{ply, evalBeforeCp, evalAfterCp, bestUci, depth, mateBefore (int|null), mateAfter (int|null), cpLoss, classification ('best'|'good'|'inaccuracy'|'mistake'|'blunder'), motifs:[{name, kind}]}`. Evals are White-perspective centipawns. `mateBefore`/`mateAfter` are White-perspective mate distances; `mateAfter = 0` means a checkmate was delivered (sign comes from the mover). One transaction; marks the game `analyzed`; uses `ON CONFLICT DO NOTHING`.

**API conventions**: successful responses return the resource as JSON; errors return `{error:{message, code}}`; list endpoints return `{items, page, pageSize, total}`. All data routes require `Authorization: Bearer <jwt>` and scope every query to the authenticated user; accessing another user's resource returns 404.

**Auth contract**

- Token response (register 201, login 200, refresh 200): `{token, user:{id, email, role}}`. `token` is the access JWT (HS256, claims `sub`, `email`, `role`, lifetime `ACCESS_TOKEN_TTL`, default 15m). The refresh token is never in the body. It is set as cookie `refresh_token` (`HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=<REFRESH_TOKEN_TTL_DAYS days>`, plus `Secure` when `NODE_ENV=production`).
- `GET /api/v1/me` returns `{user:{id, email, role}}`. Tokens issued before roles existed have no role claim and are treated as `user`.
- `POST /api/v1/auth/refresh` needs header `X-Requested-With: fetch` and, when `Origin` is sent, the server's own origin or one in `CORS_ORIGINS`. 200 with the token response and a rotated cookie. 401 `UNAUTHORIZED` for a missing, unknown, expired or reused token (reuse also revokes the whole family). The cookie is cleared on 401. 403 `FORBIDDEN` when the header or origin check fails.
- `POST /api/v1/auth/logout` has the same header and origin checks. It revokes the presented refresh token and clears the cookie. Always 204, including without a cookie.
- `GET /api/v1/admin/users?page&pageSize` (admin) returns `{items:[{id, email, role, createdAt, accountCount, gameCount}], page, pageSize, total}`. `pageSize` defaults to 20 and is capped at 100. The password hash is never returned.
- `GET /api/v1/admin/jobs` (admin) returns `{counts:{queued, running, completed, failed}, recent:[{id, status, attempts, maxGames, failedGames, skippedGames, error, createdAt, finishedAt, account:{id, username, platform}, user:{id, email}}]}` with the 20 most recent jobs.
- Error codes on these routes: 401 `UNAUTHORIZED` (no, malformed, invalid or expired access token, or failed refresh), 403 `FORBIDDEN` (role not allowed, or CSRF check failed).
- `src/middleware/authorize.js` (B): `requireRole(...roles)`. `src/middleware/csrf.js` (B): `requireSameOriginFetch`. `src/services/session.service.js` (B): `startSession(userId)`, `rotate(rawToken)`, `revoke(rawToken)`, `hashToken(raw)`.
