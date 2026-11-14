import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pgPool, closeDb } from '../src/config/db.js';

const __filename = fileURLToPath(import.meta.url);

export const THEME_TO_MOTIF = {
  hangingpiece: 'hanging_piece',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  backrankmate: 'back_rank',
  discoveredattack: 'discovered_attack',
};

const PHASE_TAGS = new Set(['opening', 'middlegame', 'endgame']);

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    csvPath: null,
    cap: null,
    stride: 1,
    minRating: null,
    maxRating: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cap') {
      const val = parseInt(argv[++i], 10);
      if (Number.isNaN(val) || val <= 0) {
        throw new Error('--cap requires a positive integer');
      }
      args.cap = val;
    } else if (arg === '--stride') {
      const val = parseInt(argv[++i], 10);
      if (Number.isNaN(val) || val <= 0) {
        throw new Error('--stride requires a positive integer');
      }
      args.stride = val;
    } else if (arg === '--min-rating') {
      const val = parseInt(argv[++i], 10);
      if (Number.isNaN(val)) {
        throw new Error('--min-rating requires an integer');
      }
      args.minRating = val;
    } else if (arg === '--max-rating') {
      const val = parseInt(argv[++i], 10);
      if (Number.isNaN(val)) {
        throw new Error('--max-rating requires an integer');
      }
      args.maxRating = val;
    } else if (!arg.startsWith('--') && !args.csvPath) {
      args.csvPath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.csvPath) {
    throw new Error(
      'Usage: node scripts/importPuzzles.js <csv> [--cap N] [--stride K] [--min-rating R] [--max-rating R]'
    );
  }

  return args;
}

export function parseThemes(themesStr) {
  if (!themesStr || typeof themesStr !== 'string') {
    return { motifs: [], phaseTag: null };
  }

  const tokens = themesStr.trim().split(/\s+/).filter(Boolean);
  const motifs = new Set();
  let phaseTag = null;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const mappedMotif = THEME_TO_MOTIF[lower];
    if (mappedMotif) {
      motifs.add(mappedMotif);
    }
    if (PHASE_TAGS.has(lower)) {
      phaseTag = lower;
    }
  }

  return { motifs: Array.from(motifs), phaseTag };
}

async function flushBatch(client, batch, motifMap) {
  if (batch.length === 0) return { inserted: 0, skipped: 0 };

  const lichessIds = [];
  const fens = [];
  const movesUcis = [];
  const ratings = [];
  const phaseTags = [];

  for (const p of batch) {
    lichessIds.push(p.lichessId);
    fens.push(p.fen);
    // Keep Moves exactly as in the CSV (Lichess convention: Moves[0] is the opponent's setup move;
    // the solver plays Moves[1..]).
    movesUcis.push(p.movesUci);
    ratings.push(p.rating);
    phaseTags.push(p.phaseTag);
  }

  await client.query('BEGIN');
  try {
    const puzzleInsertSql = `
      INSERT INTO puzzles (lichess_id, fen, moves_uci, rating, phase_tag)
      SELECT u.lichess_id, u.fen, u.moves_uci, u.rating, u.phase_tag
      FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::int[],
        $5::text[]
      ) AS u(lichess_id, fen, moves_uci, rating, phase_tag)
      ON CONFLICT (lichess_id) DO NOTHING
      RETURNING id, lichess_id;
    `;

    const puzzleRes = await client.query(puzzleInsertSql, [
      lichessIds,
      fens,
      movesUcis,
      ratings,
      phaseTags,
    ]);

    const insertedCount = puzzleRes.rowCount;
    const skippedCount = batch.length - insertedCount;

    if (insertedCount > 0) {
      const idByLichessId = new Map(puzzleRes.rows.map((r) => [r.lichess_id, r.id]));
      const puzzleIds = [];
      const motifIds = [];

      for (const p of batch) {
        const puzzleId = idByLichessId.get(p.lichessId);
        if (!puzzleId) continue;

        for (const motifName of p.motifs) {
          const motifId = motifMap.get(motifName);
          if (motifId) {
            puzzleIds.push(puzzleId);
            motifIds.push(motifId);
          }
        }
      }

      if (puzzleIds.length > 0) {
        const motifInsertSql = `
          INSERT INTO puzzle_motifs (puzzle_id, motif_id)
          SELECT u.puzzle_id, u.motif_id
          FROM UNNEST($1::int[], $2::int[]) AS u(puzzle_id, motif_id)
          ON CONFLICT (puzzle_id, motif_id) DO NOTHING;
        `;
        await client.query(motifInsertSql, [puzzleIds, motifIds]);
      }
    }

    await client.query('COMMIT');
    return { inserted: insertedCount, skipped: skippedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function importPuzzles(csvPath, options = {}) {
  const cap = options.cap ?? null;
  const stride = options.stride ?? 1;
  const minRating = options.minRating ?? null;
  const maxRating = options.maxRating ?? null;
  const batchSize = options.batchSize ?? 1000;

  const client = await pgPool.connect();
  let motifMap;

  try {
    const motifsRes = await client.query('SELECT id, name FROM motifs');
    motifMap = new Map(motifsRes.rows.map((r) => [r.name, r.id]));
  } finally {
    client.release();
  }

  let readCount = 0;
  let filteredCount = 0;
  let passedRatingCount = 0;
  let keptCount = 0;
  let strideSkippedCount = 0;
  let conflictSkippedCount = 0;
  let totalInserted = 0;

  let currentBatch = [];
  const fileStream = fs.createReadStream(csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const workerClient = await pgPool.connect();

  try {
    let isHeader = true;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isHeader) {
        isHeader = false;
        if (trimmed.toLowerCase().startsWith('puzzleid')) {
          continue;
        }
      }

      readCount += 1;

      const cols = trimmed.split(',');
      if (cols.length < 8) {
        filteredCount += 1;
        continue;
      }

      const lichessId = cols[0].trim();
      const fen = cols[1].trim();
      const movesUci = cols[2].trim();
      const rating = parseInt(cols[3].trim(), 10);
      const themesStr = cols[7].trim();

      if (!lichessId || !fen || !movesUci || Number.isNaN(rating)) {
        filteredCount += 1;
        continue;
      }

      if (minRating !== null && rating < minRating) {
        filteredCount += 1;
        continue;
      }
      if (maxRating !== null && rating > maxRating) {
        filteredCount += 1;
        continue;
      }

      passedRatingCount += 1;

      if (stride > 1 && passedRatingCount % stride !== 0) {
        strideSkippedCount += 1;
        continue;
      }

      const { motifs, phaseTag } = parseThemes(themesStr);

      currentBatch.push({
        lichessId,
        fen,
        movesUci,
        rating,
        motifs,
        phaseTag,
      });

      keptCount += 1;

      if (currentBatch.length >= batchSize) {
        const { inserted, skipped } = await flushBatch(workerClient, currentBatch, motifMap);
        totalInserted += inserted;
        conflictSkippedCount += skipped;
        console.log(
          `Batch processed: size=${currentBatch.length}, inserted=${inserted}, skipped=${skipped}`
        );
        currentBatch = [];
      }

      if (cap !== null && keptCount >= cap) {
        rl.close();
        fileStream.destroy();
        break;
      }
    }

    if (currentBatch.length > 0) {
      const { inserted, skipped } = await flushBatch(workerClient, currentBatch, motifMap);
      totalInserted += inserted;
      conflictSkippedCount += skipped;
      console.log(
        `Batch processed: size=${currentBatch.length}, inserted=${inserted}, skipped=${skipped}`
      );
      currentBatch = [];
    }
  } finally {
    workerClient.release();
  }

  const totalSkipped = strideSkippedCount + conflictSkippedCount;
  console.log(
    `Import summary: read=${readCount}, filtered=${filteredCount}, inserted=${totalInserted}, skipped=${totalSkipped}`
  );

  return {
    read: readCount,
    filtered: filteredCount,
    inserted: totalInserted,
    skipped: totalSkipped,
    conflictSkipped: conflictSkippedCount,
    strideSkipped: strideSkippedCount,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  await importPuzzles(args.csvPath, {
    cap: args.cap,
    stride: args.stride,
    minRating: args.minRating,
    maxRating: args.maxRating,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
