import fs from 'node:fs';
import { Chess } from 'chess.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { lichessClient } from '../src/ingest/lichessClient.js';
import { claimNextJob } from '../src/workers/jobQueue.js';
import { registerEngineVersion } from '../src/workers/engineRegistry.js';
import { JobRunner } from '../src/workers/jobRunner.js';
import workerEvents from '../src/workers/events.js';
import { EngineError } from '../src/utils/errors.js';

const hasBinary = fs.existsSync(config.stockfishPath);
const runTag = `jr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const evaluate = vi.spyOn(runner.engine, 'evaluatePosition').mockRejectedValueOnce(new EngineError('crash'));
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
