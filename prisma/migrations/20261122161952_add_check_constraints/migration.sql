-- CHECK constraints for value rules that were previously enforced only by application code.
-- Prisma does not model CHECK constraints, so they live only in this migration (see the
-- comments in prisma/schema.prisma). Before adding them, every rule was counted against the
-- existing data and had no violating rows.

-- Colours: the importer and the PGN parser write only 'white' and 'black'.
ALTER TABLE "games" ADD CONSTRAINT "games_color_check" CHECK ("color" IN ('white', 'black'));
ALTER TABLE "moves" ADD CONSTRAINT "moves_mover_color_check" CHECK ("mover_color" IN ('white', 'black'));

-- Status values: games (moveBulk.repo.js), jobs (import.service.js, jobQueue.js),
-- per-game job progress (jobRunner.js).
ALTER TABLE "games" ADD CONSTRAINT "games_analysis_status_check"
  CHECK ("analysis_status" IN ('pending', 'analyzed', 'failed'));
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_status_check"
  CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));
ALTER TABLE "analysis_job_games" ADD CONSTRAINT "analysis_job_games_status_check"
  CHECK ("status" IN ('pending', 'analyzing', 'done', 'failed'));

-- Motif kind (motifs.js, gameAnalyzer.js) and time-control category (pgnParser.js, seed).
ALTER TABLE "move_motifs" ADD CONSTRAINT "move_motifs_kind_check" CHECK ("kind" IN ('allowed', 'missed'));
ALTER TABLE "time_controls" ADD CONSTRAINT "time_controls_category_check"
  CHECK ("category" IN ('bullet', 'blitz', 'rapid', 'classical', 'correspondence'));

-- Games: ply count and ratings. Game ratings allow 0 because a PGN header such as WhiteElo "0"
-- is parsed as 0, and rejecting it would fail the whole upload.
ALTER TABLE "games" ADD CONSTRAINT "games_total_plies_check" CHECK ("total_plies" >= 0);
ALTER TABLE "games" ADD CONSTRAINT "games_player_rating_check" CHECK ("player_rating" IS NULL OR "player_rating" >= 0);
ALTER TABLE "games" ADD CONSTRAINT "games_opponent_rating_check" CHECK ("opponent_rating" IS NULL OR "opponent_rating" >= 0);

-- Moves: plies start at 1; clocks and time spent are never negative.
ALTER TABLE "moves" ADD CONSTRAINT "moves_ply_check" CHECK ("ply" > 0);
ALTER TABLE "moves" ADD CONSTRAINT "moves_clock_remaining_ms_check"
  CHECK ("clock_remaining_ms" IS NULL OR "clock_remaining_ms" >= 0);
ALTER TABLE "moves" ADD CONSTRAINT "moves_time_spent_ms_check" CHECK ("time_spent_ms" IS NULL OR "time_spent_ms" >= 0);

-- Time controls.
ALTER TABLE "time_controls" ADD CONSTRAINT "time_controls_base_seconds_check" CHECK ("base_seconds" >= 0);
ALTER TABLE "time_controls" ADD CONSTRAINT "time_controls_increment_seconds_check" CHECK ("increment_seconds" >= 0);

-- Puzzles: Lichess puzzle ratings are positive.
ALTER TABLE "puzzles" ADD CONSTRAINT "puzzles_rating_check" CHECK ("rating" > 0);

-- Evaluations and classifications. Depth allows 0: terminal positions are resolved without a
-- search and stored with depth 0 and best_uci 'none' (src/workers/gameAnalyzer.js).
ALTER TABLE "move_evals" ADD CONSTRAINT "move_evals_depth_check" CHECK ("depth" >= 0);
ALTER TABLE "move_classifications" ADD CONSTRAINT "move_classifications_cp_loss_check" CHECK ("cp_loss" >= 0);

-- Engine configurations.
ALTER TABLE "engine_versions" ADD CONSTRAINT "engine_versions_default_depth_check" CHECK ("default_depth" > 0);
ALTER TABLE "engine_versions" ADD CONSTRAINT "engine_versions_threads_check" CHECK ("threads" > 0);
ALTER TABLE "engine_versions" ADD CONSTRAINT "engine_versions_hash_size_check" CHECK ("hash_size" > 0);

-- Job counters and the optional date window.
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_max_games_check" CHECK ("max_games" > 0);
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_failed_games_check" CHECK ("failed_games" >= 0);
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_skipped_games_check" CHECK ("skipped_games" >= 0);
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_since_until_check"
  CHECK ("since" IS NULL OR "until" IS NULL OR "since" <= "until");

-- Summary tables: counts and averages are never negative, accuracy is a percentage.
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_total_games_check" CHECK ("total_games" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_analyzed_games_check" CHECK ("analyzed_games" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_total_moves_check" CHECK ("total_moves" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_inaccuracies_check" CHECK ("inaccuracies" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_mistakes_check" CHECK ("mistakes" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_blunders_check" CHECK ("blunders" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_avg_cp_loss_check" CHECK ("avg_cp_loss" >= 0);
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_accuracy_pct_check"
  CHECK ("accuracy_pct" >= 0 AND "accuracy_pct" <= 100);
ALTER TABLE "account_phase_summary" ADD CONSTRAINT "account_phase_summary_moves_check" CHECK ("moves" >= 0);
ALTER TABLE "account_phase_summary" ADD CONSTRAINT "account_phase_summary_blunders_check" CHECK ("blunders" >= 0);
ALTER TABLE "account_phase_summary" ADD CONSTRAINT "account_phase_summary_avg_cp_loss_check" CHECK ("avg_cp_loss" >= 0);
