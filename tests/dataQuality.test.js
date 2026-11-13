import { Chess } from 'chess.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import { seed } from '../prisma/seed/index.js';
import { importService } from '../src/services/import.service.js';
import { saveGameAnalysis, markGameFailed } from '../src/repositories/moveBulk.repo.js';
import { analyzeGame } from '../src/workers/gameAnalyzer.js';
import { registerEngineVersion } from '../src/workers/engineRegistry.js';
import { CHECK_NAMES, runDataQualityChecks } from '../src/workers/dataQuality.js';

const runTag = `dq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ENGINE = { engineName: `${runTag}-engine`, engineVersion: '1.0', depth: 12, threads: 1, hashSize: 64 };

let platformId;
let resultId;
let phaseId;
let classificationId;
let engineVersionId;
let accountSeq = 0;
let gameSeq = 0;
const userIds = [];

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

async function insertGame(accountId, { status = 'analyzed', totalPlies = 1, failureReason = null } = {}) {
  gameSeq += 1;
  const { rows } = await pgPool.query(
    `INSERT INTO games (player_account_id, platform_id, external_id, played_at, color, result_id,
                        total_plies, analysis_status, failure_reason)
     VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'UTC'), 'white', $4, $5, $6, $7)
     RETURNING id`,
    [accountId, platformId, `${runTag}_g${gameSeq}`, resultId, totalPlies, status, failureReason],
  );
  return rows[0].id;
}

async function insertMove(gameId, ply) {
  const { rows } = await pgPool.query(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, mover_color, phase_id)
     VALUES ($1, $2, 'e4', 'e2e4', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
             CASE WHEN $2::int % 2 = 1 THEN 'white' ELSE 'black' END, $3)
     RETURNING id`,
    [gameId, ply, phaseId],
  );
  return rows[0].id;
}

async function insertEval(moveId, { before = 20, after = 15, bestUci = 'e2e4', depth = 12 } = {}) {
  await pgPool.query(
    `INSERT INTO move_evals (move_id, eval_before_cp, eval_after_cp, best_uci, depth, engine_version_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [moveId, before, after, bestUci, depth, engineVersionId],
  );
}

async function insertClassification(moveId) {
  await pgPool.query(
    'INSERT INTO move_classifications (move_id, classification_id, cp_loss) VALUES ($1, $2, 0)',
    [moveId, classificationId],
  );
}

// A fully consistent analyzed move; tests then break exactly one thing next to it.
async function insertAnalyzedMove(gameId, ply, evalFields) {
  const moveId = await insertMove(gameId, ply);
  await insertEval(moveId, evalFields);
  await insertClassification(moveId);
  return moveId;
}

async function insertJob(accountId, status) {
  const { rows } = await pgPool.query(
    'INSERT INTO analysis_jobs (player_account_id, status) VALUES ($1, $2) RETURNING id',
    [accountId, status],
  );
  return rows[0].id;
}

function violation(result, check) {
  return result.violations.find((v) => v.check === check);
}

function checksFailing(result) {
  return result.violations.map((v) => v.check);
}

// The fool's mate: black has mate in one after 2...e5 and after 3.g4, and 4...Qh4# ends the game,
// so plies 2, 3 and 4 each get a move_mates row.
const FOOLS_MATE = ['f3', 'e5', 'g4', 'Qh4#'];

function parsedGame(username, externalId, sans) {
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
    externalId,
    white: username,
    black: 'opponent',
    whiteElo: 1500,
    blackElo: 1500,
    resultRaw: '0-1',
    eco: null,
    openingName: null,
    timeControl: { baseSeconds: 300, incrementSeconds: 0, category: 'blitz' },
    playedAt: new Date('2026-09-01T10:00:00Z'),
    totalPlies: moves.length,
    parseError: null,
    moves,
  };
}

function scriptedEngine() {
  const blackMatesInOne = new Set([2, 3]);
  let call = 0;
  return {
    evaluatePosition: async () => {
      const ply = call;
      call += 1;
      if (blackMatesInOne.has(ply)) return { evalCp: -9990, mate: -1, bestUci: 'd8h4', depth: 12 };
      return { evalCp: 20, mate: null, bestUci: 'e2e4', depth: 12 };
    },
  };
}

beforeAll(async () => {
  await seed();
  platformId = (await prisma.platform.findUnique({ where: { name: 'lichess' } })).id;
  resultId = (await prisma.result.findUnique({ where: { code: 'win' } })).id;
  phaseId = (await prisma.phase.findUnique({ where: { name: 'opening' } })).id;
  classificationId = (await prisma.classification.findUnique({ where: { name: 'best' } })).id;
  engineVersionId = await registerEngineVersion(ENGINE);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.engineVersion.deleteMany({ where: { name: ENGINE.engineName } });
  await closeDb();
});

describe('runDataQualityChecks', () => {
  it('passes for an account stored through the import, analysis and job pipeline', async () => {
    const account = await createAccount();
    await importService.ingestParsedGames(account.id, [
      parsedGame(account.username, `${runTag}_clean_mate`, FOOLS_MATE),
      parsedGame(account.username, `${runTag}_clean_failed`, ['e4', 'e5']),
    ]);
    const games = await prisma.game.findMany({
      where: { playerAccountId: account.id },
      orderBy: { externalId: 'asc' },
      include: { moves: { orderBy: { ply: 'asc' } } },
    });
    const [failed, mated] = games;
    const rows = await analyzeGame({ moves: mated.moves }, scriptedEngine(), { engineVersionId });
    await saveGameAnalysis({ gameId: mated.id, engineVersionId, moves: rows });
    await markGameFailed(failed.id, 'Illegal or unparseable move at ply 2');

    const jobId = await insertJob(account.id, 'running');
    await pgPool.query(
      `INSERT INTO analysis_job_games (job_id, game_id, status, error)
       VALUES ($1, $2, 'done', NULL), ($1, $3, 'failed', 'Illegal or unparseable move at ply 2')`,
      [jobId, mated.id, failed.id],
    );
    await pgPool.query("UPDATE analysis_jobs SET status = 'completed' WHERE id = $1", [jobId]);
    await insertJob(account.id, 'queued');

    const mates = await prisma.moveMate.count({ where: { move: { gameId: mated.id } } });
    expect(mates).toBe(3);

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('runs every check over the whole database when no account is given', async () => {
    const result = await runDataQualityChecks();

    expect(typeof result.ok).toBe('boolean');
    for (const v of result.violations) {
      expect(CHECK_NAMES).toContain(v.check);
      expect(v.count).toBeGreaterThan(0);
      expect(v.sample.length).toBeGreaterThan(0);
    }
  });
});

describe('each check reports a deliberately broken row', () => {
  const cleanups = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()();
  });

  it('analyzed_games_have_all_evals: an analyzed game with a move that has no eval', async () => {
    const account = await createAccount();
    const gameId = await insertGame(account.id, { totalPlies: 2 });
    await insertAnalyzedMove(gameId, 1);
    await insertMove(gameId, 2);

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['analyzed_games_have_all_evals']);
    expect(violation(result, 'analyzed_games_have_all_evals')).toEqual({
      check: 'analyzed_games_have_all_evals',
      count: 1,
      sample: [gameId],
    });
    expect(result.ok).toBe(false);
  });

  it('plies_contiguous: an analyzed game with a gap in its plies', async () => {
    const account = await createAccount();
    const gapped = await insertGame(account.id, { totalPlies: 3 });
    await insertAnalyzedMove(gapped, 1);
    await insertAnalyzedMove(gapped, 3);
    const short = await insertGame(account.id, { totalPlies: 2 });
    await insertAnalyzedMove(short, 1);
    // Pending games with fewer moves than total_plies are left alone.
    const pending = await insertGame(account.id, { status: 'pending', totalPlies: 5 });
    await insertMove(pending, 1);

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['plies_contiguous']);
    expect(violation(result, 'plies_contiguous')).toMatchObject({ count: 2, sample: [gapped, short] });
  });

  it('every_eval_has_classification: an eval row without a classification', async () => {
    const account = await createAccount();
    const gameId = await insertGame(account.id);
    const moveId = await insertMove(gameId, 1);
    await insertEval(moveId);

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['every_eval_has_classification']);
    expect(violation(result, 'every_eval_has_classification')).toMatchObject({ count: 1, sample: [moveId] });
  });

  it('eval_ranges: an eval outside +-10000 and a searched position with depth 0', async () => {
    const account = await createAccount();
    const outOfRange = await insertAnalyzedMove(await insertGame(account.id), 1, { before: -20000 });
    await pgPool.query('INSERT INTO move_mates (move_id, mate_before, mate_after) VALUES ($1, -1, NULL)', [outOfRange]);
    const noDepth = await insertAnalyzedMove(await insertGame(account.id), 1, { depth: 0 });
    await insertAnalyzedMove(await insertGame(account.id), 1, { bestUci: 'none', depth: 0 });

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['eval_ranges']);
    expect(violation(result, 'eval_ranges')).toMatchObject({ count: 2, sample: [outOfRange, noDepth].sort((a, b) => a - b) });
  });

  it('mate_rows_consistent: a mate row with a small eval and a mate-sized eval without a mate row', async () => {
    const account = await createAccount();
    const smallEval = await insertAnalyzedMove(await insertGame(account.id), 1, { before: 50 });
    await pgPool.query('INSERT INTO move_mates (move_id, mate_before, mate_after) VALUES ($1, 3, NULL)', [smallEval]);
    const wrongSide = await insertAnalyzedMove(await insertGame(account.id), 1, { after: 9990 });
    await pgPool.query('INSERT INTO move_mates (move_id, mate_before, mate_after) VALUES ($1, NULL, -1)', [wrongSide]);
    const noRow = await insertAnalyzedMove(await insertGame(account.id), 1, { after: -9990 });

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['mate_rows_consistent']);
    expect(violation(result, 'mate_rows_consistent')).toMatchObject({
      count: 3,
      sample: [smallEval, wrongSide, noRow].sort((a, b) => a - b),
    });
  });

  it('failed_games_have_reason: failed games with a missing or blank reason', async () => {
    const account = await createAccount();
    const missing = await insertGame(account.id, { status: 'failed', totalPlies: 0 });
    const blank = await insertGame(account.id, { status: 'failed', totalPlies: 0, failureReason: '  ' });
    await insertGame(account.id, { status: 'failed', totalPlies: 0, failureReason: 'Invalid FEN after ply 3' });

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['failed_games_have_reason']);
    expect(violation(result, 'failed_games_have_reason')).toMatchObject({ count: 2, sample: [missing, blank] });
  });

  it('no_orphan_progress: a progress row whose job does not exist', async () => {
    const account = await createAccount();
    const gameId = await insertGame(account.id, { status: 'pending', totalPlies: 0 });
    const { rows } = await pgPool.query('SELECT COALESCE(MAX(id), 0) + 1000000 AS id FROM analysis_jobs');
    const missingJobId = rows[0].id;

    // The foreign keys would reject the row; replica mode skips their triggers for this one insert.
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        "INSERT INTO analysis_job_games (job_id, game_id, status) VALUES ($1, $2, 'done')",
        [missingJobId, gameId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    cleanups.push(() => pgPool.query('DELETE FROM analysis_job_games WHERE job_id = $1', [missingJobId]));

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['no_orphan_progress']);
    expect(violation(result, 'no_orphan_progress')).toMatchObject({ count: 1, sample: [missingJobId] });
  });

  it('no_orphan_progress: a completed job with a game still pending or analyzing', async () => {
    const account = await createAccount();
    const pendingGame = await insertGame(account.id, { status: 'pending', totalPlies: 0 });
    const analyzingGame = await insertGame(account.id, { status: 'pending', totalPlies: 0 });
    const jobId = await insertJob(account.id, 'completed');
    await pgPool.query(
      `INSERT INTO analysis_job_games (job_id, game_id, status)
       VALUES ($1, $2, 'pending'), ($1, $3, 'analyzing')`,
      [jobId, pendingGame, analyzingGame],
    );
    // The same statuses on a running job are normal progress.
    const runningJob = await insertJob(account.id, 'running');
    await pgPool.query("INSERT INTO analysis_job_games (job_id, game_id, status) VALUES ($1, $2, 'analyzing')", [
      runningJob,
      pendingGame,
    ]);

    const result = await runDataQualityChecks({ accountId: account.id });

    expect(checksFailing(result)).toEqual(['no_orphan_progress']);
    expect(violation(result, 'no_orphan_progress')).toMatchObject({ count: 2, sample: [jobId, jobId] });
  });

  // Test files run one at a time (vitest.config.js), so dropping an index for the length of one test
  // cannot affect another file. The finally blocks put it back even when an assertion fails.
  it('one_active_job_per_account: a queued and a running job for one account', async () => {
    const account = await createAccount();
    await pgPool.query('DROP INDEX idx_analysis_jobs_active_unique');
    try {
      await insertJob(account.id, 'queued');
      await insertJob(account.id, 'running');
      await insertJob(account.id, 'completed');

      const result = await runDataQualityChecks({ accountId: account.id });

      expect(checksFailing(result)).toEqual(['one_active_job_per_account']);
      expect(violation(result, 'one_active_job_per_account')).toMatchObject({ count: 1, sample: [account.id] });
    } finally {
      await pgPool.query('DELETE FROM analysis_jobs WHERE player_account_id = $1', [account.id]);
      await pgPool.query(
        `CREATE UNIQUE INDEX idx_analysis_jobs_active_unique ON analysis_jobs(player_account_id)
         WHERE status IN ('queued','running')`,
      );
    }
  });

  it('engine_versions_unreferenced_dupes: two identical engine_versions rows', async () => {
    const name = `${runTag}-dupe`;
    await pgPool.query('DROP INDEX engine_versions_name_version_default_depth_threads_hash_siz_key');
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO engine_versions (name, version, default_depth, threads, hash_size)
         VALUES ($1, '1.0', 12, 1, 64), ($1, '1.0', 12, 1, 64), ($1, '1.0', 14, 1, 64)
         RETURNING id`,
        [name],
      );
      const account = await createAccount();

      const result = await runDataQualityChecks({ accountId: account.id });

      expect(checksFailing(result)).toEqual(['engine_versions_unreferenced_dupes']);
      expect(violation(result, 'engine_versions_unreferenced_dupes')).toMatchObject({
        count: 1,
        sample: [Math.min(rows[0].id, rows[1].id)],
      });
    } finally {
      await pgPool.query('DELETE FROM engine_versions WHERE name = $1', [name]);
      await pgPool.query(
        `CREATE UNIQUE INDEX engine_versions_name_version_default_depth_threads_hash_siz_key
         ON engine_versions(name, version, default_depth, threads, hash_size)`,
      );
    }
  });
});
