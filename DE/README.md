# DE: Data Engineering documentation for Pawnprint

This folder documents the database of Pawnprint (Longitudinal Chess Analytics Engine) for the Data Engineering project guidelines. Every schema detail, sample row and query output in it was taken from the project's real PostgreSQL database and code on 2026-11-22.

## Deliverables

| # | Deliverable | Files |
|---|---|---|
| 1 | Database selection and justification | [`01_database_selection.md`](01_database_selection.md) |
| 2 | ER diagram | [`02_er_diagram.md`](02_er_diagram.md) (Mermaid source, full diagram and three focused views, relationship table), [`er_diagram.svg`](er_diagram.svg) (rendered full diagram) |
| 3 | Normalization up to 3NF | [`03_normalization.md`](03_normalization.md) |
| 4 | Final schema | [`04_final_schema.md`](04_final_schema.md), [`schema.sql`](schema.sql) (DDL dump of the live database) |
| 5 | Sample records | [`05_sample_records.md`](05_sample_records.md), [`sample_data/`](sample_data/) (one CSV per table, 24 files) |
| 6 | Queries | [`06_queries.md`](06_queries.md), [`queries.sql`](queries.sql) (16 queries) |
| 7 | Integration with the application | [`07_integration_evidence.md`](07_integration_evidence.md) |
| 8 | Architecture and design decisions | [`08_architecture_and_decisions.md`](08_architecture_and_decisions.md) |

Known limitations found while writing these files are listed in `03_normalization.md` (section 3.7), `07_integration_evidence.md` (section 7.4) and `08_architecture_and_decisions.md` (section 8.9).

## Reproducing the outputs

### Database used

The outputs come from the demo database: the `db` service of `docker-compose.yml` (image `postgres:16`, user `chess`, database `chess_analytics`). On the machine used here it runs as the Compose project `pawnprint-demo` on host port 5435, which is what `DATABASE_URL` in `.env` points to, so every command passes `-p pawnprint-demo`. With a default setup (project `pawnprint`, port 5432) drop `-p pawnprint-demo` and the `POSTGRES_PORT` variable.

```
POSTGRES_PORT=5435 docker compose -p pawnprint-demo up -d
npx prisma generate
npx prisma migrate deploy
PSQL="docker compose -p pawnprint-demo exec -T db psql -U chess -d chess_analytics"
$PSQL -c '\dt'
```

The demo data (2 users, 80 analysed Lichess games, 7,107 moves, 50,000 puzzles) was loaded through the application as described in `docs/DEMO.md` (link a Lichess account, sync, let the worker analyse) and with `npm run import:puzzles`.

Row counts of every table:

```
$PSQL -At -c "SELECT string_agg(format('SELECT %L AS table_name, count(*) AS rows FROM %I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) || ' ORDER BY 1' FROM pg_tables WHERE schemaname = 'public'" | $PSQL -f -
```

### Per deliverable

| Output | Command |
|---|---|
| `schema.sql` | `docker compose -p pawnprint-demo exec -T db pg_dump -U chess -d chess_analytics --schema-only --no-owner --no-privileges > DE/schema.sql`, then remove the `-- Name:` blocks of `_prisma_migrations` |
| Check that `schema.sql` loads | create an empty database and run `psql -v ON_ERROR_STOP=1 -f DE/schema.sql` against it |
| `er_diagram.svg` | extract the first Mermaid block of `02_er_diagram.md` to a file, then `npx -y @mermaid-js/mermaid-cli -i <file> -o DE/er_diagram.svg` |
| Mermaid check | the same command on every Mermaid block of `02_er_diagram.md` and `08_architecture_and_decisions.md`; all five render |
| `sample_data/<table>.csv` | `$PSQL -c "COPY (<select>) TO STDOUT WITH (FORMAT csv, HEADER)" > DE/sample_data/<table>.csv`, with the `SELECT` printed above each table in `05_sample_records.md` |
| Query outputs | `$PSQL -f - < DE/queries.sql` (all queries in one session), or each `-- Qnn.` block on its own as described in `06_queries.md`. Data-changing queries end in `ROLLBACK` |
| Execution plans | the two `EXPLAIN (ANALYZE, BUFFERS)` statements in `06_queries.md`, section "Execution plans" |
| Walkthrough | start the API (`node src/server.js`) and a worker (`node src/worker.js`), then run the `curl` and `psql` commands of `07_integration_evidence.md` in order; delete the throwaway user at the end as shown in step 9 |

After the queries and after the walkthrough the row counts were compared with the starting counts (`diff` printed nothing), so the demo data is unchanged.

### Tests

The test suite deletes rows, so it must not run against the demo database. It was run against a separate database on the same server:

```
$PSQL -c "CREATE DATABASE pawnprint_test"
DATABASE_URL=postgresql://chess:chess@localhost:5435/pawnprint_test npx prisma migrate deploy
DATABASE_URL=postgresql://chess:chess@localhost:5435/pawnprint_test npm run seed
DATABASE_URL=postgresql://chess:chess@localhost:5435/pawnprint_test npm test
```

Result: 39 test files, 362 tests passed.
