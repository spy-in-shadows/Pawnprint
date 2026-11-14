-- Justified by explain plan 5_motif_weaknesses filtering and joining by motif_id
CREATE INDEX "idx_move_motifs_motif_id" ON "move_motifs"("motif_id");

-- Justified by explain plans across all user-scoped analytics queries filtering by user_id
CREATE INDEX "idx_player_accounts_user_id" ON "player_accounts"("user_id");

