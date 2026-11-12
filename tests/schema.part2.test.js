import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('schema part 2 - moves, evals, mates, classifications and motifs', () => {
  let platform;
  let result;
  let timeControl;
  let openingPhase;
  let stockfishEngine;
  let blunderClassification;
  let forkMotif;

  beforeAll(async () => {
    platform = await prisma.platform.upsert({
      where: { name: 'lichess' },
      update: {},
      create: { name: 'lichess' },
    });
    result = await prisma.result.upsert({
      where: { code: 'win' },
      update: {},
      create: { code: 'win' },
    });
    timeControl = await prisma.timeControl.upsert({
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
    openingPhase = await prisma.phase.upsert({
      where: { name: 'opening' },
      update: {},
      create: { name: 'opening' },
    });
    stockfishEngine = await prisma.engineVersion.upsert({
      where: {
        name_version_defaultDepth_threads_hashSize: {
          name: 'Stockfish',
          version: '16',
          defaultDepth: 12,
          threads: 1,
          hashSize: 64,
        },
      },
      update: {},
      create: {
        name: 'Stockfish',
        version: '16',
        defaultDepth: 12,
        threads: 1,
        hashSize: 64,
      },
    });
    blunderClassification = await prisma.classification.upsert({
      where: { name: 'blunder' },
      update: {},
      create: { name: 'blunder' },
    });
    forkMotif = await prisma.motif.upsert({
      where: { name: 'fork' },
      update: {},
      create: { name: 'fork' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createTestGame(tag) {
    const timestamp = `${Date.now()}_${tag}`;
    const user = await prisma.user.create({
      data: {
        email: `schema2_${timestamp}@example.com`,
        passwordHash: 'hashed_pw',
        playerAccounts: {
          create: {
            platformId: platform.id,
            username: `player_${timestamp}`,
            games: {
              create: {
                platformId: platform.id,
                externalId: `game_${timestamp}`,
                playedAt: new Date(),
                color: 'white',
                resultId: result.id,
                timeControlId: timeControl.id,
                totalPlies: 20,
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
    return user.playerAccounts[0].games[0];
  }

  it('enforces unique (gameId, ply) on moves', async () => {
    const game = await createTestGame('unique_move');

    const move1 = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moverColor: 'white',
        phaseId: openingPhase.id,
      },
    });
    expect(move1.id).toBeDefined();

    await expect(
      prisma.move.create({
        data: {
          gameId: game.id,
          ply: 1,
          san: 'd4',
          uci: 'd2d4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moverColor: 'white',
          phaseId: openingPhase.id,
        },
      })
    ).rejects.toThrow();

    const move2 = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 2,
        san: 'e5',
        uci: 'e7e5',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        moverColor: 'black',
        phaseId: openingPhase.id,
      },
    });
    expect(move2.ply).toBe(2);
  });

  it('requires all columns in MoveEval and rejects nulls at database level', async () => {
    const game = await createTestGame('eval_nulls');
    const move = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moverColor: 'white',
        phaseId: openingPhase.id,
      },
    });

    const evalRecord = await prisma.moveEval.create({
      data: {
        moveId: move.id,
        evalBeforeCp: 20,
        evalAfterCp: 25,
        bestUci: 'e2e4',
        depth: 12,
        engineVersionId: stockfishEngine.id,
      },
    });
    expect(evalRecord.moveId).toBe(move.id);

    await expect(
      prisma.$executeRaw`
        INSERT INTO move_evals (move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)
        VALUES (${move.id + 99999}, NULL, 25, 'e2e4', 12, ${stockfishEngine.id})
      `
    ).rejects.toThrow();

    await expect(
      prisma.$executeRaw`
        INSERT INTO move_evals (move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)
        VALUES (${move.id + 99999}, 20, 25, NULL, 12, ${stockfishEngine.id})
      `
    ).rejects.toThrow();
  });

  it('allows same motif with both kinds but rejects exact duplicate on (moveId, motifId, kind)', async () => {
    const game = await createTestGame('motif_kinds');
    const move = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moverColor: 'white',
        phaseId: openingPhase.id,
      },
    });

    const allowed = await prisma.moveMotif.create({
      data: {
        moveId: move.id,
        motifId: forkMotif.id,
        kind: 'allowed',
      },
    });
    expect(allowed.kind).toBe('allowed');

    const missed = await prisma.moveMotif.create({
      data: {
        moveId: move.id,
        motifId: forkMotif.id,
        kind: 'missed',
      },
    });
    expect(missed.kind).toBe('missed');

    await expect(
      prisma.moveMotif.create({
        data: {
          moveId: move.id,
          motifId: forkMotif.id,
          kind: 'allowed',
        },
      })
    ).rejects.toThrow();
  });

  it('enforces engine version uniqueness on the 5 columns', async () => {
    await expect(
      prisma.engineVersion.create({
        data: {
          name: 'Stockfish',
          version: '16',
          defaultDepth: 12,
          threads: 1,
          hashSize: 64,
        },
      })
    ).rejects.toThrow();

    const uniqueDepth = 100 + Math.floor(Math.random() * 9000);
    const differentDepth = await prisma.engineVersion.create({
      data: {
        name: 'Stockfish',
        version: '16',
        defaultDepth: uniqueDepth,
        threads: 1,
        hashSize: 64,
      },
    });
    expect(differentDepth.defaultDepth).toBe(uniqueDepth);
  });

  it('cascades delete from move to evals, mates, classifications, and motifs', async () => {
    const game = await createTestGame('cascade_move');
    const move = await prisma.move.create({
      data: {
        gameId: game.id,
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moverColor: 'white',
        phaseId: openingPhase.id,
        eval: {
          create: {
            evalBeforeCp: 20,
            evalAfterCp: 25,
            bestUci: 'e2e4',
            depth: 12,
            engineVersionId: stockfishEngine.id,
          },
        },
        mate: {
          create: {
            mateBefore: null,
            mateAfter: null,
          },
        },
        classification: {
          create: {
            classificationId: blunderClassification.id,
            cpLoss: 150,
          },
        },
        motifs: {
          create: {
            motifId: forkMotif.id,
            kind: 'allowed',
          },
        },
      },
    });

    await prisma.move.delete({
      where: { id: move.id },
    });

    const evalRow = await prisma.moveEval.findUnique({ where: { moveId: move.id } });
    const mateRow = await prisma.moveMate.findUnique({ where: { moveId: move.id } });
    const classificationRow = await prisma.moveClassification.findUnique({ where: { moveId: move.id } });
    const motifRows = await prisma.moveMotif.findMany({ where: { moveId: move.id } });

    expect(evalRow).toBeNull();
    expect(mateRow).toBeNull();
    expect(classificationRow).toBeNull();
    expect(motifRows).toHaveLength(0);
  });

  it('stores default threads=1 and hashSize=64 when created without them', async () => {
    const timestamp = Date.now();
    const version = await prisma.engineVersion.create({
      data: {
        name: `TestEngine_${timestamp}`,
        version: '1.0',
        defaultDepth: 12,
      },
    });
    expect(version.threads).toBe(1);
    expect(version.hashSize).toBe(64);

    await prisma.engineVersion.delete({ where: { id: version.id } });
  });

  it('rejects a second engine version with the same name, version and depth created with defaults', async () => {
    const timestamp = Date.now();
    const name = `DuplicateEngine_${timestamp}`;
    const version1 = await prisma.engineVersion.create({
      data: {
        name,
        version: '2.0',
        defaultDepth: 14,
      },
    });
    expect(version1.id).toBeDefined();

    await expect(
      prisma.engineVersion.create({
        data: {
          name,
          version: '2.0',
          defaultDepth: 14,
        },
      })
    ).rejects.toThrow();

    await prisma.engineVersion.delete({ where: { id: version1.id } });
  });

  it('rejects raw INSERT into engine_versions with threads = NULL', async () => {
    const timestamp = Date.now();
    await expect(
      prisma.$executeRaw`
        INSERT INTO engine_versions (name, version, default_depth, threads, hash_size)
        VALUES (${`NullEngine_${timestamp}`}, '1.0', 10, NULL, 64)
      `
    ).rejects.toThrow();
  });
});
