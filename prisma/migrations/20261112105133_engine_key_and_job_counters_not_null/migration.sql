/*
  Warnings:

  - Made the column `max_games` on table `analysis_jobs` required. This step will fail if there are existing NULL values in that column.
  - Made the column `failed_games` on table `analysis_jobs` required. This step will fail if there are existing NULL values in that column.
  - Made the column `skipped_games` on table `analysis_jobs` required. This step will fail if there are existing NULL values in that column.
  - Made the column `threads` on table `engine_versions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `hash_size` on table `engine_versions` required. This step will fail if there are existing NULL values in that column.

*/
-- Backfill existing NULLs before altering columns to NOT NULL
UPDATE "engine_versions" SET "threads" = 1 WHERE "threads" IS NULL;
UPDATE "engine_versions" SET "hash_size" = 64 WHERE "hash_size" IS NULL;
UPDATE "analysis_jobs" SET "max_games" = 50 WHERE "max_games" IS NULL;
UPDATE "analysis_jobs" SET "failed_games" = 0 WHERE "failed_games" IS NULL;
UPDATE "analysis_jobs" SET "skipped_games" = 0 WHERE "skipped_games" IS NULL;

-- AlterTable
ALTER TABLE "analysis_jobs" ALTER COLUMN "max_games" SET NOT NULL,
ALTER COLUMN "failed_games" SET NOT NULL,
ALTER COLUMN "skipped_games" SET NOT NULL;

-- AlterTable
ALTER TABLE "engine_versions" ALTER COLUMN "threads" SET NOT NULL,
ALTER COLUMN "hash_size" SET NOT NULL;
