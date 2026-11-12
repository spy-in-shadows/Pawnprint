-- CreateTable
CREATE TABLE "puzzles" (
    "id" SERIAL NOT NULL,
    "lichess_id" TEXT NOT NULL,
    "fen" TEXT NOT NULL,
    "moves_uci" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "phase_tag" TEXT,

    CONSTRAINT "puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "puzzle_motifs" (
    "puzzle_id" INTEGER NOT NULL,
    "motif_id" INTEGER NOT NULL,

    CONSTRAINT "puzzle_motifs_pkey" PRIMARY KEY ("puzzle_id","motif_id")
);

-- CreateTable
CREATE TABLE "training_plans" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_plan_items" (
    "id" SERIAL NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "puzzle_id" INTEGER NOT NULL,
    "motif_id" INTEGER,
    "reason_code" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "training_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_jobs" (
    "id" SERIAL NOT NULL,
    "player_account_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_games" INTEGER DEFAULT 50,
    "since" TIMESTAMP(3),
    "until" TIMESTAMP(3),
    "locked_by" TEXT,
    "locked_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "error" TEXT,
    "failed_games" INTEGER DEFAULT 0,
    "skipped_games" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "analysis_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_job_games" (
    "job_id" INTEGER NOT NULL,
    "game_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,

    CONSTRAINT "analysis_job_games_pkey" PRIMARY KEY ("job_id","game_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "puzzles_lichess_id_key" ON "puzzles"("lichess_id");

-- CreateIndex
CREATE INDEX "analysis_jobs_status_created_at_idx" ON "analysis_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "puzzle_motifs" ADD CONSTRAINT "puzzle_motifs_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "puzzle_motifs" ADD CONSTRAINT "puzzle_motifs_motif_id_fkey" FOREIGN KEY ("motif_id") REFERENCES "motifs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_items" ADD CONSTRAINT "training_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "training_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_items" ADD CONSTRAINT "training_plan_items_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_items" ADD CONSTRAINT "training_plan_items_motif_id_fkey" FOREIGN KEY ("motif_id") REFERENCES "motifs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_player_account_id_fkey" FOREIGN KEY ("player_account_id") REFERENCES "player_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_job_games" ADD CONSTRAINT "analysis_job_games_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_job_games" ADD CONSTRAINT "analysis_job_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "idx_analysis_jobs_active_unique" ON "analysis_jobs"("player_account_id") WHERE status IN ('queued','running');
