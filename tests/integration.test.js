import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, closeDb } from '../src/config/db.js';
import config from '../src/config/env.js';
import { seed } from '../prisma/seed/index.js';
import { JobRunner } from '../src/workers/jobRunner.js';
import { runDataQualityChecks } from '../src/workers/dataQuality.js';

// Full pipeline over HTTP: register, link an upload account, upload a PGN, let an in-process worker
// analyze it with the real engine, then read games, analytics and a training plan back.
// Set E2E_KEEP_DATA=1 to leave the rows in place, e.g. to run `npm run dq` on them afterwards.

const hasBinary = fs.existsSync(config.stockfishPath);
const keepData = process.env.E2E_KEEP_DATA === '1';
const runTag = `e2e${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const PLAYER = `${runTag}_player`;
const PASSWORD = 'correct-horse-battery';
const PUZZLE_COUNT = 10;
const CLASSIFICATIONS = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];

// Three handcrafted games for PLAYER: a Fool's mate lost as White, a game where White grabs the e5
// pawn with 4. Nxe5?? and walks into the queen fork and a smothered mate, and a quiet 20-ply draw
// played as Black. Clocks are included so the time-pressure buckets have data.
const PGN = `[Event "Casual"]
[Site "Upload"]
[Date "2026.10.01"]
[White "${PLAYER}"]
[Black "Opponent One"]
[Result "0-1"]
[WhiteElo "1500"]
[BlackElo "1520"]
[TimeControl "300+0"]

1. f3 { [%clk 0:04:58] } 1... e5 { [%clk 0:04:57] } 2. g4 { [%clk 0:04:55] } 2... Qh4# { [%clk 0:04:52] } 0-1

[Event "Casual"]
[Site "Upload"]
[Date "2026.10.03"]
[White "${PLAYER}"]
[Black "Opponent Two"]
[Result "0-1"]
[WhiteElo "1510"]
[BlackElo "1490"]
[TimeControl "300+0"]

1. e4 { [%clk 0:04:59] } 1... e5 { [%clk 0:04:58] } 2. Nf3 { [%clk 0:04:40] } 2... Nc6 { [%clk 0:04:50] }
3. Bc4 { [%clk 0:03:10] } 3... Nd4 { [%clk 0:04:41] } 4. Nxe5 { [%clk 0:01:20] } 4... Qg5 { [%clk 0:04:30] }
5. Nxf7 { [%clk 0:00:50] } 5... Qxg2 { [%clk 0:04:21] } 6. Rf1 { [%clk 0:00:25] } 6... Qxe4+ { [%clk 0:04:15] }
7. Be2 { [%clk 0:00:12] } 7... Nf3# { [%clk 0:04:10] } 0-1

[Event "Casual"]
[Site "Upload"]
[Date "2026.10.05"]
[White "Opponent Three"]
[Black "${PLAYER}"]
[Result "1/2-1/2"]
[WhiteElo "1530"]
[BlackElo "1505"]
[TimeControl "600+0"]

1. e4 { [%clk 0:09:58] } 1... e5 { [%clk 0:09:57] } 2. Nf3 { [%clk 0:09:50] } 2... Nc6 { [%clk 0:09:49] }
3. Bc4 { [%clk 0:09:40] } 3... Bc5 { [%clk 0:09:39] } 4. c3 { [%clk 0:09:30] } 4... Nf6 { [%clk 0:09:20] }
5. d3 { [%clk 0:09:10] } 5... d6 { [%clk 0:09:00] } 6. O-O { [%clk 0:08:50] } 6... O-O { [%clk 0:08:40] }
7. Re1 { [%clk 0:08:30] } 7... a6 { [%clk 0:08:20] } 8. Bb3 { [%clk 0:08:10] } 8... Ba7 { [%clk 0:08:00] }
9. h3 { [%clk 0:07:50] } 9... h6 { [%clk 0:07:40] } 10. Nbd2 { [%clk 0:07:30] } 10... Re8 { [%clk 0:07:20] } 1/2-1/2
`;

const engineSuite = hasBinary
  ? 'end-to-end pipeline with the Stockfish binary'
  : `skipped: no Stockfish binary at ${config.stockfishPath}`;

describe.skipIf(!hasBinary)(engineSuite, () => {
  let server;
  let baseUrl;
  let runner;
  const passThrough = (req, res, next) => next();

  const state = {};

  async function api(method, path, { token, body, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function registerAndLogin(email) {
    const registered = await api('POST', '/auth/register', { body: { email, password: PASSWORD } });
    expect(registered.status).toBe(201);
    const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe('string');
    return login.body.token;
  }

  beforeAll(async () => {
    await seed(prisma);
    // The runner claims the oldest eligible job in the table, so leftovers from other files must go.
    await prisma.analysisJob.deleteMany({ where: { status: { in: ['queued', 'running'] } } });

    const app = createApp({ apiRateLimiter: passThrough, authRateLimiter: passThrough });
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await runner?.stop();
    await new Promise((resolve) => server.close(resolve));
    if (!keepData) {
      await prisma.user.deleteMany({ where: { email: { startsWith: runTag } } });
      await prisma.puzzle.deleteMany({ where: { lichessId: { startsWith: runTag } } });
    }
    await closeDb();
  });

  it('registers and logs in', async () => {
    state.token = await registerAndLogin(`${runTag}_a@example.com`);
    const me = await api('GET', '/me', { token: state.token });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(`${runTag}_a@example.com`);
  });

  it('links an upload account', async () => {
    const linked = await api('POST', '/accounts', {
      token: state.token,
      body: { platform: 'upload', username: PLAYER },
    });
    expect(linked.status).toBe(201);
    expect(linked.body.platform.name).toBe('upload');
    state.accountId = linked.body.id;
  });

  it('uploads a PGN with three games and queues one job', async () => {
    const form = new FormData();
    form.append('accountId', String(state.accountId));
    form.append('file', new Blob([PGN], { type: 'application/x-chess-pgn' }), 'games.pgn');
    const uploaded = await api('POST', '/uploads/pgn', { token: state.token, form });
    expect(uploaded.status).toBe(202);
    expect(uploaded.body.insertedCount).toBe(3);
    expect(uploaded.body.skippedCount).toBe(0);
    expect(uploaded.body.job.status).toBe('queued');
    state.jobId = uploaded.body.job.id;
  });

  it('analyzes the job with an in-process worker', async () => {
    runner = new JobRunner(`${runTag}-worker`);
    await runner.start();

    const deadline = Date.now() + 90000;
    let job;
    for (;;) {
      job = await api('GET', `/imports/${state.jobId}`, { token: state.token });
      expect(job.status).toBe(200);
      if (job.body.status === 'completed' || job.body.status === 'failed') break;
      if (Date.now() > deadline) throw new Error(`Job still ${job.body.status} after 90 s`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await runner.stop();
    runner = null;

    expect(job.body).toMatchObject({ status: 'completed', totalGames: 3, failedGames: 0 });
    expect(job.body.error).toBeNull();
  }, 120000);

  it('lists three analyzed games', async () => {
    const games = await api('GET', '/games', { token: state.token });
    expect(games.status).toBe(200);
    expect(games.body.total).toBe(3);
    expect(games.body.items).toHaveLength(3);
    expect(games.body.items.every((g) => g.analysisStatus === 'analyzed')).toBe(true);
    state.games = games.body.items;
  });

  it('shows an eval and a classification for every ply', async () => {
    const plies = {};
    for (const summary of state.games) {
      const detail = await api('GET', `/games/${summary.id}`, { token: state.token });
      expect(detail.status).toBe(200);
      const { moves } = detail.body;
      expect(moves).toHaveLength(detail.body.totalPlies);
      expect(moves.map((m) => m.ply)).toEqual(moves.map((_, i) => i + 1));
      for (const move of moves) {
        expect(move.eval).not.toBeNull();
        expect(Number.isInteger(move.eval.evalBeforeCp)).toBe(true);
        expect(Number.isInteger(move.eval.evalAfterCp)).toBe(true);
        expect(CLASSIFICATIONS).toContain(move.classification);
        expect(move.cpLoss).toBeGreaterThanOrEqual(0);
      }
      plies[detail.body.totalPlies] = detail.body;
    }

    // Fool's mate: 2. g4 allows mate in one, and the final position is resolved without the engine.
    const foolsMate = plies[4];
    expect(foolsMate.result).toBe('loss');
    expect(foolsMate.moves[2].classification).toBe('blunder');
    expect(foolsMate.moves[3].mate.mateAfter).toBe(0);
    expect(foolsMate.moves[3].eval.evalAfterCp).toBe(-10000);

    // 4. Nxe5 walks into Qg5, which forks the knight and g2, and 5. Nxf7?? takes the rook instead of
    // dealing with the threat on g2. How costly 4. Nxe5 is at depth 12 depends on the engine build
    // (Stockfish 19 says mistake or blunder, 17 says good, 16 says inaccuracy), so assert the blunder.
    const trap = plies[14];
    expect(trap.moves[8].san).toBe('Nxf7');
    expect(trap.moves[8].classification).toBe('blunder');

    expect(plies[20].result).toBe('draw');
    expect(plies[20].color).toBe('black');
  });

  it('serves every analytics endpoint from the analyzed games', async () => {
    const openings = await api('GET', '/analytics/openings', { token: state.token });
    expect(openings.status).toBe(200);
    expect(openings.body.length).toBeGreaterThan(0);

    const phases = await api('GET', '/analytics/phases', { token: state.token });
    expect(phases.status).toBe(200);
    expect(phases.body.length).toBeGreaterThan(0);

    const timePressure = await api('GET', '/analytics/time-pressure', { token: state.token });
    expect(timePressure.status).toBe(200);
    expect(timePressure.body.items.length).toBeGreaterThan(0);

    const trend = await api('GET', '/analytics/trend', { token: state.token });
    expect(trend.status).toBe(200);
    expect(trend.body.length).toBeGreaterThan(0);

    const motifs = await api('GET', '/analytics/motifs', { token: state.token });
    expect(motifs.status).toBe(200);
    expect(motifs.body.length).toBeGreaterThan(0);

    const summary = await api('GET', '/analytics/summary', { token: state.token });
    expect(summary.status).toBe(200);
    expect(summary.body.accounts).toHaveLength(1);
    const [own] = summary.body.accounts;
    expect(own.accountId).toBe(state.accountId);
    expect(own.analyzedGames).toBe(3);
    expect(own.blunders).toBeGreaterThan(0);
  });

  it('builds a training plan from seeded puzzles and completes an item', async () => {
    const motifs = await prisma.motif.findMany({ orderBy: { id: 'asc' } });
    const phases = ['opening', 'middlegame', 'endgame'];
    for (let i = 0; i < PUZZLE_COUNT; i += 1) {
      await prisma.puzzle.create({
        data: {
          lichessId: `${runTag}_p${i}`,
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          movesUci: 'e2e4 e7e5 g1f3 b8c6',
          rating: 1450 + i * 10,
          phaseTag: phases[i % phases.length],
          motifs: { create: [{ motifId: motifs[i % motifs.length].id }] },
        },
      });
    }
    expect(await prisma.puzzle.count({ where: { lichessId: { startsWith: runTag } } })).toBe(PUZZLE_COUNT);

    const created = await api('POST', '/training/plans', { token: state.token });
    expect(created.status).toBe(201);
    const { items } = created.body.plan;
    expect(items.length).toBeGreaterThan(0);
    state.planId = created.body.plan.id;
    state.itemId = items[0].id;

    const patched = await api('PATCH', `/training/plans/${state.planId}/items/${state.itemId}`, {
      token: state.token,
      body: { completed: true },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.item.completedAt).not.toBeNull();
  });

  it('hides the game, job and plan item from a second user', async () => {
    const other = await registerAndLogin(`${runTag}_b@example.com`);
    const gameId = state.games[0].id;

    expect((await api('GET', `/games/${gameId}`, { token: other })).status).toBe(404);
    expect((await api('GET', `/imports/${state.jobId}`, { token: other })).status).toBe(404);
    const patch = await api('PATCH', `/training/plans/${state.planId}/items/${state.itemId}`, {
      token: other,
      body: { completed: false },
    });
    expect(patch.status).toBe(404);

    const games = await api('GET', '/games', { token: other });
    expect(games.body.total).toBe(0);
    const plans = await api('GET', '/training/plans', { token: other });
    expect(plans.body).toEqual([]);
  });

  it('passes every data-quality check for the account', async () => {
    const { ok, violations } = await runDataQualityChecks({ accountId: state.accountId });
    expect(violations).toEqual([]);
    expect(ok).toBe(true);
  });
});
