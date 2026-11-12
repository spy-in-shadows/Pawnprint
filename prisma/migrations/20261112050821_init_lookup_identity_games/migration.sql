-- CreateTable
CREATE TABLE "platforms" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_accounts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_controls" (
    "id" SERIAL NOT NULL,
    "base_seconds" INTEGER NOT NULL,
    "increment_seconds" INTEGER NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "time_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "openings" (
    "id" SERIAL NOT NULL,
    "eco" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" SERIAL NOT NULL,
    "player_account_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "played_at" TIMESTAMP(3) NOT NULL,
    "color" TEXT NOT NULL,
    "result_id" INTEGER NOT NULL,
    "opening_id" INTEGER,
    "time_control_id" INTEGER,
    "player_rating" INTEGER,
    "opponent_rating" INTEGER,
    "total_plies" INTEGER NOT NULL,
    "analysis_status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platforms_name_key" ON "platforms"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "player_accounts_platform_id_username_key" ON "player_accounts"("platform_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "results_code_key" ON "results"("code");

-- CreateIndex
CREATE UNIQUE INDEX "time_controls_base_seconds_increment_seconds_key" ON "time_controls"("base_seconds", "increment_seconds");

-- CreateIndex
CREATE UNIQUE INDEX "openings_eco_name_key" ON "openings"("eco", "name");

-- CreateIndex
CREATE INDEX "games_player_account_id_played_at_idx" ON "games"("player_account_id", "played_at");

-- CreateIndex
CREATE UNIQUE INDEX "games_platform_id_external_id_key" ON "games"("platform_id", "external_id");

-- AddForeignKey
ALTER TABLE "player_accounts" ADD CONSTRAINT "player_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_accounts" ADD CONSTRAINT "player_accounts_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_player_account_id_fkey" FOREIGN KEY ("player_account_id") REFERENCES "player_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_opening_id_fkey" FOREIGN KEY ("opening_id") REFERENCES "openings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_time_control_id_fkey" FOREIGN KEY ("time_control_id") REFERENCES "time_controls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
