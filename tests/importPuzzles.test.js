import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma, pgPool } from '../src/config/db.js';
import { importPuzzles, parseThemes, parseCliArgs, THEME_TO_MOTIF } from '../scripts/importPuzzles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_CSV = path.resolve(__dirname, 'fixtures', 'puzzles.csv');

describe('Lichess puzzle CSV importer', () => {
  beforeEach(async () => {
    await prisma.puzzle.deleteMany();
  });

  afterAll(async () => {
    await prisma.puzzle.deleteMany();
  });

  it('skips the CSV header row and imports all rows', async () => {
    const summary = await importPuzzles(FIXTURES_CSV);
    expect(summary.read).toBe(50);
    expect(summary.inserted).toBe(50);

    const headerPuzzle = await prisma.puzzle.findUnique({
      where: { lichessId: 'PuzzleId' },
    });
    expect(headerPuzzle).toBeNull();
  });

  it('filters puzzles by rating range', async () => {
    const summary = await importPuzzles(FIXTURES_CSV, {
      minRating: 1500,
      maxRating: 1800,
    });

    expect(summary.inserted).toBeGreaterThan(0);
    expect(summary.filtered).toBeGreaterThan(0);

    const puzzles = await prisma.puzzle.findMany();
    expect(puzzles.length).toBe(summary.inserted);
    for (const p of puzzles) {
      expect(p.rating).toBeGreaterThanOrEqual(1500);
      expect(p.rating).toBeLessThanOrEqual(1800);
    }
  });

  it('samples across the file using stride', async () => {
    const summary = await importPuzzles(FIXTURES_CSV, {
      stride: 5,
    });

    expect(summary.inserted).toBe(10);
    const puzzles = await prisma.puzzle.findMany({
      orderBy: { id: 'asc' },
    });
    expect(puzzles.length).toBe(10);
    expect(puzzles[0].lichessId).toBe('00004');
    expect(puzzles[1].lichessId).toBe('00010');
  });

  it('limits total imported puzzles to the specified cap', async () => {
    const summary = await importPuzzles(FIXTURES_CSV, {
      cap: 5,
    });

    expect(summary.inserted).toBe(5);
    const count = await prisma.puzzle.count();
    expect(count).toBe(5);
  });

  it('samples with stride and cap across the slice', async () => {
    const summary = await importPuzzles(FIXTURES_CSV, {
      stride: 5,
      cap: 5,
    });

    expect(summary.inserted).toBe(5);
    const puzzles = await prisma.puzzle.findMany({
      orderBy: { id: 'asc' },
    });
    expect(puzzles.length).toBe(5);
    expect(puzzles.map((p) => p.lichessId)).toEqual([
      '00004',
      '00010',
      '00015',
      '00020',
      '00025',
    ]);
  });

  it('maps theme tokens to motifs and extracts phase tags', async () => {
    await importPuzzles(FIXTURES_CSV);

    const puzzle00008 = await prisma.puzzle.findUnique({
      where: { lichessId: '00008' },
      include: {
        motifs: {
          include: { motif: true },
        },
      },
    });

    expect(puzzle00008).not.toBeNull();
    expect(puzzle00008.rating).toBe(1819);
    expect(puzzle00008.phaseTag).toBe('middlegame');
    expect(puzzle00008.movesUci).toBe(
      'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1'
    );

    const motifNames = puzzle00008.motifs.map((pm) => pm.motif.name);
    expect(motifNames).toContain('hanging_piece');
  });

  it('supports idempotent re-import without duplicating or failing', async () => {
    const firstRun = await importPuzzles(FIXTURES_CSV);
    expect(firstRun.inserted).toBe(50);

    const secondRun = await importPuzzles(FIXTURES_CSV);
    expect(secondRun.inserted).toBe(0);
    expect(secondRun.skipped).toBe(50);

    const totalCount = await prisma.puzzle.count();
    expect(totalCount).toBe(50);
  });

  it('correctly maps theme tokens via parseThemes helper', () => {
    const result = parseThemes('hangingPiece fork pin skewer backRankMate discoveredAttack middlegame');
    expect(result.phaseTag).toBe('middlegame');
    expect(result.motifs).toEqual(
      expect.arrayContaining([
        'hanging_piece',
        'fork',
        'pin',
        'skewer',
        'back_rank',
        'discovered_attack',
      ])
    );
  });

  it('parses CLI arguments correctly', () => {
    const args = parseCliArgs([
      'data/puzzles.csv',
      '--cap',
      '100',
      '--stride',
      '10',
      '--min-rating',
      '1200',
      '--max-rating',
      '2000',
    ]);

    expect(args.csvPath).toBe('data/puzzles.csv');
    expect(args.cap).toBe(100);
    expect(args.stride).toBe(10);
    expect(args.minRating).toBe(1200);
    expect(args.maxRating).toBe(2000);
  });
});
