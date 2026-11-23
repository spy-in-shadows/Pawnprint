import { prisma } from '../config/db.js';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors.js';

const INT4_MAX = 2147483647;

export function parseIntId(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    return null;
  }

  if (typeof value === 'object') {
    return null;
  }

  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0 || num > INT4_MAX) {
    return null;
  }

  return num;
}

export async function listAccounts(userId) {
  return prisma.playerAccount.findMany({
    where: { userId },
    include: {
      platform: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

// platform (lower-cased, one of the known platforms) and username (trimmed, non-empty) are
// validated by linkAccountBody (src/validation/account.schemas.js).
export async function linkAccount(userId, { platform: normalizedPlatform, username: normalizedUsername }) {

  const platformRecord = await prisma.platform.findUnique({
    where: { name: normalizedPlatform },
  });

  if (!platformRecord) {
    throw new ValidationError(`Platform '${normalizedPlatform}' is not configured`);
  }

  const existing = await prisma.playerAccount.findUnique({
    where: {
      platformId_username: {
        platformId: platformRecord.id,
        username: normalizedUsername,
      },
    },
  });

  if (existing) {
    throw new ConflictError(
      existing.userId === userId
        ? 'Account already linked to your profile'
        : 'Account username is already linked to another user'
    );
  }

  return prisma.playerAccount.create({
    data: {
      userId,
      platformId: platformRecord.id,
      username: normalizedUsername,
    },
    include: {
      platform: true,
    },
  });
}

// accountId is a validated positive int4 (accountIdParams).
export async function deleteAccount(userId, parsedId) {
  const account = await prisma.playerAccount.findUnique({
    where: { id: parsedId },
  });

  if (!account || account.userId !== userId) {
    throw new NotFoundError('Player account not found');
  }

  await prisma.playerAccount.delete({
    where: { id: parsedId },
  });
}

export const accountService = {
  parseIntId,
  listAccounts,
  linkAccount,
  deleteAccount,
};

export default accountService;
