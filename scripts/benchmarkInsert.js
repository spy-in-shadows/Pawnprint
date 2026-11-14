import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import { insertGameWithMoves } from '../src/repositories/moveBulk.repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const BENCH_USER_EMAIL = 'bench_insert_user@example.com';
export const BENCH_USERNAME = 'bench_insert_player';

const STANDARD_OPENING_MOVES = [
  { san: 'e4', uci: 'e2e4' },
  { san: 'e5', uci: 'e7e5' },
  { san: 'Nf3', uci: 'g1f3' },
  { san: 'Nc6', uci: 'b8c6' },
  { san: 'Bc4', uci: 'f1c4' },
  { san: 'Bc5', uci: 'f8c5' },
  { san: 'c3', uci: 'c2c3' },
  { san: 'Nf6', uci: 'g8f6' },
  { san: 'd3', uci: 'd2d3' },
  { san: 'd6', uci: 'd7d6' },
  { san: 'O-O', uci: 'e1g1' },
  { san: 'O-O', uci: 'e8g8' },
  { san: 'h3', uci: 'h2h3' },
  { san: 'a6', uci: 'a7a6' },
  { san: 'Bb3', uci: 'c4b3' },
  { san: 'Ba7', uci: 'c5a7' },
  { san: 'Re1', uci: 'f1e1' },
  { san: 'h6', uci: 'h7h6' },
  { san: 'Nbd2', uci: 'b1d2' },
  { san: 'Re8', uci: 'f8e8' },
  { san: 'Nf1', uci: 'd2f1' },
  { san: 'Be6', uci: 'c8e6' },
  { san: 'Ng3', uci: 'f1g3' },
  { san: 'Qd7', uci: 'd8d7' },
  { san: 'Be3', uci: 'c1e3' },
  { san: 'Bxe3', uci: 'a7e3' },
  { san: 'Rxe3', uci: 'e1e3' },
  { san: 'Rad8', uci: 'a8d8' },
  { san: 'Qe2', uci: 'd1e2' },
  { san: 'd5', uci: 'd6d5' },
  { san: 'Rd1', uci: 'a1d1' },
  { san: 'dxe4', uci: 'd5e4' },
  { san: 'Nxe4', uci: 'g3e4' },
  { san: 'Nxe4', uci: 'f6e4' },
  { san: 'Rxe4', uci: 'e3e4' },
  { san: 'Bf5', uci: 'e6f5' },
  { san: 'Re3', uci: 'e4e3' },
  { san: 'f6', uci: 'f7f6' },
  { san: 'd4', uci: 'd3d4' },
  { san: 'exd4', uci: 'e5d4' },
];

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    games: 10000,
    plies: 40,
    strategy: 'all',
    rowSample: 500,
    keep: false,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--games' || arg === '-g') {
      args.games = parseInt(argv[++i], 10);
      if (Number.isNaN(args.games) || args.games <= 0) {
        throw new Error('--games requires a positive integer');
      }
    } else if (arg === '--plies' || arg === '-p') {
      args.plies = parseInt(argv[++i], 10);
      if (Number.isNaN(args.plies) || args.plies <= 0) {
        throw new Error('--plies requires a positive integer');
      }
    } else if (arg === '--strategy' || arg === '-s') {
      args.strategy = argv[++i];
      if (!['prisma-row', 'prisma-many', 'unnest', 'all'].includes(args.strategy)) {
        throw new Error(
          `Invalid strategy: ${args.strategy}. Must be one of: prisma-row, prisma-many, unnest, all`
        );
      }
    } else if (arg === '--row-sample') {
      args.rowSample = parseInt(argv[++i], 10);
      if (Number.isNaN(args.rowSample) || args.rowSample <= 0) {
        throw new Error('--row-sample requires a positive integer');
      }
    } else if (arg === '--keep') {
      args.keep = true;
    } else if (arg === '--out') {
      args.out = argv[++i];
      if (!args.out) {
        throw new Error('--out requires a file path');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export function createPrng(seed = 42) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSyntheticGame(gameIndex, pliesCount = 40, prng = createPrng(gameIndex), tag = 'bench') {
  const moves = [];
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  for (let ply = 1; ply <= pliesCount; ply += 1) {
    const isWhite = ply % 2 === 1;
    const moveTemplate = STANDARD_OPENING_MOVES[(ply - 1) % STANDARD_OPENING_MOVES.length];
    let phase = 'opening';
    if (ply > 60) {
      phase = 'endgame';
    } else if (ply > 20) {
      phase = 'middlegame';
    }

    moves.push({
      ply,
      san: moveTemplate.san,
      uci: moveTemplate.uci,
      fenBefore: startFen,
      moverColor: isWhite ? 'white' : 'black',
      phase,
      clockRemainingMs: Math.max(1000, 180000 - ply * 2000),
      timeSpentMs: 2000,
    });
  }

  const resultOptions = ['1-0', '0-1', '1/2-1/2'];
  const resultRaw = resultOptions[gameIndex % resultOptions.length];
  const whiteElo = 1500 + Math.floor(prng() * 400);
  const blackElo = 1500 + Math.floor(prng() * 400);

  return {
    externalId: `${tag}_${gameIndex}_${Math.floor(prng() * 1000000)}`,
    white: BENCH_USERNAME,
    black: 'bench_opponent',
    whiteElo,
    blackElo,
    resultRaw,
    eco: 'C50',
    openingName: 'Italian Game',
    timeControl: { baseSeconds: 180, incrementSeconds: 2, category: 'blitz' },
    playedAt: new Date(1700000000000 + gameIndex * 60000),
    totalPlies: pliesCount,
    parseError: null,
    moves,
  };
}

export function generateSyntheticGames(count, pliesCount = 40, seed = 12345, tag = 'bench') {
  const prng = createPrng(seed);
  const games = [];
  for (let i = 0; i < count; i += 1) {
    games.push(generateSyntheticGame(i, pliesCount, prng, tag));
  }
  return games;
}

export async function setupBenchmarkAccount() {
  const user = await prisma.user.upsert({
    where: { email: BENCH_USER_EMAIL },
    update: {},
    create: {
      email: BENCH_USER_EMAIL,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    },
  });

  const platform = await prisma.platform.findUnique({
    where: { name: 'upload' },
  });
  if (!platform) {
    throw new Error("Platform 'upload' not found in database; run npm run seed first");
  }

  const account = await prisma.playerAccount.upsert({
    where: {
      platformId_username: {
        platformId: platform.id,
        username: BENCH_USERNAME,
      },
    },
    update: {},
    create: {
      userId: user.id,
      platformId: platform.id,
      username: BENCH_USERNAME,
    },
  });

  return { user, platform, account };
}

export async function cleanupBenchmarkData(keep = false) {
  if (keep) return;

  const accounts = await prisma.playerAccount.findMany({
    where: { user: { email: BENCH_USER_EMAIL } },
    select: { id: true },
  });

  if (accounts.length > 0) {
    const accountIds = accounts.map((a) => a.id);
    await prisma.game.deleteMany({
      where: { playerAccountId: { in: accountIds } },
    });
  }

  await prisma.user.deleteMany({
    where: { email: BENCH_USER_EMAIL },
  });
}

async function preparePrismaLookups() {
  const resultWin = await prisma.result.findUnique({ where: { code: 'win' } });
  const resultLoss = await prisma.result.findUnique({ where: { code: 'loss' } });
  const resultDraw = await prisma.result.findUnique({ where: { code: 'draw' } });
  const resultMap = {
    '1-0': resultWin.id,
    '0-1': resultLoss.id,
    '1/2-1/2': resultDraw.id,
  };

  const phases = await prisma.phase.findMany();
  const phaseMap = Object.fromEntries(phases.map((p) => [p.name, p.id]));

  const opening = await prisma.opening.findFirst({ where: { eco: 'C50' } });
  const openingId = opening?.id ?? null;

  const timeControl = await prisma.timeControl.upsert({
    where: {
      baseSeconds_incrementSeconds: {
        baseSeconds: 180,
        incrementSeconds: 2,
      },
    },
    update: {},
    create: {
      baseSeconds: 180,
      incrementSeconds: 2,
      category: 'blitz',
    },
  });
  const timeControlId = timeControl.id;

  return { resultMap, phaseMap, openingId, timeControlId, defaultResultId: resultWin.id };
}

export async function runPrismaRow({ account, platform, games, plies, rowSample, lookups }) {
  const totalGames = games.length;
  const sampleCount = Math.min(totalGames, rowSample);
  const isEstimated = sampleCount < totalGames;

  const start = performance.now();
  for (let i = 0; i < sampleCount; i += 1) {
    const g = games[i];
    const createdGame = await prisma.game.create({
      data: {
        playerAccountId: account.id,
        platformId: platform.id,
        externalId: g.externalId,
        playedAt: g.playedAt,
        color: g.white === account.username ? 'white' : 'black',
        resultId: lookups.resultMap[g.resultRaw] ?? lookups.defaultResultId,
        openingId: lookups.openingId,
        timeControlId: lookups.timeControlId,
        playerRating: g.whiteElo,
        opponentRating: g.blackElo,
        totalPlies: g.moves.length,
        analysisStatus: 'pending',
      },
    });

    for (let mIdx = 0; mIdx < g.moves.length; mIdx += 1) {
      const m = g.moves[mIdx];
      await prisma.move.create({
        data: {
          gameId: createdGame.id,
          ply: m.ply,
          san: m.san,
          uci: m.uci,
          fenBefore: m.fenBefore,
          moverColor: m.moverColor,
          clockRemainingMs: m.clockRemainingMs,
          timeSpentMs: m.timeSpentMs,
          phaseId: lookups.phaseMap[m.phase] ?? 1,
        },
      });
    }
  }

  const durationMs = performance.now() - start;
  const sampleMoves = sampleCount * plies;
  const movesPerSec = (sampleMoves / (durationMs / 1000));
  const totalPlies = totalGames * plies;
  const effectiveDurationMs = isEstimated
    ? Math.round((totalPlies / movesPerSec) * 1000)
    : Math.round(durationMs);

  return {
    strategy: 'prisma-row',
    label: 'Prisma create (per-row)',
    games: totalGames,
    plies,
    totalPlies,
    sampleCount,
    isEstimated,
    durationMs: effectiveDurationMs,
    sampleDurationMs: Math.round(durationMs),
    movesPerSec: Math.round(movesPerSec),
  };
}

export async function runPrismaMany({ account, platform, games, plies, lookups }) {
  const totalGames = games.length;
  const start = performance.now();

  for (let i = 0; i < totalGames; i += 1) {
    const g = games[i];
    const createdGame = await prisma.game.create({
      data: {
        playerAccountId: account.id,
        platformId: platform.id,
        externalId: g.externalId,
        playedAt: g.playedAt,
        color: g.white === account.username ? 'white' : 'black',
        resultId: lookups.resultMap[g.resultRaw] ?? lookups.defaultResultId,
        openingId: lookups.openingId,
        timeControlId: lookups.timeControlId,
        playerRating: g.whiteElo,
        opponentRating: g.blackElo,
        totalPlies: g.moves.length,
        analysisStatus: 'pending',
      },
    });

    await prisma.move.createMany({
      data: g.moves.map((m) => ({
        gameId: createdGame.id,
        ply: m.ply,
        san: m.san,
        uci: m.uci,
        fenBefore: m.fenBefore,
        moverColor: m.moverColor,
        clockRemainingMs: m.clockRemainingMs,
        timeSpentMs: m.timeSpentMs,
        phaseId: lookups.phaseMap[m.phase] ?? 1,
      })),
    });
  }

  const durationMs = performance.now() - start;
  const totalPlies = totalGames * plies;
  const movesPerSec = (totalPlies / (durationMs / 1000));

  return {
    strategy: 'prisma-many',
    label: 'Prisma createMany',
    games: totalGames,
    plies,
    totalPlies,
    sampleCount: totalGames,
    isEstimated: false,
    durationMs: Math.round(durationMs),
    movesPerSec: Math.round(movesPerSec),
  };
}

export async function runUnnest({ account, games, plies }) {
  const totalGames = games.length;
  const start = performance.now();

  for (let i = 0; i < totalGames; i += 1) {
    await insertGameWithMoves(account.id, games[i]);
  }

  const durationMs = performance.now() - start;
  const totalPlies = totalGames * plies;
  const movesPerSec = (totalPlies / (durationMs / 1000));

  return {
    strategy: 'unnest',
    label: 'pg UNNEST (insertGameWithMoves)',
    games: totalGames,
    plies,
    totalPlies,
    sampleCount: totalGames,
    isEstimated: false,
    durationMs: Math.round(durationMs),
    movesPerSec: Math.round(movesPerSec),
  };
}

export async function getMachineInfo() {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown CPU';
  const cpuCores = cpus.length;
  const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
  const nodeVersion = process.version;

  const pgRes = await pgPool.query('SELECT version();');
  const pgFull = pgRes.rows[0].version;
  const pgMatch = pgFull.match(/PostgreSQL \d+(\.\d+)?/i);
  const pgVersion = pgMatch ? pgMatch[0] : pgFull.split(' on ')[0];

  return {
    cpu: `${cpuModel} (${cpuCores} cores)`,
    ram: `${totalMemGb} GB`,
    node: nodeVersion,
    postgres: pgVersion,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
  };
}

export function formatMarkdownTable(results) {
  const baseline = results.find((r) => r.strategy === 'prisma-row') ?? results[0];
  const baselineRate = baseline?.movesPerSec || 1;

  const headers = [
    'Strategy',
    'Games',
    'Plies / Game',
    'Total Plies',
    'Duration',
    'Moves / sec',
    'Speedup',
  ];

  const rows = results.map((r) => {
    const durationSec = (r.durationMs / 1000).toFixed(2);
    const durationLabel = r.isEstimated ? `${durationSec}s *` : `${durationSec}s`;
    const speedup = (r.movesPerSec / baselineRate).toFixed(1);
    const speedupLabel = r === baseline ? '1.0x (baseline)' : `${speedup}x`;

    return [
      r.label,
      r.games.toLocaleString(),
      String(r.plies),
      r.totalPlies.toLocaleString(),
      durationLabel,
      r.movesPerSec.toLocaleString(),
      speedupLabel,
    ];
  });

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );

  const formatRow = (cols) =>
    `| ${cols.map((c, i) => (i === 0 ? c.padEnd(colWidths[i]) : c.padStart(colWidths[i]))).join(' | ')} |`;

  const separator = `| ${colWidths
    .map((w, i) => (i === 0 ? `:${'-'.repeat(Math.max(1, w - 1))}` : `${'-'.repeat(Math.max(1, w - 1))}:`))
    .join(' | ')} |`;

  const tableLines = [formatRow(headers), separator, ...rows.map(formatRow)];

  const hasEstimated = results.some((r) => r.isEstimated);
  if (hasEstimated) {
    const est = results.find((r) => r.isEstimated);
    tableLines.push('');
    tableLines.push(`\\* Extrapolated from ${est.sampleCount.toLocaleString()}-game sample (${(est.sampleDurationMs / 1000).toFixed(2)}s).`);
  }

  return tableLines.join('\n');
}

export function formatReportMarkdown(machine, results) {
  const table = formatMarkdownTable(results);
  const baseline = results.find((r) => r.strategy === 'prisma-row') ?? results[0];
  const baselineRate = baseline?.movesPerSec || 1;

  const createManyRes = results.find((r) => r.strategy === 'prisma-many');
  const unnestRes = results.find((r) => r.strategy === 'unnest');

  const createManySpeedup = createManyRes
    ? `${(createManyRes.movesPerSec / baselineRate).toFixed(1)}x`
    : null;
  const unnestSpeedup = unnestRes
    ? `${(unnestRes.movesPerSec / baselineRate).toFixed(1)}x`
    : null;

  const createManyNote = createManySpeedup
    ? `, bringing moves/sec up by ${createManySpeedup} compared to per-row`
    : '';
  const unnestNote = unnestSpeedup
    ? `, achieving ${unnestSpeedup} speedup over the per-row baseline`
    : ', achieving maximum ingestion throughput';

  return `# Game Ingestion and Move Insertion Benchmark

## Environment
- **CPU**: ${machine.cpu}
- **RAM**: ${machine.ram}
- **Node.js**: ${machine.node}
- **PostgreSQL**: ${machine.postgres}
- **OS**: ${machine.os}

## Benchmark Results
${table}

## Analysis
- **Write Amplification in Per-Row ORM**: Inserting each move as an isolated row (\`prisma.move.create\`) produces significant network overhead and transaction commit overhead (one round trip and WAL flush per ply).
- **Prisma createMany**: Batching moves into a single \`createMany\` per game eliminates ply-level round trips${createManyNote}, but remains bounded by client-side query generation and parameters limit.
- **PostgreSQL UNNEST**: In \`insertGameWithMoves\`, moves are passed as parallel typed arrays to an \`INSERT INTO moves ... SELECT ... FROM UNNEST(...)\` statement within a single transaction. This completes in a single network round trip and single WAL flush per game${unnestNote}.
`;
}

export async function runBenchmark(cliOptions = {}) {
  const options = {
    ...parseCliArgs([]),
    ...cliOptions,
  };

  const { user, platform, account } = await setupBenchmarkAccount();
  const lookups = await preparePrismaLookups();
  const machine = await getMachineInfo();

  const results = [];
  const strat = options.strategy;

  try {
    if (strat === 'prisma-row' || strat === 'all') {
      await prisma.game.deleteMany({ where: { playerAccountId: account.id } });
      const games = generateSyntheticGames(options.games, options.plies, 101, 'p_row');
      const res = await runPrismaRow({
        account,
        platform,
        games,
        plies: options.plies,
        rowSample: options.rowSample,
        lookups,
      });
      results.push(res);
    }

    if (strat === 'prisma-many' || strat === 'all') {
      await prisma.game.deleteMany({ where: { playerAccountId: account.id } });
      const games = generateSyntheticGames(options.games, options.plies, 202, 'p_many');
      const res = await runPrismaMany({
        account,
        platform,
        games,
        plies: options.plies,
        lookups,
      });
      results.push(res);
    }

    if (strat === 'unnest' || strat === 'all') {
      await prisma.game.deleteMany({ where: { playerAccountId: account.id } });
      const games = generateSyntheticGames(options.games, options.plies, 303, 'unnest');
      const res = await runUnnest({
        account,
        games,
        plies: options.plies,
      });
      results.push(res);
    }

    const tableMarkdown = formatMarkdownTable(results);
    console.log('\n--- Move Insertion Benchmark Results ---');
    console.log(tableMarkdown);
    console.log('');

    const targetOut =
      options.out ||
      (options.strategy === 'all'
        ? path.join(ROOT_DIR, 'docs', 'benchmarks', 'insert.md')
        : null);

    if (targetOut) {
      const docContent = formatReportMarkdown(machine, results);
      await fs.mkdir(path.dirname(targetOut), { recursive: true });
      await fs.writeFile(targetOut, docContent, 'utf8');
    }

    return { results, machine, tableMarkdown };
  } finally {
    await cleanupBenchmarkData(options.keep);
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  await runBenchmark(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
