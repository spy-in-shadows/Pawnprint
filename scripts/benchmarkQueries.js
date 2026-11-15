import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import { getMachineInfo } from './benchmarkInsert.js';
import { refreshAccountSummary } from '../src/services/summary.service.js';
import { saveGameAnalysis } from '../src/repositories/moveBulk.repo.js';
import { registerEngineVersion } from '../src/workers/engineRegistry.js';
import { evaluateMoveQuality } from '../src/chess/evalMath.js';
import {
  OPENINGS_SQL,
  PHASES_SQL,
  TIME_PRESSURE_BUCKETS_SQL,
  TREND_SQL,
  MOTIFS_SQL,
  WEAKEST_OPENING_PHASES_SQL,
} from '../src/repositories/analytics.repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 20;
const SYNTHETIC_SEED = 20261115;
const SYNTHETIC_MOTIFS = ['hanging_piece', 'fork', 'pin', 'skewer', 'back_rank', 'discovered_attack'];
// Labels the rows written by --synthetic-analysis so they can never be mistaken for engine output.
const SYNTHETIC_ENGINE = { engineName: 'synthetic-benchmark', engineVersion: '1', depth: 1, threads: 1, hashSize: 1 };

const formatCount = (n) => n.toLocaleString('en-US');

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    accountId: null,
    out: null,
    syntheticAnalysis: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account' && i + 1 < argv.length) {
      args.accountId = parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--out' && i + 1 < argv.length) {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === '--synthetic-analysis') {
      args.syntheticAnalysis = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node scripts/benchmarkQueries.js [options]

Options:
  --account <id>  Target player account ID (defaults to detecting benchmark account)
  --out <path>    Custom output markdown path (defaults to docs/benchmarks/queries.md)
  --synthetic-analysis
                  First store deterministic analysis rows (evals, classifications, motifs)
                  for the account's pending games, so the analytics queries have data.
                  The rows are tied to an engine_versions row named 'synthetic-benchmark'.
  --help, -h      Show this help message

To generate the required 10k-game dataset:
  node scripts/benchmarkInsert.js --games 10000 --strategy unnest --keep
  node scripts/benchmarkQueries.js --synthetic-analysis
`);
      process.exit(0);
    }
  }

  return args;
}

export async function detectBenchmarkAccount(specifiedAccountId = null) {
  if (specifiedAccountId) {
    const acc = await prisma.playerAccount.findUnique({
      where: { id: specifiedAccountId },
      select: { id: true, userId: true, username: true },
    });
    if (!acc) throw new Error(`Specified account ID ${specifiedAccountId} not found.`);
    return acc;
  }

  const byUsername = await prisma.playerAccount.findFirst({
    where: { username: 'bench_insert_player' },
    select: { id: true, userId: true, username: true },
  });
  if (byUsername) return byUsername;

  const candidate = await prisma.playerAccount.findFirst({
    where: {
      games: {
        some: {
          analysisStatus: 'analyzed',
        },
      },
    },
    select: { id: true, userId: true, username: true },
    orderBy: { id: 'desc' },
  });

  if (candidate) return candidate;

  throw new Error(
    'No benchmark dataset found. Please generate the dataset first using:\n' +
    '  node scripts/benchmarkInsert.js --games 10000 --strategy unnest --keep'
  );
}

export async function measureQuery(clientOrPool, queryText, params) {
  // Warm-up
  for (let i = 0; i < WARMUP_RUNS; i += 1) {
    await clientOrPool.query(queryText, params);
  }

  // Measured
  const times = [];
  for (let i = 0; i < MEASURED_RUNS; i += 1) {
    const t0 = performance.now();
    await clientOrPool.query(queryText, params);
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  const median = percentile(times, 50);
  const p95 = percentile(times, 95);

  return { median, p95, samples: times };
}

// Deterministic PRNG (mulberry32) so every run produces the same dataset.
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds saveGameAnalysis rows for one game: a random walk of White-perspective evals, classified
// with the real evalMath rules, and one motif tag on every mistake or blunder.
export function buildSyntheticRows(moves, rng) {
  let before = 20;
  let motifIndex = 0;
  return moves.map((move) => {
    const swing = Math.round((rng() - 0.5) * 120 + (rng() < 0.06 ? (rng() - 0.5) * 900 : 0));
    const after = Math.max(-2000, Math.min(2000, before + swing));
    const { cpLoss, classification } = evaluateMoveQuality({
      evalBeforeCp: before,
      evalAfterCp: after,
      moverColor: move.mover_color,
    });
    const motifs = [];
    if (classification === 'mistake' || classification === 'blunder') {
      motifs.push({
        name: SYNTHETIC_MOTIFS[motifIndex % SYNTHETIC_MOTIFS.length],
        kind: motifIndex % 2 === 0 ? 'allowed' : 'missed',
      });
      motifIndex += 1;
    }
    const row = {
      ply: move.ply,
      evalBeforeCp: before,
      evalAfterCp: after,
      bestUci: move.uci,
      depth: SYNTHETIC_ENGINE.depth,
      mateBefore: null,
      mateAfter: null,
      cpLoss,
      classification,
      motifs,
    };
    before = after;
    return row;
  });
}

export async function addSyntheticAnalysis(account) {
  const engineVersionId = await registerEngineVersion(SYNTHETIC_ENGINE);
  const { rows: games } = await pgPool.query(
    `SELECT id FROM games WHERE player_account_id = $1 AND analysis_status = 'pending' ORDER BY id`,
    [account.id],
  );
  const rng = createRng(SYNTHETIC_SEED);
  for (const { id } of games) {
    const { rows: moves } = await pgPool.query(
      'SELECT ply, uci, mover_color FROM moves WHERE game_id = $1 ORDER BY ply',
      [id],
    );
    await saveGameAnalysis({ gameId: id, engineVersionId, moves: buildSyntheticRows(moves, rng) });
  }
  console.log(`Stored synthetic analysis for ${formatCount(games.length)} games.`);
}

function describeResults(results, refreshDurationMs) {
  const queryResults = results.filter((r) => !r.name.startsWith('7.'));
  const speedups = queryResults.map((r) => r.without.median / r.with.median);
  const low = Math.min(...speedups).toFixed(2);
  const high = Math.max(...speedups).toFixed(2);
  const summary = results.find((r) => r.name.startsWith('7.'));
  const summarySpeedup = summary ? (summary.without.median / summary.with.median).toFixed(1) : 'n/a';
  const indexLine = Math.max(...speedups) < 1.2
    ? `made no measurable difference on this dataset (p50 ratio ${low}x to ${high}x); the planner still prefers sequential scans at this size.`
    : `changed p50 latency by ${low}x to ${high}x across the analytics queries.`;
  return `1. **Targeted indexes**: \`idx_player_accounts_user_id\` and \`idx_move_motifs_motif_id\` ${indexLine}
2. **Summary tables**: reading \`account_summary\` and \`account_phase_summary\` is ${summarySpeedup}x faster at p50 than the equivalent aggregate over the base tables.
3. **Rollup cost**: \`refreshAccountSummary\` took ${refreshDurationMs.toFixed(0)} ms for this account; the worker pays it once at the end of each completed job.`;
}

export function formatQueryBenchmarkMarkdown({ machine, account, dataSize, results, refreshDurationMs }) {
  const headers = [
    'Query / Workload',
    'Without C6 Indexes (p50 / p95)',
    'With C6 Indexes (p50 / p95)',
    'Speedup (p50)',
  ];

  const rows = results.map((r) => [
    r.name,
    `${r.without.median.toFixed(2)} ms / ${r.without.p95.toFixed(2)} ms`,
    `${r.with.median.toFixed(2)} ms / ${r.with.p95.toFixed(2)} ms`,
    `${(r.without.median / r.with.median).toFixed(2)}x`,
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );

  const formatRow = (cols) =>
    `| ${cols.map((c, i) => (i === 0 ? c.padEnd(colWidths[i]) : c.padStart(colWidths[i]))).join(' | ')} |`;

  const separator = `| ${colWidths
    .map((w, i) => (i === 0 ? `:${'-'.repeat(Math.max(1, w - 1))}` : `${'-'.repeat(Math.max(1, w - 1))}:`))
    .join(' | ')} |`;

  const tableLines = [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');

  return `# Analytics Query and Summary Rollup Benchmark

## Environment
- **CPU**: ${machine.cpu}
- **RAM**: ${machine.ram}
- **Node.js**: ${machine.node}
- **PostgreSQL**: ${machine.postgres}
- **OS**: ${machine.os}

## Dataset
Produced by \`node scripts/benchmarkInsert.js --games 10000 --strategy unnest --keep\` followed by \`node scripts/benchmarkQueries.js --synthetic-analysis\`: evaluations, classifications and motif tags are synthetic (seeded, classified with \`src/chess/evalMath.js\`), not engine output.

- **Account**: \`${account.username}\` (ID: ${account.id}, User ID: ${account.userId})
- **Games**: ${formatCount(dataSize.games)} games (${formatCount(dataSize.analyzedGames)} analyzed)
- **Moves**: ${formatCount(dataSize.moves)} plies (${formatCount(dataSize.analyzedMoves)} owner plies in analyzed games)
- **Move Motifs**: ${formatCount(dataSize.motifs)} tags

## Benchmark Results (Warmup: ${WARMUP_RUNS}, Measured: ${MEASURED_RUNS} runs)

${tableLines}

Row 7 compares the equivalent aggregate over the base tables (left column) with the summary-table read (right column).

### Account Summary Rollup Refresh
- **\`refreshAccountSummary\` Execution Time**: ${refreshDurationMs.toFixed(2)} ms
- **Scope**: Atomic transactional recomputation and upsert of \`account_summary\` and \`account_phase_summary\` across all ${formatCount(dataSize.analyzedGames)} analyzed games.

## Analysis and Findings
${describeResults(results, refreshDurationMs)}
`;
}

export async function runQueryBenchmark(cliOptions = {}) {
  const options = {
    ...parseCliArgs([]),
    ...cliOptions,
  };

  const account = await detectBenchmarkAccount(options.accountId);
  const machine = await getMachineInfo();
  if (options.syntheticAnalysis) await addSyntheticAnalysis(account);

  // Gather dataset size metrics
  const gamesCount = await prisma.game.count({ where: { playerAccountId: account.id } });
  const analyzedGamesCount = await prisma.game.count({
    where: { playerAccountId: account.id, analysisStatus: 'analyzed' },
  });
  const movesCount = await prisma.move.count({
    where: { game: { playerAccountId: account.id } },
  });
  const analyzedMovesRes = await pgPool.query(
    `SELECT COUNT(m.id)::int AS count
     FROM moves m
     JOIN games g ON m.game_id = g.id
     WHERE g.player_account_id = $1
       AND g.analysis_status = 'analyzed'
       AND m.mover_color = g.color`,
    [account.id]
  );
  const motifsCount = await prisma.moveMotif.count({
    where: { move: { game: { playerAccountId: account.id } } },
  });

  const dataSize = {
    games: gamesCount,
    analyzedGames: analyzedGamesCount,
    moves: movesCount,
    analyzedMoves: analyzedMovesRes.rows[0]?.count ?? 0,
    motifs: motifsCount,
  };
  // The analytics queries only read analyzed games; timing them over none measures nothing.
  if (dataSize.analyzedGames === 0) {
    throw new Error(
      `Account ${account.id} has no analyzed games. Run again with --synthetic-analysis, or analyze its games with a worker first.`,
    );
  }

  console.log(`\n--- Running Analytics Query Benchmark on Account ${account.id} (${account.username}) ---`);
  console.log(`Dataset: ${dataSize.games} games, ${dataSize.moves} moves, ${dataSize.motifs} motifs`);

  // Ensure summary is populated first
  const tRefreshStart = performance.now();
  await refreshAccountSummary(account.id);
  const refreshDurationMs = performance.now() - tRefreshStart;

  const queries = [
    {
      name: '1. Opening Blunder Rate',
      sql: OPENINGS_SQL,
      params: [account.userId, account.id, null, null],
    },
    {
      name: '2. Phase Accuracy',
      sql: PHASES_SQL,
      params: [account.userId, account.id, null, null],
    },
    {
      name: '3. Time Pressure Buckets',
      sql: TIME_PRESSURE_BUCKETS_SQL,
      params: [account.userId, account.id, null, null],
    },
    {
      name: '4. Performance Trend (Rolling 7d)',
      sql: TREND_SQL,
      params: [account.userId, account.id, null, null],
    },
    {
      name: '5. Motif Weakness Frequency',
      sql: MOTIFS_SQL,
      params: [account.userId, account.id, null, null],
    },
    {
      name: '6. Weakest Opening Phases',
      sql: WEAKEST_OPENING_PHASES_SQL,
      params: [account.userId, 20, 2],
    },
    {
      name: '7. Summary Read (Rollup Table vs Base Aggregation)',
      summarySql: `
        SELECT
          s.*,
          COALESCE(
            (SELECT json_agg(p.*) FROM account_phase_summary p WHERE p.player_account_id = s.player_account_id),
            '[]'::json
          ) AS phases
        FROM account_summary s
        WHERE s.player_account_id = $1;
      `,
      summaryParams: [account.id],
      baseSql: `
        WITH full_agg AS (
          SELECT
            COUNT(DISTINCT g.id)::int AS "analyzedGames",
            COUNT(m.id)::int AS "totalMoves",
            COUNT(CASE WHEN c.name = 'inaccuracy' THEN 1 END)::int AS inaccuracies,
            COUNT(CASE WHEN c.name = 'mistake' THEN 1 END)::int AS mistakes,
            COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
            COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0) AS "avgCpLoss",
            COALESCE(
              ROUND(
                (COUNT(CASE WHEN c.name IN ('best', 'good') THEN 1 END)::numeric / NULLIF(COUNT(m.id), 0)::numeric) * 100,
                1
              )::float,
              0.0
            ) AS "accuracyPct",
            MAX(g.played_at) AS "lastGameAt"
          FROM games g
          LEFT JOIN moves m ON m.game_id = g.id AND m.mover_color = g.color
          LEFT JOIN move_classifications mc ON mc.move_id = m.id
          LEFT JOIN classifications c ON c.id = mc.classification_id
          WHERE g.player_account_id = $1 AND g.analysis_status = 'analyzed'
        ),
        phase_agg AS (
          SELECT
            p.name AS phase,
            COUNT(m.id)::int AS moves,
            COUNT(CASE WHEN c.name = 'blunder' THEN 1 END)::int AS blunders,
            COALESCE(ROUND(AVG(mc.cp_loss)::numeric, 1)::float, 0.0) AS "avgCpLoss"
          FROM phases p
          LEFT JOIN (
            moves m
            JOIN games g ON m.game_id = g.id AND g.player_account_id = $1 AND g.analysis_status = 'analyzed' AND m.mover_color = g.color
            LEFT JOIN move_classifications mc ON mc.move_id = m.id
            LEFT JOIN classifications c ON c.id = mc.classification_id
          ) ON m.phase_id = p.id
          GROUP BY p.name, p.id
          ORDER BY p.id ASC
        )
        SELECT * FROM full_agg, LATERAL (SELECT json_agg(phase_agg.*) AS phases FROM phase_agg) p;
      `,
      baseParams: [account.id],
    },
  ];

  // Record initial indexes to verify restoration
  const initialIdxRes = await pgPool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname;`
  );
  const initialIndexes = initialIdxRes.rows.map((r) => r.indexname);

  const results = [];

  try {
    // 1. Measure Variant 2: WITH Indexes
    console.log('\nMeasuring Variant 2: WITH targeted C6 indexes...');
    const withMetrics = [];
    for (const q of queries) {
      if (q.summarySql) {
        // For summary workload: measure summary table read
        const m = await measureQuery(pgPool, q.summarySql, q.summaryParams);
        withMetrics.push(m);
      } else {
        const m = await measureQuery(pgPool, q.sql, q.params);
        withMetrics.push(m);
      }
    }

    // 2. Measure Variant 1: WITHOUT C6 Indexes
    console.log('Measuring Variant 1: WITHOUT targeted C6 indexes (temporarily dropped)...');
    await pgPool.query('DROP INDEX IF EXISTS idx_player_accounts_user_id;');
    await pgPool.query('DROP INDEX IF EXISTS idx_move_motifs_motif_id;');

    const withoutMetrics = [];
    for (const q of queries) {
      if (q.baseSql) {
        // For summary comparison: measure equivalent base-table full aggregation
        const m = await measureQuery(pgPool, q.baseSql, q.baseParams);
        withoutMetrics.push(m);
      } else {
        const m = await measureQuery(pgPool, q.sql, q.params);
        withoutMetrics.push(m);
      }
    }

    // Combine results
    for (let i = 0; i < queries.length; i += 1) {
      results.push({
        name: queries[i].name,
        without: withoutMetrics[i],
        with: withMetrics[i],
      });
    }
  } finally {
    // 3. Restore C6 targeted indexes
    await pgPool.query(
      `CREATE INDEX IF NOT EXISTS "idx_player_accounts_user_id" ON "player_accounts"("user_id");`
    );
    await pgPool.query(
      `CREATE INDEX IF NOT EXISTS "idx_move_motifs_motif_id" ON "move_motifs"("motif_id");`
    );

    // Verify index restoration
    const restoredIdxRes = await pgPool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname;`
    );
    const restoredIndexes = restoredIdxRes.rows.map((r) => r.indexname);
    const missing = initialIndexes.filter((idx) => !restoredIndexes.includes(idx));
    if (missing.length > 0) {
      console.error('Warning: some indexes were not restored properly:', missing);
    } else {
      console.log('All indexes successfully restored to initial state.');
    }
  }

  const markdownReport = formatQueryBenchmarkMarkdown({
    machine,
    account,
    dataSize,
    results,
    refreshDurationMs,
  });

  console.log('\n' + markdownReport);

  const targetOut = options.out || path.join(ROOT_DIR, 'docs', 'benchmarks', 'queries.md');
  await fs.mkdir(path.dirname(targetOut), { recursive: true });
  await fs.writeFile(targetOut, markdownReport, 'utf8');
  console.log(`Report written to ${targetOut}`);

  return { results, refreshDurationMs, markdownReport, dataSize };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  await runQueryBenchmark(args);
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
