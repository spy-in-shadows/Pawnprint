import fs from 'node:fs';
import { Chess } from 'chess.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { lichessClient } from '../src/ingest/lichessClient.js';
import { importService } from '../src/services/import.service.js';
import { claimNextJob } from '../src/workers/jobQueue.js';
import { registerEngineVersion } from '../src/workers/engineRegistry.js';
import { JobRunner } from '../src/workers/jobRunner.js';
import workerEvents from '../src/workers/events.js';
import { DataError, EngineError } from '../src/utils/errors.js';

const hasBinary = fs.existsSync(config.stockfishPath);
const runTag = `jr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const FAKE_ENGINE_NAME = `${runTag}-fake`;
const OPENINGS = [
  ['e4', 'e5', 'Nf3', 'Nc6'],
  ['d4', 'd5', 'c4', 'e6'],
  ['c4', 'e5', 'Nc3', 'Nf6'],
  ['Nf3', 'd5', 'g3', 'c6'],
  ['e4', 'c5', 'Nf3', 'd6'],
];

let platformId;
let accountSeq = 0;
const userIds = [];

async function createAccount(fields = {}) {
  accountSeq += 1;
  const user = await prisma.user.create({
    data: { email: `${runTag}_${accountSeq}@example.com`, passwordHash: 'x' },
  });
  userIds.push(user.id);
  return prisma.playerAccount.create({
    data: { userId: user.id, platformId, username: `${runTag}_${accountSeq}`, ...fields },
  });
}

function parsedGame(username, index, playedAt) {
  const board = new Chess();
  const moves = OPENINGS[index % OPENINGS.length].map((san, i) => {
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
    playedAt,
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

async function claimJobFor(accountId, fields = {}) {
  const created = await prisma.analysisJob.create({ data: { playerAccountId: accountId, ...fields } });
  const job = await claimNextJob(`${runTag}-claimer`);
  expect(job.id).toBe(created.id);
  return job;
}

async function lastSyncedAt(accountId) {
  const account = await prisma.playerAccount.findUnique({ where: { id: accountId } });
  return account.lastSyncedAt;
}

beforeAll(async () => {
  await seed();
  platformId = (await prisma.platform.findUnique({ where: { name: 'lichess' } })).id;
});

beforeEach(async () => {
  // claimNextJob takes the oldest eligible job in the table, so leftovers from other files must go.
  await prisma.analysisJob.deleteMany({ where: { status: { in: ['queued', 'running'] } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  workerEvents.removeAllListeners();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.engineVersion.deleteMany({ where: { name: FAKE_ENGINE_NAME } });
  await closeDb();
});

describe('registerEngineVersion', () => {
  const engine = {
    engineName: `${runTag}-engine`,
    engineVersion: '1.0',
    depth: 12,
    threads: 1,
    hashSize: 64,
  };

  afterAll(async () => {
    await prisma.engineVersion.deleteMany({ where: { name: engine.engineName } });
  });

  it('returns one row id for concurrent registrations of the same engine', async () => {
    const ids = await Promise.all([registerEngineVersion(engine), registerEngineVersion(engine)]);

    expect(ids[0]).toBe(ids[1]);
    expect(await prisma.engineVersion.count({ where: { name: engine.engineName } })).toBe(1);
  });

  it('reuses the existing row and leaves it unchanged', async () => {
    const before = await prisma.engineVersion.findFirst({ where: { name: engine.engineName } });
    const id = await registerEngineVersion(engine);

    expect(id).toBe(before.id);
    expect(await prisma.engineVersion.findUnique({ where: { id } })).toEqual(before);
  });

  it('creates a separate row when any of the five settings differ', async () => {
    const base = await registerEngineVersion(engine);
    const deeper = await registerEngineVersion({ ...engine, depth: 14 });

    expect(deeper).not.toBe(base);
    expect(await prisma.engineVersion.count({ where: { name: engine.engineName } })).toBe(2);
  });
});

describe.skipIf(!hasBinary)('JobRunner with the engine', () => {
  let runner;

  beforeAll(async () => {
    runner = new JobRunner(`${runTag}-runner`);
    runner.engineRetryDelayMs = 0;
    await runner.engine.init();
  });

  afterAll(async () => {
    await runner?.engine.quit();
  });

  it('claims a queued lichess job, ingests, analyzes, finishes and moves the cursor to the newest game', async () => {
    const account = await createAccount();
    const playedAts = [new Date('2026-03-01T10:00:00Z'), new Date('2026-03-05T10:00:00Z'), new Date('2026-03-03T10:00:00Z')];
    mockFetch(playedAts.map((at, i) => parsedGame(account.username, i, at)));
    const job = await prisma.analysisJob.create({ data: { playerAccountId: account.id } });

    const looper = new JobRunner(`${runTag}-looper`);
    const finished = new Promise((resolve) => workerEvents.on('job:finished', resolve));
    await looper.start();
    const event = await finished;
    await looper.stop();

    expect(event).toMatchObject({ jobId: job.id, insertedGames: 3, analyzedGames: 3 });
    const stored = await prisma.analysisJob.findUnique({ where: { id: job.id }, include: { jobGames: true } });
    expect(stored.status).toBe('completed');
    expect(stored.jobGames.map((g) => g.status)).toEqual(['done', 'done', 'done']);
    const games = await prisma.game.findMany({ where: { playerAccountId: account.id } });
    expect(games.every((g) => g.analysisStatus === 'analyzed')).toBe(true);
    expect(await lastSyncedAt(account.id)).toEqual(new Date('2026-03-05T10:00:00Z'));
  });

  it('passes job.since to the platform client instead of lastSyncedAt', async () => {
    const account = await createAccount({ lastSyncedAt: new Date('2026-01-01T00:00:00Z') });
    const since = new Date('2025-06-01T00:00:00Z');
    const until = new Date('2025-07-01T00:00:00Z');
    const fetchSpy = mockFetch([]);
    const job = await claimJobFor(account.id, { since, until, maxGames: 7 });

    await runner.processJob(job);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(account.username);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ max: 7, since, until });
  });

  it('falls back to lastSyncedAt when the job has no since', async () => {
    const cursor = new Date('2026-01-01T00:00:00Z');
    const account = await createAccount({ lastSyncedAt: cursor });
    const fetchSpy = mockFetch([]);
    const job = await claimJobFor(account.id);

    await runner.processJob(job);

    expect(fetchSpy.mock.calls[0][1].since).toEqual(cursor);
  });

  it('never moves the cursor backwards when a job imports an older range', async () => {
    const cursor = new Date('2026-09-01T00:00:00Z');
    const account = await createAccount({ lastSyncedAt: cursor });
    mockFetch([parsedGame(account.username, 0, new Date('2025-02-01T00:00:00Z'))]);
    const job = await claimJobFor(account.id, { since: new Date('2025-01-01T00:00:00Z') });

    await runner.processJob(job);

    expect((await prisma.analysisJob.findUnique({ where: { id: job.id } })).status).toBe('completed');
    expect(await lastSyncedAt(account.id)).toEqual(cursor);
  });

  it('leaves lastSyncedAt untouched and clears the heartbeat when the job fails', async () => {
    const cursor = new Date('2026-01-01T00:00:00Z');
    const account = await createAccount({ lastSyncedAt: cursor });
    mockFetch([parsedGame(account.username, 0, new Date('2026-02-01T00:00:00Z'))]);
    vi.spyOn(runner.engine, 'evaluatePosition').mockRejectedValue(new EngineError('engine gone'));
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const failed = vi.fn();
    workerEvents.on('job:failed', failed);
    const job = await claimJobFor(account.id);

    await runner.processJob(job);

    expect((await prisma.analysisJob.findUnique({ where: { id: job.id } })).status).toBe('failed');
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.id, error: 'engine gone' }));
    expect(await lastSyncedAt(account.id)).toEqual(cursor);
    expect(runner.heartbeatTimer).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('analyzes every game left without analysis by a failed job', async () => {
    const account = await createAccount();
    const games = [1, 2, 3, 4, 5].map((day, i) => parsedGame(account.username, i, new Date(`2026-04-0${day}T12:00:00Z`)));
    mockFetch(games);
    // Every attempt fails; a single failure would now be absorbed by the engine retry.
    const evaluate = vi.spyOn(runner.engine, 'evaluatePosition').mockRejectedValue(new EngineError('crash'));
    const first = await claimJobFor(account.id);
    await runner.processJob(first);

    expect((await prisma.analysisJob.findUnique({ where: { id: first.id } })).status).toBe('failed');
    expect(await prisma.game.count({ where: { playerAccountId: account.id, analysisStatus: 'pending' } })).toBe(5);
    expect(await lastSyncedAt(account.id)).toBeNull();

    evaluate.mockRestore();
    const retry = await claimJobFor(account.id);
    await runner.processJob(retry);

    const stored = await prisma.analysisJob.findUnique({ where: { id: retry.id }, include: { jobGames: true } });
    expect(stored.status).toBe('completed');
    expect(stored.jobGames).toHaveLength(5);
    expect(await prisma.game.count({ where: { playerAccountId: account.id, analysisStatus: 'analyzed' } })).toBe(5);
    expect(await lastSyncedAt(account.id)).toEqual(new Date('2026-04-05T12:00:00Z'));
  });

  it('processes games in played_at descending order', async () => {
    const account = await createAccount();
    const days = [3, 1, 5, 2, 4];
    mockFetch(days.map((day, i) => parsedGame(account.username, i, new Date(`2026-05-0${day}T08:00:00Z`))));
    const order = [];
    workerEvents.on('game:done', ({ gameId }) => order.push(gameId));
    const job = await claimJobFor(account.id);

    await runner.processJob(job);

    const games = await prisma.game.findMany({ where: { id: { in: order } } });
    const playedAt = new Map(games.map((g) => [g.id, g.playedAt.getTime()]));
    const times = order.map((id) => playedAt.get(id));
    expect(order).toHaveLength(5);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('beats once at the start and clears its heartbeat timer after the job', async () => {
    const account = await createAccount();
    mockFetch([parsedGame(account.username, 0, new Date('2026-06-01T00:00:00Z'))]);
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const job = await claimJobFor(account.id);
    await pgPool.query('UPDATE analysis_jobs SET heartbeat_at = NULL WHERE id = $1', [job.id]);

    await runner.processJob(job);

    const intervals = setSpy.mock.calls.filter(([, ms]) => ms === 25000);
    expect(intervals).toHaveLength(1);
    const handle = setSpy.mock.results[setSpy.mock.calls.indexOf(intervals[0])].value;
    expect(clearSpy).toHaveBeenCalledWith(handle);
    expect(runner.heartbeatTimer).toBeNull();
    const stored = await prisma.analysisJob.findUnique({ where: { id: job.id } });
    expect(stored.status).toBe('completed');
    expect(stored.heartbeatAt).not.toBeNull();
  });
});

const FAKE_EVAL = { evalCp: 20, mate: null, bestUci: 'e2e4', depth: 12 };

function fakeEngine(evaluate = async () => FAKE_EVAL) {
  return {
    engineName: FAKE_ENGINE_NAME,
    engineVersion: '1.0',
    depth: 12,
    threads: 1,
    hashSize: 64,
    hasCrashedTooManyTimes: false,
    init: vi.fn(async () => {}),
    newGame: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    evaluatePosition: vi.fn(evaluate),
  };
}

// A fresh runner per test keeps the start-position cache from hiding engine calls.
function runnerWith(engine) {
  const runner = new JobRunner(`${runTag}-partition`);
  runner.engine = engine;
  runner.engineRetryDelayMs = 0;
  return runner;
}

// Stores the games up front so a test can corrupt them before the job runs; the job's own fetch returns nothing new.
async function storeGames(account, days) {
  const games = days.map((day, i) => parsedGame(account.username, i, new Date(`2026-07-${String(day).padStart(2, '0')}T09:00:00Z`)));
  await importService.ingestParsedGames(account.id, games);
  const stored = await prisma.game.findMany({ where: { playerAccountId: account.id }, orderBy: { playedAt: 'desc' } });
  return stored.map((g) => g.id);
}

async function makeIllegal(gameId, ply) {
  await prisma.move.updateMany({ where: { gameId, ply }, data: { san: 'Ke8', uci: 'e1e8' } });
}

async function evalRowCount(gameId) {
  const { rows } = await pgPool.query(
    'SELECT COUNT(*)::int AS n FROM move_evals me JOIN moves m ON m.id = me.move_id WHERE m.game_id = $1',
    [gameId],
  );
  return rows[0].n;
}

async function storedJob(jobId) {
  return prisma.analysisJob.findUnique({ where: { id: jobId }, include: { jobGames: true } });
}

function pgnGame(id, { variant } = {}) {
  const tags = [
    `[Event "Rated blitz game"]`,
    `[Site "https://lichess.org/${id}"]`,
    `[White "${runTag}"]`,
    `[Black "opponent"]`,
    `[Result "1/2-1/2"]`,
    `[UTCDate "2026.08.01"]`,
    `[UTCTime "10:00:00"]`,
    `[TimeControl "300+0"]`,
  ];
  if (variant) tags.push(`[Variant "${variant}"]`);
  return `${tags.join('\n')}\n\n1. e4 e5 2. Nf3 Nc6 1/2-1/2\n\n`;
}

describe('JobRunner error partitioning', () => {
  it('fails only the game with an illegal move and completes the job with failedGames 1', async () => {
    const account = await createAccount();
    const [newest, middle, oldest] = await storeGames(account, [1, 2, 3]);
    await makeIllegal(middle, 3);
    mockFetch([]);
    const engine = fakeEngine();
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(stored.failedGames).toBe(1);
    const byGame = new Map(stored.jobGames.map((g) => [g.gameId, g]));
    expect(byGame.get(newest).status).toBe('done');
    expect(byGame.get(oldest).status).toBe('done');
    expect(byGame.get(middle).status).toBe('failed');
    expect(byGame.get(middle).error).toMatch(/Illegal or unparseable move 'Ke8'/);
    const failedGame = await prisma.game.findUnique({ where: { id: middle } });
    expect(failedGame.analysisStatus).toBe('failed');
    expect(failedGame.failureReason).toBe(byGame.get(middle).error);
    // A data error never restarts the engine, so the game was attempted exactly once.
    expect(engine.init).not.toHaveBeenCalled();
    expect(engine.newGame).not.toHaveBeenCalled();
  });

  it('does not re-select a failed game or let it take a maxGames slot in the next job', async () => {
    const account = await createAccount();
    const [newest, second] = await storeGames(account, [5, 4, 3]);
    await makeIllegal(newest, 2);
    mockFetch([]);
    const runner = runnerWith(fakeEngine());

    const first = await claimJobFor(account.id, { maxGames: 1 });
    await runner.processJob(first);
    expect((await storedJob(first.id)).failedGames).toBe(1);

    const next = await claimJobFor(account.id, { maxGames: 1 });
    await runner.processJob(next);

    const stored = await storedJob(next.id);
    expect(stored.status).toBe('completed');
    expect(stored.failedGames).toBe(0);
    expect(stored.jobGames.map((g) => [g.gameId, g.status])).toEqual([[second, 'done']]);
    expect(await importService.getPendingGameIds(account.id, 10)).not.toContain(newest);
  });

  it('writes no move_evals rows for a game that hits a data error halfway through', async () => {
    const account = await createAccount();
    const [newest, older] = await storeGames(account, [2, 1]);
    mockFetch([]);
    let calls = 0;
    // Calls 1-3 cover the start position and plies 1-2 of the newest game; call 4 fails on ply 3.
    const engine = fakeEngine(async () => {
      calls += 1;
      if (calls === 4) throw new DataError('Corrupt position at ply 3');
      return FAKE_EVAL;
    });
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    expect(calls).toBeGreaterThan(4);
    expect((await prisma.game.findUnique({ where: { id: newest } })).analysisStatus).toBe('failed');
    expect(await evalRowCount(newest)).toBe(0);
    expect(await evalRowCount(older)).toBe(4);
    expect((await storedJob(job.id)).status).toBe('completed');
  });

  it('retries an engine error 3 times with a restart in between, then fails the job', async () => {
    const account = await createAccount();
    const [gameId] = await storeGames(account, [1]);
    mockFetch([]);
    const engine = fakeEngine(async () => {
      throw new EngineError('Stockfish search timed out after 10000 ms');
    });
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    expect(engine.evaluatePosition).toHaveBeenCalledTimes(3);
    expect(engine.init).toHaveBeenCalledTimes(2);
    expect(engine.newGame).toHaveBeenCalledTimes(2);
    const stored = await storedJob(job.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('Stockfish search timed out after 10000 ms');
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    expect(game.analysisStatus).toBe('pending');
    expect(await evalRowCount(gameId)).toBe(0);
  });

  it('stops retrying once the engine has crashed too many times', async () => {
    const account = await createAccount();
    await storeGames(account, [1]);
    mockFetch([]);
    const engine = fakeEngine(async () => {
      throw new EngineError('Stockfish exited unexpectedly');
    });
    engine.hasCrashedTooManyTimes = true;
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    expect(engine.evaluatePosition).toHaveBeenCalledTimes(1);
    expect(engine.init).not.toHaveBeenCalled();
    expect((await storedJob(job.id)).status).toBe('failed');
  });

  it('completes the game when the engine fails on the first attempt and succeeds on the second', async () => {
    const account = await createAccount();
    const [gameId] = await storeGames(account, [1]);
    mockFetch([]);
    const engine = fakeEngine();
    engine.evaluatePosition.mockRejectedValueOnce(new EngineError('Stockfish exited unexpectedly'));
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.newGame).toHaveBeenCalledTimes(1);
    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(stored.failedGames).toBe(0);
    expect(stored.jobGames).toEqual([expect.objectContaining({ gameId, status: 'done' })]);
    expect((await prisma.game.findUnique({ where: { id: gameId } })).analysisStatus).toBe('analyzed');
    expect(await evalRowCount(gameId)).toBe(4);
  });

  it('treats unflagged errors as engine errors only when they mention Stockfish', async () => {
    const account = await createAccount();
    const [newest, older] = await storeGames(account, [2, 1]);
    mockFetch([]);
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error('write EPIPE to Stockfish stdin');
      if (calls === 2) throw new TypeError('position is undefined');
      return FAKE_EVAL;
    });
    const job = await claimJobFor(account.id);

    await runnerWith(engine).processJob(job);

    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(engine.init).toHaveBeenCalledTimes(1);
    const byGame = new Map(stored.jobGames.map((g) => [g.gameId, g]));
    expect(byGame.get(newest)).toMatchObject({ status: 'failed', error: 'position is undefined' });
    expect(byGame.get(older).status).toBe('done');
    expect((await prisma.game.findUnique({ where: { id: newest } })).failureReason).toBe('position is undefined');
  });

  it('saves skippedGames from the client stats on the job', async () => {
    const account = await createAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(pgnGame(`${runTag}s1`) + pgnGame(`${runTag}v1`, { variant: 'Atomic' }) + pgnGame(`${runTag}v2`, { variant: 'Crazyhouse' })),
    );
    const job = await claimJobFor(account.id);

    await runnerWith(fakeEngine()).processJob(job);

    const stored = await storedJob(job.id);
    expect(stored.status).toBe('completed');
    expect(stored.skippedGames).toBe(2);
    expect(stored.jobGames).toHaveLength(1);
  });

  it('reports separate skipped counts for two consecutive jobs on the shared client', async () => {
    const account = await createAccount();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(pgnGame(`${runTag}a1`, { variant: 'Atomic' }) + pgnGame(`${runTag}a2`, { variant: 'Horde' })))
      .mockResolvedValueOnce(new Response(pgnGame(`${runTag}b1`, { variant: 'Antichess' })));
    const runner = runnerWith(fakeEngine());

    const first = await claimJobFor(account.id);
    await runner.processJob(first);
    const second = await claimJobFor(account.id);
    await runner.processJob(second);

    expect((await storedJob(first.id)).skippedGames).toBe(2);
    expect((await storedJob(second.id)).skippedGames).toBe(1);
  });

  it('completes the job and logs a warning when the data-quality checks find a violation', async () => {
    const account = await createAccount();
    const [gameId] = await storeGames(account, [9]);
    await prisma.game.update({ where: { id: gameId }, data: { analysisStatus: 'failed', failureReason: null } });
    mockFetch([]);
    const runner = runnerWith(fakeEngine());
    const warn = vi.spyOn(runner.log, 'warn');
    const job = await claimJobFor(account.id);

    await runner.processJob(job);

    expect((await storedJob(job.id)).status).toBe('completed');
    expect(warn).toHaveBeenCalledWith('Data-quality checks found violations', {
      jobId: job.id,
      accountId: account.id,
      violations: [{ check: 'failed_games_have_reason', count: 1, sample: [gameId] }],
    });
  });

  it('fails the job when the platform client fails', async () => {
    const account = await createAccount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }));
    const job = await claimJobFor(account.id);

    await runnerWith(fakeEngine()).processJob(job);

    const stored = await storedJob(job.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('Lichess API returned status 500');
  });
});
