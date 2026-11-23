// Refresh-token rows. Every function takes the transaction client so callers can group writes.

export function create(tx, { userId, tokenHash, familyId, expiresAt }) {
  return tx.refreshToken.create({ data: { userId, tokenHash, familyId, expiresAt } });
}

// Row lock so two concurrent refreshes of the same token are serialised: the second one sees
// the token as revoked and is treated as reuse.
export async function findByHashForUpdate(tx, tokenHash) {
  const rows = await tx.$queryRaw`
    SELECT id, user_id AS "userId", family_id AS "familyId", expires_at AS "expiresAt", revoked_at AS "revokedAt"
      FROM refresh_tokens
     WHERE token_hash = ${tokenHash}
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

export function markReplaced(tx, id, replacedById, now) {
  return tx.refreshToken.update({ where: { id }, data: { revokedAt: now, replacedById } });
}

export function revokeFamily(tx, familyId, now) {
  return tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
}

export function revokeByHash(tx, tokenHash, now) {
  return tx.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } });
}

export const refreshTokenRepo = { create, findByHashForUpdate, markReplaced, revokeFamily, revokeByHash };
export default refreshTokenRepo;
