# Pawnprint — Longitudinal Chess Analytics Engine

Ingests a player's chess games, evaluates every move with Stockfish, stores the results in a
normalized PostgreSQL schema and turns them into longitudinal diagnostics and a training plan.

- Design: see [DESIGN.md](DESIGN.md)
- Module contracts: see [docs/CONTRACTS.md](docs/CONTRACTS.md)
- Engineering conventions: see [ENGINEERING.md](ENGINEERING.md)

Status: in development. Auth, games endpoints, PGN parsing, bulk ingestion, the engine client and the job queue are in place; the worker pipeline, analytics and training are not built yet.
