-- CreateTable
CREATE TABLE "phases" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moves" (
    "id" SERIAL NOT NULL,
    "game_id" INTEGER NOT NULL,
    "ply" INTEGER NOT NULL,
    "san" TEXT NOT NULL,
    "uci" TEXT NOT NULL,
    "fen_before" TEXT NOT NULL,
    "mover_color" TEXT NOT NULL,
    "clock_remaining_ms" INTEGER,
    "time_spent_ms" INTEGER,
    "phase_id" INTEGER NOT NULL,

    CONSTRAINT "moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_versions" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "default_depth" INTEGER NOT NULL,
    "threads" INTEGER DEFAULT 1,
    "hash_size" INTEGER DEFAULT 64,

    CONSTRAINT "engine_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "move_evals" (
    "move_id" INTEGER NOT NULL,
    "eval_before_cp" INTEGER NOT NULL,
    "eval_after_cp" INTEGER NOT NULL,
    "best_uci" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "engine_version_id" INTEGER NOT NULL,

    CONSTRAINT "move_evals_pkey" PRIMARY KEY ("move_id")
);

-- CreateTable
CREATE TABLE "move_mates" (
    "move_id" INTEGER NOT NULL,
    "mate_before" INTEGER,
    "mate_after" INTEGER,

    CONSTRAINT "move_mates_pkey" PRIMARY KEY ("move_id")
);

-- CreateTable
CREATE TABLE "classifications" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "move_classifications" (
    "move_id" INTEGER NOT NULL,
    "classification_id" INTEGER NOT NULL,
    "cp_loss" INTEGER NOT NULL,

    CONSTRAINT "move_classifications_pkey" PRIMARY KEY ("move_id")
);

-- CreateTable
CREATE TABLE "motifs" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "motifs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "move_motifs" (
    "move_id" INTEGER NOT NULL,
    "motif_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'allowed',

    CONSTRAINT "move_motifs_pkey" PRIMARY KEY ("move_id","motif_id","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "phases_name_key" ON "phases"("name");

-- CreateIndex
CREATE UNIQUE INDEX "moves_game_id_ply_key" ON "moves"("game_id", "ply");

-- CreateIndex
CREATE UNIQUE INDEX "engine_versions_name_version_default_depth_threads_hash_siz_key" ON "engine_versions"("name", "version", "default_depth", "threads", "hash_size");

-- CreateIndex
CREATE UNIQUE INDEX "classifications_name_key" ON "classifications"("name");

-- CreateIndex
CREATE UNIQUE INDEX "motifs_name_key" ON "motifs"("name");

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_evals" ADD CONSTRAINT "move_evals_move_id_fkey" FOREIGN KEY ("move_id") REFERENCES "moves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_evals" ADD CONSTRAINT "move_evals_engine_version_id_fkey" FOREIGN KEY ("engine_version_id") REFERENCES "engine_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_mates" ADD CONSTRAINT "move_mates_move_id_fkey" FOREIGN KEY ("move_id") REFERENCES "moves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_classifications" ADD CONSTRAINT "move_classifications_move_id_fkey" FOREIGN KEY ("move_id") REFERENCES "moves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_classifications" ADD CONSTRAINT "move_classifications_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "classifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_motifs" ADD CONSTRAINT "move_motifs_move_id_fkey" FOREIGN KEY ("move_id") REFERENCES "moves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "move_motifs" ADD CONSTRAINT "move_motifs_motif_id_fkey" FOREIGN KEY ("motif_id") REFERENCES "motifs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
