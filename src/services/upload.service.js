import { prisma } from '../config/db.js';
import { parsePgnString } from '../chess/pgnParser.js';
import { ingestParsedGames, createImportJob } from './import.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

export async function processPgnUpload(user, { file, accountId }) {
  if (!file || !file.buffer) {
    throw new ValidationError('PGN file is required');
  }

  const content = file.buffer.toString('utf8');
  if (!content || !content.trim()) {
    throw new ValidationError('PGN file is empty');
  }

  let parsedGames;
  try {
    parsedGames = await parsePgnString(content);
  } catch (err) {
    throw new ValidationError(`Failed to parse PGN file: ${err.message}`);
  }

  // Filter out games that cannot be ingested (e.g. unfinished or unparseable with no moves)
  const validGames = (parsedGames || []).filter(
    (g) => g && g.resultRaw !== '*' && (!g.parseError || (g.moves && g.moves.length > 0))
  );

  if (validGames.length === 0) {
    throw new ValidationError('No valid games found in PGN');
  }

  let resolvedAccountId;

  if (accountId !== undefined && accountId !== null && accountId !== '') {
    const parsedId = Number(accountId);
    if (!Number.isInteger(parsedId) || parsedId <= 0 || parsedId > 2147483647) {
      throw new NotFoundError('Player account not found');
    }

    const account = await prisma.playerAccount.findUnique({
      where: { id: parsedId },
    });

    if (!account || account.userId !== user.id) {
      throw new NotFoundError('Player account not found');
    }

    resolvedAccountId = account.id;
  } else {
    let uploadPlatform = await prisma.platform.findUnique({
      where: { name: 'upload' },
    });

    if (!uploadPlatform) {
      uploadPlatform = await prisma.platform.create({
        data: { name: 'upload' },
      });
    }

    const existingAccount = await prisma.playerAccount.findFirst({
      where: {
        userId: user.id,
        platformId: uploadPlatform.id,
      },
    });

    if (existingAccount) {
      resolvedAccountId = existingAccount.id;
    } else {
      const emailLocalPart = user.email ? user.email.split('@')[0] : `user_${user.id}`;
      let candidateUsername = emailLocalPart;

      const usernameConflict = await prisma.playerAccount.findUnique({
        where: {
          platformId_username: {
            platformId: uploadPlatform.id,
            username: candidateUsername,
          },
        },
      });

      if (usernameConflict) {
        candidateUsername = `${emailLocalPart}_${user.id}`;
      }

      const createdAccount = await prisma.playerAccount.create({
        data: {
          userId: user.id,
          platformId: uploadPlatform.id,
          username: candidateUsername,
        },
      });

      resolvedAccountId = createdAccount.id;
    }
  }

  const { insertedCount } = await ingestParsedGames(resolvedAccountId, validGames);
  const skippedCount = validGames.length - insertedCount;

  const job = await createImportJob(user.id, {
    accountId: resolvedAccountId,
    maxGames: validGames.length,
  });

  return {
    insertedCount,
    skippedCount,
    job,
  };
}

export const uploadService = {
  processPgnUpload,
};

export default uploadService;
