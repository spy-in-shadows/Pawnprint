import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Chess } from 'chess.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { lichessClient } from '../src/ingest/lichessClient.js';
import { importService } from '../src/services/import.service.js';
import { claimNextJob } from '../src/workers/jobQueue.js';
import { JobRunner } from '../src/workers/jobRunner.js';
import workerEvents from '../src/workers/events.js';
import { EngineError } from '../src/utils/errors.js';

// Failure modes covered here, one test each:
//   worker death    - a runner dies mid-job; another runner reclaims it after the stale threshold
//   engine death    - the Stockfish child is killed mid-game; the game is retried on a respawned engine
//   bad data        - a job whose games always break the engine fails and does not block the queue
//   double delivery - the same job is processed twice without duplicating any rows
//   shutdown        - stop() during a job leaves no engine process and no timers behind

const hasBinary = fs.existsSync(config.stockfishPath);
const runTag = `cr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const FAKE_ENGINE_NAME = `${runTag}-fake`;
const STALE_SECONDS = 2;

const LINES = [
  ['e4', 'e5', 'Nf3', 'Nc6'],
  ['d4', 'd5', 'c4', 'e6'],
  ['c4', 'e5', 'Nc3', 'Nf6'],
  ['Nf3', 'd5', 'g3', 'c6'],
  ['e4', 'c5', 'Nf3', 'd6'],
  ['d4', 'Nf6', 'c4', 'g6'],
];
const LONG_LINE = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];

let platformId;
let accountSeq = 0;
const userIds = [];
let savedStaleSeconds;

async function createAccount() {
  accountSeq += 1;
  const user = await prisma.user.create({
    data: { email: `${runTag}_${accountSeq}@example.com`, passwordHash: 'x' },
  });
  userIds.push(user.id);
  return prisma.playerAccount.create({
    data: { userId: user.id, platformId, username: `${runTag}_${accountSeq}` },
  });
}

function parsedGame(username, index, sans) {
  const board = new Chess();
  const moves = sans.map((san, i) => {
    const fenBefore = board.fen();
    const moverColor = board.turn() === 'w' ? 'white' : 'black';
    const played = board.move(san);
    return {
      ply: i + 1,
      san: played.san,
      uci: played.from + played.to + (played.promotion ?? ''),
      fenBefore,
      moverColor,
      phase: 'opening',
      clockRemainingMs: null,
      timeSpentMs: null,
    };
  });
  return {
    externalId: `${username}_g${index}`,
    white: username,
    black: 'opponent',
    whiteElo: 1500,
    blackElo: 1500,
    resultRaw: '1/2-1/2',
    eco: null,
    openingName: null,
    timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
    playedAt: new Date(Date.UTC(2026, 9, 1 + index, 12)),
    totalPlies: moves.length,
    parseError: null,
    moves,
  };
}

function mockFetch(games) {
  return vi.spyOn(lichessClient, 'fetchUserGames').mockImplementation(async function* fakeFetch() {
    yield* games;
  });
}

async function storeGames(account, lines) {
  const games = lines.map((sans, i) => parsedGame(account.username, i, sans));
  await importService.ingestParsedGames(account.id, games);
  return games;
}

async function countRows(accountId) {
  const { rows } = await pgPool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM games WHERE player_account_id = $1) AS games,
       (SELECT COUNT(*)::int FROM moves m JOIN games g ON g.id = m.game_id
         WHERE g.player_account_id = $1) AS moves,
       (SELECT COUNT(*)::int FROM move_evals me JOIN moves m ON m.id = me.move_id
         JOIN games g ON g.id = m.game_id WHERE g.player_account_id = $1) AS move_evals,
       (SELECT COUNT(*)::int FROM move_classifications mc JOIN moves m ON m.id = mc.move_id
         JOIN games g ON g.id = m.game_id WHERE g.player_account_id = $1) AS move_classifications`,
    [accountId],
  );
  return rows[0];
}

async function analysisByPly(gameId) {
  const { rows } = await pgPool.query(
    `SELECT m.ply, me.eval_before_cp, me.eval_after_cp, mc.cp_loss, c.name AS classification
     FROM moves m
     JOIN move_evals me ON me.move_id = m.id
     JOIN move_classifications mc ON mc.move_id = m.id
     JOIN classifications c ON c.id = mc.classification_id
     WHERE m.game_id = $1
     ORDER BY m.ply`,
    [gameId],
  );
  return rows;
}

async function storedJob(jobId) {
  return prisma.analysisJob.findUnique({ where: { id: jobId }, include: { jobGames: true } });
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function jobFinished(jobId) {
  return new Promise((resolve) => {
    const onFinished = (event) => {
      if (event.jobId !== jobId) return;
      workerEvents.off('job:finished', onFinished);
      resolve(event);
    };
    workerEvents.on('job:finished', onFinished);
  });
}

function pidIsListed(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' }).trim() !== '';
  } catch {
    // ps exits non-zero when no process has that pid.
    return false;
  }
}

beforeAll(async () => {
  await seed();
  platformId = (await prisma.platform.findUnique({ where: { name: 'lichess' } })).id;
  savedStaleSeconds = config.jobStaleSeconds;
  config.jobStaleSeconds = STALE_SECONDS;
});

beforeEach(async () => {
  // Runner loops claim the oldest eligible job in the table, so leftovers from other files must go.
  await prisma.analysisJob.deleteMany({ where: { status: { in: ['queued', 'running'] } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  workerEvents.removeAllListeners();
});

afterAll(async () => {
  config.jobStaleSeconds = savedStaleSeconds;
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.engineVersion.deleteMany({ where: { name: FAKE_ENGINE_NAME } });
  await closeDb();
});

const engineSuite = hasBinary ? 'with the Stockfish binary' : `skipped: no Stockfish binary at ${config.stockfishPath}`;

describe.skipIf(!hasBinary)(engineSuite, () => {
  const runners = [];

  function newRunner(name) {
    const runner = new JobRunner(`${runTag}-${name}`);
    runner.engineRetryDelayMs = 0;
    runners.push(runner);
    return runner;
  }

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.engine.quit()));
  });

  // Worker death. A real crash gives the runner no chance to run its catch or finally blocks, so
  // the hook cannot simply throw: processJob would catch the error and mark the job failed, which
  // is not what a dead process does. Instead the hook stops the heartbeat, as the dying process
  // would, and parks the loop on a promise that never settles, so markJobFinished never runs.
  it('reclaims a job from a dead worker and analyzes only the games it left unanalyzed', async () => {
    const account = await createAccount();
    const games = await storeGames(account, LINES);
    const totalPlies = games.reduce((sum, g) => sum + g.moves.length, 0);
    mockFetch([]);
    const job = await prisma.analysisJob.create({ data: { playerAccountId: account.id } });

    const doneByA = [];
    const runnerA = newRunner('a');
    workerEvents.on('game:done', ({ gameId }) => doneByA.push(gameId));
    const realEvaluate = runnerA.engine.evaluatePosition.bind(runnerA.engine);
    let killed = false;
    vi.spyOn(runnerA.engine, 'evaluatePosition').mockImplementation((fen) => {
      if (doneByA.length < 2) return realEvaluate(fen);
      if (!killed) {
        killed = true;
        runnerA._clearHeartbeat();
      }
      return new Promise(() => {});
    });
    await runnerA.start();
    await waitFor(() => killed);
    await runnerA.engine.quit();
    workerEvents.removeAllListeners('game:done');

    const afterA = await countRows(account.id);
    expect(doneByA).toHaveLength(2);
    expect((await storedJob(job.id)).status).toBe('running');
    const evalsOfA = await Promise.all(doneByA.map(analysisByPly));

    const doneByB = [];
    workerEvents.on('game:done', ({ gameId }) => doneByB.push(gameId));
    const finished = jobFinished(job.id);
    const runnerB = newRunner('b');
    await runnerB.start();
    // B polls from the start, but the job stays A's until its heartbeat is older than the threshold.
    const event = await finished;
    await runnerB.stop();

    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(stored.attempts).toBe(2);
    expect(stored.lockedBy).toBe(runnerB.workerId);
    expect(stored.jobGames).toHaveLength(6);
    expect(stored.jobGames.every((g) => g.status === 'done')).toBe(true);
    expect(event.analyzedGames).toBe(4);
    expect(doneByB).toHaveLength(4);
    expect(doneByB.some((id) => doneByA.includes(id))).toBe(false);
    expect(await Promise.all(doneByA.map(analysisByPly))).toEqual(evalsOfA);

    const after = await countRows(account.id);
    expect(after.move_evals).toBeGreaterThan(afterA.move_evals);
    expect(after).toEqual({ games: 6, moves: totalPlies, move_evals: totalPlies, move_classifications: totalPlies });
    expect(await prisma.game.count({ where: { playerAccountId: account.id, analysisStatus: 'analyzed' } })).toBe(6);
  }, 60000);

  // Engine death. Stockfish is SIGKILLed right after the third position of the game resolves; the
  // next search fails, the client respawns, and the runner retries the whole game on the new process.
  it('retries a game on a respawned engine after the engine is killed mid-game', async () => {
    const baseline = await createAccount();
    const victim = await createAccount();
    await storeGames(baseline, [LONG_LINE]);
    await storeGames(victim, [LONG_LINE]);
    mockFetch([]);

    const cleanJob = await prisma.analysisJob.create({ data: { playerAccountId: baseline.id } });
    const clean = await claimNextJob(`${runTag}-clean`);
    expect(clean.id).toBe(cleanJob.id);
    const cleanRunner = newRunner('clean');
    await cleanRunner.engine.init();
    await cleanRunner.processJob(clean);
    expect((await storedJob(clean.id)).status).toBe('completed');

    const runner = newRunner('killed');
    await runner.engine.init();
    const realEvaluate = runner.engine.evaluatePosition.bind(runner.engine);
    let calls = 0;
    let killedPid = null;
    vi.spyOn(runner.engine, 'evaluatePosition').mockImplementation(async (fen) => {
      const result = await realEvaluate(fen);
      calls += 1;
      if (calls === 3) {
        killedPid = runner.engine.process.pid;
        process.kill(killedPid, 'SIGKILL');
      }
      return result;
    });
    const victimJob = await prisma.analysisJob.create({ data: { playerAccountId: victim.id } });
    const job = await claimNextJob(`${runTag}-killed`);
    expect(job.id).toBe(victimJob.id);

    await runner.processJob(job);

    expect(killedPid).not.toBeNull();
    expect(pidIsListed(killedPid)).toBe(false);
    expect(runner.engine.crashCount).toBe(1);
    expect(runner.engine.process.pid).not.toBe(killedPid);
    expect((await storedJob(job.id)).status).toBe('completed');

    const [baseGame] = await prisma.game.findMany({ where: { playerAccountId: baseline.id } });
    const [retriedGame] = await prisma.game.findMany({ where: { playerAccountId: victim.id } });
    expect(retriedGame.analysisStatus).toBe('analyzed');
    const expected = await analysisByPly(baseGame.id);
    const actual = await analysisByPly(retriedGame.id);
    expect(actual).toHaveLength(LONG_LINE.length);
    // Fixed-depth single-thread search is only repeatable for an identical search history. The retry
    // runs on a fresh process after ucinewgame and reuses the cached start-position eval, so its hash
    // table differs from the uninterrupted run and evals drift by a few centipawns (we observed up to
    // ~12 cp at depth 12). The classification is what the analytics consume, so that must match.
    expect(actual.map((r) => [r.ply, r.classification])).toEqual(expected.map((r) => [r.ply, r.classification]));
    actual.forEach((row, i) => {
      expect(Math.abs(row.eval_after_cp - expected[i].eval_after_cp)).toBeLessThanOrEqual(30);
    });
  }, 60000);

  // Double delivery. The queue can hand the same job out again (a reclaim racing a slow finish, or
  // a manual retry); the second pass must find nothing left to insert.
  it('does not duplicate rows when the same job is processed twice', async () => {
    const account = await createAccount();
    const games = LINES.slice(0, 3).map((sans, i) => parsedGame(account.username, i, sans));
    const totalPlies = games.reduce((sum, g) => sum + g.moves.length, 0);
    mockFetch(games);
    await prisma.analysisJob.create({ data: { playerAccountId: account.id } });
    const job = await claimNextJob(`${runTag}-twice`);
    const runner = newRunner('twice');
    await runner.engine.init();

    await runner.processJob(job);
    const first = await countRows(account.id);
    await runner.processJob(job);
    const second = await countRows(account.id);

    expect(first).toEqual({ games: 3, moves: totalPlies, move_evals: totalPlies, move_classifications: totalPlies });
    expect(second).toEqual(first);
    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(stored.jobGames).toHaveLength(3);
  }, 60000);

  // Shutdown. stop() arrives while a search is in flight; the engine must be gone, every timer the
  // runner or the client started must be cleared, and the job is left running for a later reclaim.
  it('stop() during a job leaves no Stockfish child and no running timers', async () => {
    const account = await createAccount();
    await storeGames(account, [LONG_LINE]);
    mockFetch([]);
    const job = await prisma.analysisJob.create({ data: { playerAccountId: account.id } });

    const timers = new Map();
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    const realClearTimeout = globalThis.clearTimeout;
    const realClearInterval = globalThis.clearInterval;
    const ownStack = () => /src\/(workers|chess)\//.test(new Error().stack);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      const tracked = ownStack();
      const handle = realSetTimeout(() => {
        timers.delete(handle);
        fn(...args);
      }, ms);
      if (tracked) timers.set(handle, 'timeout');
      return handle;
    });
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...args) => {
      const handle = realSetInterval(fn, ms, ...args);
      if (ownStack()) timers.set(handle, 'interval');
      return handle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      timers.delete(handle);
      realClearTimeout(handle);
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((handle) => {
      timers.delete(handle);
      realClearInterval(handle);
    });

    const runner = newRunner('stop');
    const inFlight = new Promise((resolve) => {
      const realEvaluate = runner.engine.evaluatePosition.bind(runner.engine);
      vi.spyOn(runner.engine, 'evaluatePosition').mockImplementation((fen) => {
        const pending = realEvaluate(fen);
        resolve();
        return pending;
      });
    });
    await runner.start();
    await inFlight;
    const pid = runner.engine.process.pid;
    expect(pidIsListed(pid)).toBe(true);
    expect([...timers.values()]).toContain('interval');

    await runner.stop();

    expect(pidIsListed(pid)).toBe(false);
    expect(runner.engine.process).toBeNull();
    expect(runner.heartbeatTimer).toBeNull();
    expect(timers.size).toBe(0);
    const stored = await storedJob(job.id);
    expect(stored.status).toBe('running');
    expect(stored.finishedAt).toBeNull();
    expect((await countRows(account.id)).move_evals).toBe(0);
  }, 60000);
});

// Bad data. Every position of the poison game breaks the engine, so each attempt raises an
// EngineError; after three attempts the job fails with that error and the loop moves on.
describe('poison job', () => {
  it('fails after 3 engine attempts and the next queued job still completes', async () => {
    const poison = await createAccount();
    const healthy = await createAccount();
    const [poisonGame] = await storeGames(poison, [LINES[0]]);
    await storeGames(healthy, [LINES[1]]);
    mockFetch([]);

    const board = new Chess();
    const poisonFens = new Set(poisonGame.moves.map((m) => board.move(m.san) && board.fen()));
    const evaluate = vi.fn(async (fen) => {
      if (poisonFens.has(fen)) throw new EngineError('Stockfish exited unexpectedly (code null, signal SIGSEGV)');
      return { evalCp: 20, mate: null, bestUci: 'e2e4', depth: 12 };
    });
    const engine = {
      engineName: FAKE_ENGINE_NAME,
      engineVersion: '1.0',
      depth: 12,
      threads: 1,
      hashSize: 64,
      hasCrashedTooManyTimes: false,
      init: vi.fn(async () => {}),
      newGame: vi.fn(async () => {}),
      quit: vi.fn(async () => {}),
      evaluatePosition: evaluate,
    };

    // Created in this order, so the poison job is claimed first.
    const poisonJob = await prisma.analysisJob.create({ data: { playerAccountId: poison.id } });
    const healthyJob = await prisma.analysisJob.create({ data: { playerAccountId: healthy.id } });
    const failed = vi.fn();
    workerEvents.on('job:failed', failed);
    const finished = jobFinished(healthyJob.id);

    const runner = new JobRunner(`${runTag}-poison`);
    runner.engine = engine;
    runner.engineRetryDelayMs = 0;
    await runner.start();
    await finished;
    await runner.stop();

    const poisoned = await storedJob(poisonJob.id);
    expect(poisoned.status).toBe('failed');
    expect(poisoned.error).toMatch(/Stockfish exited unexpectedly/);
    expect(poisoned.finishedAt).not.toBeNull();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ jobId: poisonJob.id }));
    const poisonCalls = evaluate.mock.calls.filter(([fen]) => poisonFens.has(fen));
    expect(poisonCalls).toHaveLength(3);
    expect(engine.init).toHaveBeenCalledTimes(3);
    expect(engine.newGame).toHaveBeenCalledTimes(2);
    expect((await prisma.game.findFirst({ where: { playerAccountId: poison.id } })).analysisStatus).toBe('pending');
    expect((await countRows(poison.id)).move_evals).toBe(0);

    const done = await storedJob(healthyJob.id);
    expect(done.status).toBe('completed');
    expect(done.jobGames.map((g) => g.status)).toEqual(['done']);
    expect((await countRows(healthy.id)).move_evals).toBe(LINES[1].length);
  });
});
