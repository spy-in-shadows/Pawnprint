# API reference

Base URL: `http://<host>:<PORT>` (default port 3000). All JSON endpoints are under `/api/v1`. The table is taken from the route files in `src/routes/`; `scripts/checkApiDocs.js` checks that every documented path exists there and the other way round.

A request collection for Postman (v2.1) is in [`pawnprint.postman_collection.json`](pawnprint.postman_collection.json). Set `baseUrl` (default `http://localhost:3000`). Running **Auth / Login** or **Auth / Register** stores the returned access token in the `token` variable, which every other request sends as `Authorization: Bearer {{token}}`.

## Authentication

- **Bearer.** Every route marked "Bearer" needs `Authorization: Bearer <token>`, where `token` is the access token from login, register or refresh. Its lifetime is `ACCESS_TOKEN_TTL` (default 15 minutes).
- **Refresh cookie.** Login and register also set the `refresh_token` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, plus `Secure` in production). Refresh and logout read only this cookie.
- **CSRF check.** Refresh and logout also need the header `X-Requested-With: fetch`. If the request sends an `Origin` header, it must be the server's own origin or one listed in `CORS_ORIGINS`.
- **Roles.** `user` (the default) or `admin`. Admin routes answer 403 for every other role.

## Endpoints

Every Bearer route can also answer 401 (missing, malformed or expired token) and 429 (rate limit). Any route can answer 500. These are not repeated in the table.

| Method | Path | Auth | Role | Request | Success | Errors |
|---|---|---|---|---|---|---|
| GET | `/health` | none | | | 200 `{status:'ok', database}` | 503 when the database is unreachable |
| GET | `/api/v1/health` | none | | | 200 (same as `/health`) | 503 |
| POST | `/api/v1/auth/register` | none | | body `{email, password}` (valid email; password at least 8 characters) | 201 `{token, user}` and sets the refresh cookie | 400, 409 (email already registered) |
| POST | `/api/v1/auth/login` | none | | body `{email, password}` | 200 `{token, user}` and sets the refresh cookie | 400 (non-string fields), 401 (wrong or unknown credentials, same message for both) |
| POST | `/api/v1/auth/refresh` | refresh cookie | | header `X-Requested-With: fetch` | 200 `{token, user}` and rotates the cookie | 401 (missing, unknown, expired or reused token; reuse revokes the whole family), 403 (CSRF check) |
| POST | `/api/v1/auth/logout` | refresh cookie | | header `X-Requested-With: fetch` | 204 and clears the cookie (also without a cookie) | 403 (CSRF check) |
| GET | `/api/v1/me` | Bearer | any | | 200 `{user:{id, email, role}}` | |
| GET | `/api/v1/accounts` | Bearer | any | | 200 `[account]` (each with its `platform`) | |
| POST | `/api/v1/accounts` | Bearer | any | body `{platform: 'lichess'\|'chesscom'\|'upload', username}` | 201 `account` | 400, 409 (already linked to you or to another user) |
| DELETE | `/api/v1/accounts/:id` | Bearer | any | `:id` positive integer | 204 | 404 (not found, not yours, or malformed id) |
| POST | `/api/v1/imports` | Bearer | any | body `{accountId, maxGames?, since?, until?}`; `maxGames` is clamped to 1..500 (default 50); dates must be valid and `since <= until` | 202 `job` (an existing queued or running job for the account is returned instead of a new one) | 400, 404 (account not found or not yours) |
| GET | `/api/v1/imports/:id` | Bearer | any | `:id` positive integer | 200 job status and progress | 404 |
| POST | `/api/v1/uploads/pgn` | Bearer | any | `multipart/form-data`: `file` (`.pgn` or plain text, at most 5 MB), optional `accountId` | 202 `{insertedCount, skippedCount, job}` | 400 (no file, empty file, unparseable, no valid games, too large, wrong type, non-integer `accountId`), 404 (account not yours) |
| GET | `/api/v1/games` | Bearer | any | query `accountId?, from?, to?, opening?` (ECO such as `B00`), `page?`, `pageSize?` (default 20, at most 100) | 200 `{items, page, pageSize, total}` | 400 (bad filter, or `from` after `to`) |
| GET | `/api/v1/games/:id` | Bearer | any | `:id` positive integer | 200 game with moves, evaluations, classifications and motifs | 404 |
| GET | `/api/v1/analytics/openings` | Bearer | any | query `accountId?, from?, to?` | 200 | 400 |
| GET | `/api/v1/analytics/phases` | Bearer | any | query `accountId?, from?, to?` | 200 | 400 |
| GET | `/api/v1/analytics/time-pressure` | Bearer | any | query `accountId?, from?, to?` | 200 | 400 |
| GET | `/api/v1/analytics/trend` | Bearer | any | query `accountId?, from?, to?` | 200 | 400 |
| GET | `/api/v1/analytics/motifs` | Bearer | any | query `accountId?, from?, to?` | 200 | 400 |
| GET | `/api/v1/analytics/summary` | Bearer | any | query `accountId?` | 200 `{accounts:[...]}` | 400, 404 (account not yours) |
| GET | `/api/v1/training/plans` | Bearer | any | | 200 plans with items and prepared drills | |
| POST | `/api/v1/training/plans` | Bearer | any | no body | 201 new plan (an empty plan with a message when there is not enough data) | |
| PATCH | `/api/v1/training/plans/:planId/items/:itemId` | Bearer | any | body `{completed: boolean}` | 200 updated item | 400, 404 (plan or item not found or not yours) |
| GET | `/api/v1/admin/users` | Bearer | admin | query `page?, pageSize?` (default 20, at most 100) | 200 `{items:[{id, email, role, createdAt, accountCount, gameCount}], page, pageSize, total}` | 403 |
| GET | `/api/v1/admin/jobs` | Bearer | admin | | 200 `{counts:{queued, running, completed, failed}, recent:[...20 jobs]}` | 403 |

Requests for another user's resource always answer 404, never 403, so they do not reveal that the resource exists. A malformed id (for example `/games/abc`) also answers 404.

## Error format

Every error has the same shape:

```json
{ "error": { "message": "Invalid request: accountId: must be a positive integer; to: must be a valid date", "code": "VALIDATION_ERROR" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The body, query or form fields fail validation. The message lists each failing field as `field: problem`. |
| 400 | `INVALID_JSON` | The body is not valid JSON. |
| 401 | `UNAUTHORIZED` | Missing, malformed, invalid or expired access token; wrong credentials; failed refresh. |
| 403 | `FORBIDDEN` | Role not allowed, or the CSRF check on refresh or logout failed. |
| 404 | `NOT_FOUND` | Unknown route, missing resource, another user's resource, or a malformed id. |
| 409 | `CONFLICT` | Email already registered; account already linked. |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body over 1 MB. |
| 429 | `RATE_LIMIT_EXCEEDED` | Rate limit reached; see `Retry-After`. |
| 500 | `INTERNAL_ERROR` | Unexpected failure. The message is generic and never includes internals; the body also carries `error.requestId`. |

Every response, successful or not, has an `X-Request-Id` header (a fresh UUID; an incoming `X-Request-Id` is ignored). Every server log line written while handling that request carries the same `requestId`, so when reporting a 500, quote `error.requestId`:

```json
{ "error": { "message": "Internal server error", "code": "INTERNAL_ERROR", "requestId": "0b6c1f2e-6f0e-4d7b-9a51-3f8f3f5a2c11" } }
```

## Idempotency

- **Imports.** `POST /imports` never creates a second active job for an account. While a job is `queued` or `running`, the same job is returned (a partial unique index enforces this in the database).
- **Game storage.** Imports and uploads store each game once: games are unique on `(platform, external_id)` and inserted with `ON CONFLICT DO NOTHING`. Uploading the same PGN twice reports the second copy's games under `skippedCount`.
- **Linking accounts.** `POST /accounts` for an account that is already linked answers 409; it does not create a duplicate.
- **Training items.** `PATCH .../items/:itemId` sets `completed` to the given value, so repeating it has no further effect.
- **Logout.** Always 204, whether or not a cookie was sent.
- **Refresh.** Not idempotent: each call consumes the presented token. Sending the same refresh token twice is treated as theft (see Authentication).
- **Deleting accounts.** `DELETE /accounts/:id` answers 204 the first time and 404 afterwards.

## Rate limits

The limits use fixed one-minute windows, counted per client IP. Behind a reverse proxy, set `TRUST_PROXY` so the client IP comes from `X-Forwarded-For`.

| Scope | Limit |
|---|---|
| Every path under `/api` | 300 requests per minute |
| `/api/v1/auth/*` (register, login, refresh, logout) | 20 requests per minute, in addition to the limit above |
| `/health` | not limited |

Every limited response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a 429 also carries `Retry-After` (seconds). Rate limiting runs before the body is parsed, so a rejected request costs no parsing work.
