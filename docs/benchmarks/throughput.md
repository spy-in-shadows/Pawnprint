# Analysis Throughput Benchmark

Produced by `node scripts/benchmarkThroughput.js --games 30 --workers 1,2,3 --plies 40 --depth 12`.

## Method
- 30 random legal games (chess.js, seeded PRNG 20261114), at most 40 plies each, inserted with `ingestParsedGames`.
- For W workers the games are split over W fresh accounts with one job each (one active job per account), then W `node src/worker.js` processes are started.
- Wall time runs from spawning the workers until every job is finished in the database, so it includes process and engine start-up.
- Engine calls per game: N + 1 per N-ply game, minus terminal final positions, with the start position searched once per worker.

## Machine
- **CPU**: Apple M4 (10 cores)
- **RAM**: 16.0 GB
- **OS**: Darwin 25.6.0 (arm64)
- **Node.js**: v26.5.0
- **PostgreSQL**: PostgreSQL 16.15
- **Engine**: Stockfish 19, depth 12, threads 1, hash 64 MB per worker

## Results
| Workers | Games | Plies | Wall time | Games / min | Plies / sec | Engine calls / game | Speedup | Failed jobs |
| ------: | ----: | ----: | --------: | ----------: | ----------: | ------------------: | ------: | ----------: |
| 1 | 30 | 1200 | 35.4 s | 50.9 | 33.9 | 40.03 | 1.00x | 0 |
| 2 | 30 | 1200 | 20.4 s | 88.2 | 58.8 | 40.07 | 1.73x | 0 |
| 3 | 30 | 1200 | 12.6 s | 142.9 | 95.2 | 40.10 | 2.81x | 0 |
