-- User roles. Every existing user becomes a regular user; admins are promoted with
-- `npm run make-admin -- <email>`.
ALTER TABLE "users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));
