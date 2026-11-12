import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed/index.js';

const prisma = new PrismaClient();

describe('database seed script', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function getTableCounts() {
    return {
      platforms: await prisma.platform.count(),
      phases: await prisma.phase.count(),
      classifications: await prisma.classification.count(),
      results: await prisma.result.count(),
      motifs: await prisma.motif.count(),
      timeControls: await prisma.timeControl.count(),
      openings: await prisma.opening.count(),
      engineVersions: await prisma.engineVersion.count(),
    };
  }

  it('running the seed twice leaves identical row counts and no engine_versions rows added', async () => {
    const engineVersionsBefore = await prisma.engineVersion.count();

    // First run
    await seed(prisma);
    const countsAfterFirst = await getTableCounts();

    expect(countsAfterFirst.platforms).toBe(3);
    expect(countsAfterFirst.phases).toBe(3);
    expect(countsAfterFirst.classifications).toBe(5);
    expect(countsAfterFirst.results).toBe(3);
    expect(countsAfterFirst.motifs).toBe(7);
    expect(countsAfterFirst.timeControls).toBe(11);
    expect(countsAfterFirst.openings).toBeGreaterThanOrEqual(28);
    // Seed must not create any engine_versions rows
    expect(countsAfterFirst.engineVersions).toBe(engineVersionsBefore);

    // Second run
    await seed(prisma);
    const countsAfterSecond = await getTableCounts();

    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });

  it('seeds expected lookup values and categories accurately', async () => {
    await seed(prisma);

    // Platforms
    const platforms = await prisma.platform.findMany({ select: { name: true } });
    const platformNames = platforms.map((p) => p.name).sort();
    expect(platformNames).toEqual(['chesscom', 'lichess', 'upload']);

    // Phases
    const phases = await prisma.phase.findMany({ select: { name: true } });
    const phaseNames = phases.map((p) => p.name).sort();
    expect(phaseNames).toEqual(['endgame', 'middlegame', 'opening']);

    // Classifications
    const classifications = await prisma.classification.findMany({ select: { name: true } });
    const classNames = classifications.map((c) => c.name).sort();
    expect(classNames).toEqual(['best', 'blunder', 'good', 'inaccuracy', 'mistake']);

    // Results
    const results = await prisma.result.findMany({ select: { code: true } });
    const resultCodes = results.map((r) => r.code).sort();
    expect(resultCodes).toEqual(['draw', 'loss', 'win']);

    // Motifs
    const motifs = await prisma.motif.findMany({ select: { name: true } });
    const motifNames = motifs.map((m) => m.name).sort();
    expect(motifNames).toEqual([
      'back_rank',
      'discovered_attack',
      'fork',
      'hanging_piece',
      'missed_mate',
      'pin',
      'skewer',
    ]);

    // Time controls rule: estimated = base + 40*increment (<180 bullet, <480 blitz, <1500 rapid, else classical)
    const bullet = await prisma.timeControl.findUnique({
      where: { baseSeconds_incrementSeconds: { baseSeconds: 60, incrementSeconds: 0 } },
    });
    expect(bullet?.category).toBe('bullet');

    const blitz = await prisma.timeControl.findUnique({
      where: { baseSeconds_incrementSeconds: { baseSeconds: 180, incrementSeconds: 0 } },
    });
    expect(blitz?.category).toBe('blitz');

    const rapid = await prisma.timeControl.findUnique({
      where: { baseSeconds_incrementSeconds: { baseSeconds: 600, incrementSeconds: 0 } },
    });
    expect(rapid?.category).toBe('rapid');

    const classical = await prisma.timeControl.findUnique({
      where: { baseSeconds_incrementSeconds: { baseSeconds: 1800, incrementSeconds: 0 } },
    });
    expect(classical?.category).toBe('classical');

    // Openings must include required common openings
    const sicilian = await prisma.opening.findUnique({
      where: { eco_name: { eco: 'B20', name: 'Sicilian Defense' } },
    });
    expect(sicilian).not.toBeNull();

    const italian = await prisma.opening.findUnique({
      where: { eco_name: { eco: 'C50', name: 'Italian Game' } },
    });
    expect(italian).not.toBeNull();

    const qgd = await prisma.opening.findUnique({
      where: { eco_name: { eco: 'D35', name: "Queen's Gambit Declined" } },
    });
    expect(qgd).not.toBeNull();
  });
});
