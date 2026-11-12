import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function seed(db = prisma) {
  // 1. Platforms
  const platforms = ['lichess', 'chesscom', 'upload'];
  for (const name of platforms) {
    await db.platform.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded platforms: ${platforms.length}`);

  // 2. Phases
  const phases = ['opening', 'middlegame', 'endgame'];
  for (const name of phases) {
    await db.phase.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded phases: ${phases.length}`);

  // 3. Classifications
  const classifications = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
  for (const name of classifications) {
    await db.classification.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded classifications: ${classifications.length}`);

  // 4. Results
  const results = ['win', 'loss', 'draw'];
  for (const code of results) {
    await db.result.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }
  console.log(`Seeded results: ${results.length}`);

  // 5. Motifs
  const motifs = [
    'hanging_piece',
    'fork',
    'pin',
    'skewer',
    'back_rank',
    'discovered_attack',
    'missed_mate',
  ];
  for (const name of motifs) {
    await db.motif.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded motifs: ${motifs.length}`);

  // 6. Time Controls
  const timeControls = [
    [60, 0],
    [60, 1],
    [120, 1],
    [180, 0],
    [180, 2],
    [300, 0],
    [300, 3],
    [600, 0],
    [600, 5],
    [900, 10],
    [1800, 0],
  ];

  for (const [baseSeconds, incrementSeconds] of timeControls) {
    const estimated = baseSeconds + 40 * incrementSeconds;
    let category = 'classical';
    if (estimated < 180) {
      category = 'bullet';
    } else if (estimated < 480) {
      category = 'blitz';
    } else if (estimated < 1500) {
      category = 'rapid';
    }

    await db.timeControl.upsert({
      where: {
        baseSeconds_incrementSeconds: {
          baseSeconds,
          incrementSeconds,
        },
      },
      update: { category },
      create: {
        baseSeconds,
        incrementSeconds,
        category,
      },
    });
  }
  console.log(`Seeded time controls: ${timeControls.length}`);

  // 7. Openings
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const openingsPath = path.join(currentDir, 'openings.json');
  const openings = JSON.parse(fs.readFileSync(openingsPath, 'utf8'));

  for (const op of openings) {
    await db.opening.upsert({
      where: {
        eco_name: {
          eco: op.eco,
          name: op.name,
        },
      },
      update: {},
      create: {
        eco: op.eco,
        name: op.name,
      },
    });
  }
  console.log(`Seeded openings: ${openings.length}`);
}

async function main() {
  try {
    await seed(prisma);
  } catch (err) {
    console.error('Seeding error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main();
}
