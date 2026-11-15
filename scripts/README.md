# Scripts Reference

This directory contains standalone CLI scripts and benchmark harnesses for the engine.

## benchmarkInsert.js
Comparative database insertion benchmark evaluating move insertion throughput across three strategies:
- `prisma-row`: Sequential per-ply row creates via Prisma Client.
- `prisma-many`: Batch insert per game via Prisma `createMany`.
- `unnest`: Atomic multi-ply insert via raw PostgreSQL `UNNEST` (`insertGameWithMoves`).

Usage:
```bash
node scripts/benchmarkInsert.js [--games N] [--plies P] [--strategy prisma-row|prisma-many|unnest|all] [--row-sample S] [--keep]
```

## importPuzzles.js
Streaming Lichess puzzle CSV importer with rating filtering, stride sampling, theme-to-motif mapping, and batched UNNEST database insertion.

Usage:
```bash
node scripts/importPuzzles.js <csv> [--cap N] [--stride K] [--min-rating R] [--max-rating R]
```

### Lichess Puzzle Database File
The official Lichess puzzle archive is distributed in Zstandard compressed format (`.csv.zst`):
```bash
# Decompress full CSV archive
zstd -d file.csv.zst
```

To extract a sample from a partially downloaded or compressed archive without decompressing the entire file to disk:
```bash
zstd -dc file.csv.zst 2>/dev/null | head -n 50001 > sample.csv
```

## dataQuality.js
Runs data quality verification queries over stored games, move evaluations, and background jobs to detect data anomalies and inconsistencies.

Usage:
```bash
node scripts/dataQuality.js [--account <id>]
```

## reclassifyOpenings.js
Links games imported before the full ECO list was seeded to their opening. Games keep only `opening_id`, not the ECO header, so a plain SQL update cannot recover it and re-importing does not help either (imports skip games that already exist). The script reads the ECO header again for every Lichess game with no opening through the Lichess export-by-ids endpoint (headers only, 300 ids per request) and sets `opening_id` to the seeded row for that code. It only fills empty `opening_id` values, so it is safe to run more than once. Chess.com and uploaded games are counted but not changed. Run `npm run seed` first.

Usage:
```bash
node scripts/reclassifyOpenings.js
```
