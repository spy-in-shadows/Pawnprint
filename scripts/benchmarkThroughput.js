import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import config from '../src/config/env.js';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import { classifyPhase } from '../src/chess/phase.js';
import { StockfishClient } from '../src/chess/stockfishClient.js';
import { createImportJob, ingestParsedGames } from '../src/services/import.service.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');
const WORKER_SCRIPT = path.join(ROOT_DIR, 'src', 'worker.js');
const REPORT_PATH = path.join(ROOT_DIR, 'docs', 'benchmarks', 'throughput.md');

export const BENCH_USER_EMAIL = 'bench_throughput_user@example.com';
const GAME_SEED = 20261114;
const POLL_INTERVAL_MS = 250;
const WORKER_STOP_TIMEOUT_MS = 15000;
const FINISHED_STATUSES = new Set(['completed', 'failed']);

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
  return n;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { games: 60, workers: [1, 2, 3], depth: config.engineDepth, plies: 40, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--games') args.games = positiveInt(argv[++i], arg);
    else if (arg === '--plies') args.plies = positiveInt(argv[++i], arg);
    else if (arg === '--depth') args.depth = positiveInt(argv[++i], arg);
    else if (arg === '--workers') {
      args.workers = String(argv[++i] ?? '').split(',').map((w) => positiveInt(w.trim(), arg));
    } else if (arg === '--keep') args.keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function createPrng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same rule as gameAnalyzer: these final positions are resolved from the board, not by the engine.
function isTerminalForAnalyzer(board) {
  return board.isCheckmate() || board.isStalemate() || board.isThreefoldRepetition() || board.isDrawByFiftyMoves();
}

// Plays uniformly random legal moves until maxPlies or the game ends. Returns the moves in
// ParsedGame form plus whether the analyzer will skip the engine for the final position.
export function generateRandomGame(maxPlies, rand) {
  const board = new Chess();
  const moves = [];
  for (let ply = 1; ply <= maxPlies && !board.isGameOver(); ply += 1) {
    const legal = board.moves({ verbose: true });
    const choice = legal[Math.floor(rand() * legal.length)];
    const fenBefore = board.fen();
    moves.push({
      ply,
      san: choice.san,
      uci: choice.from + choice.to + (choice.promotion ?? ''),
      fenBefore,
      moverColor: board.turn() === 'w' ? 'white' : 'black',
      phase: classifyPhase(fenBefore, ply),
      clockRemainingMs: null,
      timeSpentMs: null,
    });
    board.move(choice);
  }
  let resultRaw = '1/2-1/2';
  if (board.isCheckmate()) resultRaw = board.turn() === 'w' ? '0-1' : '1-0';
  return { moves, resultRaw, terminalEnd: isTerminalForAnalyzer(board) };
}

export function generateGames(count, maxPlies, seed = GAME_SEED) {
  const rand = createPrng(seed);
  return Array.from({ length: count }, () => generateRandomGame(maxPlies, rand));
}

function toParsedGame(game, index, username, tag) {
  const playerIsWhite = index % 2 === 0;
  return {
    externalId: `${tag}_${index}`,
    white: playerIsWhite ? username : 'bench_opponent',
    black: playerIsWhite ? 'bench_opponent' : username,
    whiteElo: 1500,
    blackElo: 1500,
    resultRaw: game.resultRaw,
    eco: null,
    openingName: null,
    timeControl: { baseSeconds: 180, incrementSeconds: 2, category: 'blitz' },
    playedAt: new Date(Date.UTC(2026, 0, 1) + index * 60000),
    totalPlies: game.moves.length,
    parseError: null,
    moves: game.moves,
  };
}

async function cleanup() {
  // Accounts cascade to games, moves, evals and jobs. engine_versions rows are shared and immutable.
  await prisma.user.deleteMany({ where: { email: BENCH_USER_EMAIL } });
}

// Workers claim any queued job in the table, so foreign jobs would distort the numbers or make
// the workers call external APIs.
async function assertNoForeignActiveJobs() {
  const foreign = await prisma.analysisJob.findMany({
    where: { status: { in: ['queued', 'running'] }, playerAccount: { user: { email: { not: BENCH_USER_EMAIL } } } },
    select: { id: true },
  });
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to run: ${foreign.length} queued/running job(s) belong to other accounts (ids ${foreign
        .map((j) => j.id)
        .join(', ')}). Run against a database without active jobs.`,
    );
  }
}

async function getMachineInfo(depth) {
  const engine = new StockfishClient({ depth });
  await engine.init();
  const engineInfo = {
    name: [engine.engineName, engine.engineVersion].filter(Boolean).join(' '),
    depth: engine.depth,
    threads: engine.threads,
    hashMb: engine.hashSize,
  };
  await engine.quit();

  const pgRes = await pgPool.query('SHOW server_version');
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    ramGb: (os.totalmem() / 1024 ** 3).toFixed(1),
    node: process.version,
    postgres: `PostgreSQL ${pgRes.rows[0].server_version.split(' ')[0]}`,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    engine: engineInfo,
  };
}

function spawnWorker(prefix, depth) {
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, WORKER_ID_PREFIX: prefix, ENGINE_DEPTH: String(depth), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

async function stopWorkers(children) {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_STOP_TIMEOUT_MS);
      await child.exited;
      clearTimeout(timer);
    }),
  );
}

async function waitForJobs(jobIds, children) {
  let earlyExit = null;
  for (const child of children) {
    child.exited.then((info) => {
      earlyExit ??= info;
    });
  }
  for (;;) {
    const jobs = await prisma.analysisJob.findMany({ where: { id: { in: jobIds } }, select: { status: true } });
    if (jobs.every((j) => FINISHED_STATUSES.has(j.status))) return;
    if (earlyExit) {
      throw new Error(`A worker exited before the jobs finished (code ${earlyExit.code}, signal ${earlyExit.signal})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function runForWorkerCount(workerCount, games, { depth, userId, platformId }) {
  const accounts = [];
  for (let k = 0; k < workerCount; k += 1) {
    accounts.push(
      await prisma.playerAccount.create({
        data: { userId, platformId, username: `bench_tp_w${workerCount}_a${k}` },
      }),
    );
  }

  const perAccount = accounts.map(() => []);
  games.forEach((game, i) => {
    const k = i % workerCount;
    perAccount[k].push(toParsedGame(game, i, accounts[k].username, `bench_tp_w${workerCount}`));
  });
  for (let k = 0; k < workerCount; k += 1) {
    await ingestParsedGames(accounts[k].id, perAccount[k]);
  }

  const jobs = [];
  for (let k = 0; k < workerCount; k += 1) {
    jobs.push(await createImportJob(userId, { accountId: accounts[k].id, maxGames: perAccount[k].length }));
  }
  const jobIds = jobs.map((j) => j.id);

  const startedAt = performance.now();
  const children = Array.from({ length: workerCount }, (_, k) => spawnWorker(`bench-w${workerCount}-${k}`, depth));
  let wallMs;
  try {
    await waitForJobs(jobIds, children);
    wallMs = performance.now() - startedAt;
  } finally {
    await stopWorkers(children);
  }

  const accountIds = accounts.map((a) => a.id);
  const [finishedJobs, analyzed] = await Promise.all([
    prisma.analysisJob.findMany({ where: { id: { in: jobIds } }, select: { status: true, lockedBy: true } }),
    prisma.game.findMany({
      where: { playerAccountId: { in: accountIds }, analysisStatus: 'analyzed' },
      select: { externalId: true, totalPlies: true },
    }),
  ]);

  const terminalById = new Map(games.map((g, i) => [`bench_tp_w${workerCount}_${i}`, g.terminalEnd]));
  const analyzedPlies = analyzed.reduce((sum, g) => sum + g.totalPlies, 0);
  // N plies cost N + 1 calls, but the start position is searched once per worker process and a
  // terminal final position is never searched.
  const workersUsed = new Set(finishedJobs.map((j) => j.lockedBy).filter(Boolean)).size;
  const engineCalls =
    analyzed.reduce((sum, g) => sum + g.totalPlies - (terminalById.get(g.externalId) ? 1 : 0), 0) + workersUsed;

  const wallSec = wallMs / 1000;
  return {
    workers: workerCount,
    games: analyzed.length,
    plies: analyzedPlies,
    wallSec,
    gamesPerMin: analyzed.length / (wallSec / 60),
    pliesPerSec: analyzedPlies / wallSec,
    engineCallsPerGame: analyzed.length ? engineCalls / analyzed.length : 0,
    failedJobs: finishedJobs.filter((j) => j.status !== 'completed').length,
  };
}

export function formatTable(results) {
  const base = results.find((r) => r.workers === 1) ?? results[0];
  const header =
    '| Workers | Games | Plies | Wall time | Games / min | Plies / sec | Engine calls / game | Speedup | Failed jobs |\n' +
    '| ------: | ----: | ----: | --------: | ----------: | ----------: | ------------------: | ------: | ----------: |';
  const rows = results.map(
    (r) =>
      `| ${r.workers} | ${r.games} | ${r.plies} | ${r.wallSec.toFixed(1)} s | ${r.gamesPerMin.toFixed(1)} | ` +
      `${r.pliesPerSec.toFixed(1)} | ${r.engineCallsPerGame.toFixed(2)} | ${(r.pliesPerSec / base.pliesPerSec).toFixed(2)}x | ${r.failedJobs} |`,
  );
  return [header, ...rows].join('\n');
}

export function formatReport(machine, options, results) {
  const e = machine.engine;
  return `# Analysis Throughput Benchmark

Produced by \`node scripts/benchmarkThroughput.js --games ${options.games} --workers ${options.workers.join(',')} --plies ${options.plies} --depth ${options.depth}\`.

## Method
- ${options.games} random legal games (chess.js, seeded PRNG ${GAME_SEED}), at most ${options.plies} plies each, inserted with \`ingestParsedGames\`.
- For W workers the games are split over W fresh accounts with one job each (one active job per account), then W \`node src/worker.js\` processes are started.
- Wall time runs from spawning the workers until every job is finished in the database, so it includes process and engine start-up.
- Engine calls per game: N + 1 per N-ply game, minus terminal final positions, with the start position searched once per worker.

## Machine
- **CPU**: ${machine.cpu} (${machine.cores} cores)
- **RAM**: ${machine.ramGb} GB
- **OS**: ${machine.os}
- **Node.js**: ${machine.node}
- **PostgreSQL**: ${machine.postgres}
- **Engine**: ${e.name}, depth ${e.depth}, threads ${e.threads}, hash ${e.hashMb} MB per worker

## Results
${formatTable(results)}
`;
}

export async function runBenchmark(options) {
  await assertNoForeignActiveJobs();
  await cleanup();
  const machine = await getMachineInfo(options.depth);
  const platform = await prisma.platform.findUnique({ where: { name: 'upload' } });
  if (!platform) throw new Error("Platform 'upload' not found; run npm run seed first");

  const games = generateGames(options.games, options.plies);
  const results = [];
  try {
    const user = await prisma.user.create({
      data: { email: BENCH_USER_EMAIL, passwordHash: 'benchmark-user-cannot-log-in' },
    });
    for (const workerCount of options.workers) {
      const result = await runForWorkerCount(workerCount, games, {
        depth: options.depth,
        userId: user.id,
        platformId: platform.id,
      });
      results.push(result);
      console.log(`${workerCount} worker(s): ${result.games} games in ${result.wallSec.toFixed(1)} s`);
    }
  } finally {
    if (!options.keep) await cleanup();
  }

  console.log(`\n${formatTable(results)}\n`);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, formatReport(machine, options, results), 'utf8');
  console.log(`Wrote ${path.relative(ROOT_DIR, REPORT_PATH)}`);
  return { machine, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runBenchmark(parseCliArgs())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
