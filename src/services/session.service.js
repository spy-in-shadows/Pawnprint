import crypto from 'crypto';
import config from '../config/env.js';
import { prisma } from '../config/db.js';
import * as refreshTokenRepo from '../repositories/refreshToken.repo.js';
import { generateToken } from './auth.service.js';
import { UnauthorizedError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function newRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function refreshTtlMs() {
  return config.refreshTokenTtlDays * DAY_MS;
}

async function insertToken(tx, { userId, familyId, now }) {
  const raw = newRawToken();
  const expiresAt = new Date(now.getTime() + refreshTtlMs());
  const row = await refreshTokenRepo.create(tx, { userId, tokenHash: hashToken(raw), familyId, expiresAt });
  return { raw, row, expiresAt };
}

// Login and register: a new family with its first token.
export async function startSession(userId) {
  const now = new Date();
  const { raw, expiresAt } = await prisma.$transaction((tx) =>
    insertToken(tx, { userId, familyId: crypto.randomUUID(), now })
  );
  return { refreshToken: raw, refreshExpiresAt: expiresAt };
}

// Rotate a refresh token. Returns a new access token and a new refresh token in the same family.
// Unknown or expired tokens: 401. A token that was already revoked: the whole family is revoked
// (committed) and then 401, because a revoked token being presented means it was copied.
export async function rotate(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new UnauthorizedError('Refresh token missing');
  }
  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const current = await refreshTokenRepo.findByHashForUpdate(tx, hashToken(rawToken));
    if (!current) return { status: 'unknown' };
    if (current.revokedAt) {
      await refreshTokenRepo.revokeFamily(tx, current.familyId, now);
      return { status: 'reused', familyId: current.familyId, userId: current.userId };
    }
    if (current.expiresAt <= now) return { status: 'expired' };

    const user = await tx.user.findUnique({ where: { id: current.userId }, select: { id: true, email: true, role: true } });
    if (!user) return { status: 'unknown' };

    const next = await insertToken(tx, { userId: user.id, familyId: current.familyId, now });
    await refreshTokenRepo.markReplaced(tx, current.id, next.row.id, now);
    return { status: 'ok', user, next };
  });

  if (outcome.status === 'reused') {
    logger.warn('Refresh token reuse detected; family revoked', { userId: outcome.userId, familyId: outcome.familyId });
    throw new UnauthorizedError('Refresh token is no longer valid');
  }
  if (outcome.status === 'expired') throw new UnauthorizedError('Refresh token expired');
  if (outcome.status !== 'ok') throw new UnauthorizedError('Refresh token is no longer valid');

  return {
    token: generateToken(outcome.user),
    user: outcome.user,
    refreshToken: outcome.next.raw,
    refreshExpiresAt: outcome.next.expiresAt,
  };
}

// Logout: revoke the presented token. Idempotent; unknown or missing tokens are not an error.
export async function revoke(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return;
  const now = new Date();
  await prisma.$transaction((tx) => refreshTokenRepo.revokeByHash(tx, hashToken(rawToken), now));
}

export const sessionService = { hashToken, startSession, rotate, revoke, refreshTtlMs };
export default sessionService;
