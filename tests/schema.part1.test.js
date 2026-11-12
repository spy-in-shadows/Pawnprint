import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('schema part 1 - lookups, identity and games', () => {
  beforeAll(async () => {
    await prisma.platform.upsert({
      where: { name: 'lichess' },
      update: {},
      create: { name: 'lichess' },
    });
    await prisma.result.upsert({
      where: { code: 'win' },
      update: {},
      create: { code: 'win' },
    });
    await prisma.timeControl.upsert({
      where: {
        baseSeconds_incrementSeconds: {
          baseSeconds: 180,
          incrementSeconds: 0,
        },
      },
      update: {},
      create: {
        baseSeconds: 180,
        incrementSeconds: 0,
        category: 'blitz',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creating user -> account -> game works and analysisStatus defaults to pending', async () => {
    const timestamp = Date.now();
    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const result = await prisma.result.findUnique({ where: { code: 'win' } });
    const timeControl = await prisma.timeControl.findFirst({
      where: { baseSeconds: 180, incrementSeconds: 0 },
    });

    const user = await prisma.user.create({
      data: {
        email: `test_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: `player_${timestamp}`,
            games: {
              create: {
                platformId: platform.id,
                externalId: `ext_game_${timestamp}`,
                playedAt: new Date(),
                color: 'white',
                resultId: result.id,
                timeControlId: timeControl.id,
                totalPlies: 40,
              },
            },
          },
        },
      },
      include: {
        playerAccounts: {
          include: {
            games: true,
          },
        },
      },
    });

    expect(user.id).toBeDefined();
    expect(user.playerAccounts).toHaveLength(1);
    const account = user.playerAccounts[0];
    expect(account.games).toHaveLength(1);
    const game = account.games[0];
    expect(game.analysisStatus).toBe('pending');
    expect(game.externalId).toBe(`ext_game_${timestamp}`);
  });

  it('rejects a second game with the same (platformId, externalId)', async () => {
    const timestamp = Date.now();
    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const result = await prisma.result.findUnique({ where: { code: 'win' } });
    const externalId = `ext_dup_${timestamp}`;

    const user = await prisma.user.create({
      data: {
        email: `dup_user_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: `dup_player_${timestamp}`,
          },
        },
      },
      include: {
        playerAccounts: true,
      },
    });
    const accountId = user.playerAccounts[0].id;

    await prisma.game.create({
      data: {
        playerAccountId: accountId,
        platformId: platform.id,
        externalId,
        playedAt: new Date(),
        color: 'white',
        resultId: result.id,
        totalPlies: 20,
      },
    });

    await expect(
      prisma.game.create({
        data: {
          playerAccountId: accountId,
          platformId: platform.id,
          externalId,
          playedAt: new Date(),
          color: 'black',
          resultId: result.id,
          totalPlies: 30,
        },
      })
    ).rejects.toThrow();
  });

  it('cascades delete from player account to games', async () => {
    const timestamp = Date.now();
    const platform = await prisma.platform.findUnique({ where: { name: 'lichess' } });
    const result = await prisma.result.findUnique({ where: { code: 'win' } });

    const user = await prisma.user.create({
      data: {
        email: `cascade_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: `cascade_player_${timestamp}`,
            games: {
              create: {
                platformId: platform.id,
                externalId: `cascade_game_${timestamp}`,
                playedAt: new Date(),
                color: 'white',
                resultId: result.id,
                totalPlies: 10,
              },
            },
          },
        },
      },
      include: {
        playerAccounts: {
          include: { games: true },
        },
      },
    });

    const account = user.playerAccounts[0];
    const gameId = account.games[0].id;

    await prisma.playerAccount.delete({
      where: { id: account.id },
    });

    const gameAfter = await prisma.game.findUnique({
      where: { id: gameId },
    });
    expect(gameAfter).toBeNull();
  });
});

