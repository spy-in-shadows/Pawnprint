-- CreateTable
CREATE TABLE "account_summary" (
    "player_account_id" INTEGER NOT NULL,
    "total_games" INTEGER NOT NULL,
    "analyzed_games" INTEGER NOT NULL,
    "total_moves" INTEGER NOT NULL,
    "inaccuracies" INTEGER NOT NULL,
    "mistakes" INTEGER NOT NULL,
    "blunders" INTEGER NOT NULL,
    "avg_cp_loss" DOUBLE PRECISION NOT NULL,
    "accuracy_pct" DOUBLE PRECISION NOT NULL,
    "last_game_at" TIMESTAMP(3),
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_summary_pkey" PRIMARY KEY ("player_account_id")
);

-- CreateTable
CREATE TABLE "account_phase_summary" (
    "player_account_id" INTEGER NOT NULL,
    "phase_id" INTEGER NOT NULL,
    "moves" INTEGER NOT NULL,
    "blunders" INTEGER NOT NULL,
    "avg_cp_loss" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "account_phase_summary_pkey" PRIMARY KEY ("player_account_id","phase_id")
);

-- AddForeignKey
ALTER TABLE "account_summary" ADD CONSTRAINT "account_summary_player_account_id_fkey" FOREIGN KEY ("player_account_id") REFERENCES "player_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_phase_summary" ADD CONSTRAINT "account_phase_summary_player_account_id_fkey" FOREIGN KEY ("player_account_id") REFERENCES "player_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_phase_summary" ADD CONSTRAINT "account_phase_summary_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
