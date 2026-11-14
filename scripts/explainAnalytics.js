import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma, pgPool, closeDb } from '../src/config/db.js';
import { BENCH_USERNAME } from './benchmarkInsert.js';
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

export const QUERIES = [
  {
    name: '1_opening_blunder_rate',
    sql: OPENINGS_SQL,
    getParams: ({ userId, accountId }) => [userId, accountId, null, null],
  },
  {
    name: '2_phase_accuracy',
    sql: PHASES_SQL,
    getParams: ({ userId, accountId }) => [userId, accountId, null, null],
  },
  {
    name: '3_time_pressure',
    sql: TIME_PRESSURE_BUCKETS_SQL,
    getParams: ({ userId, accountId }) => [userId, accountId, null, null],
  },
  {
    name: '4_performance_trend',
    sql: TREND_SQL,
    getParams: ({ userId, accountId }) => [userId, accountId, null, null],
  },
  {
    name: '5_motif_weaknesses',
    sql: MOTIFS_SQL,
    getParams: ({ userId, accountId }) => [userId, accountId, null, null],
  },
  {
    name: '6_weakest_opening_phases',
    sql: WEAKEST_OPENING_PHASES_SQL,
    getParams: ({ userId }) => [userId, 20, 2],
  },
];

export async function runExplains(targetDirName = 'before') {
  const account = await prisma.playerAccount.findFirst({
    where: { username: BENCH_USERNAME },
    select: { id: true, userId: true },
  });

  if (!account) {
    throw new Error(`Benchmark account '${BENCH_USERNAME}' not found. Run benchmarkInsert.js first.`);
  }

  const outDir = path.join(ROOT_DIR, 'docs', 'explain', targetDirName);
  await fs.mkdir(outDir, { recursive: true });

  const summary = [];

  for (const q of QUERIES) {
    const params = q.getParams({ userId: account.userId, accountId: account.id });
    const explainQuery = `EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`;
    const result = await pgPool.query(explainQuery, params);
    const planText = result.rows.map((r) => r['QUERY PLAN']).join('\n');

    const execTimeMatch = planText.match(/Execution Time: ([\d.]+) ms/);
    const executionTimeMs = execTimeMatch ? parseFloat(execTimeMatch[1]) : null;

    const fileContent = `${planText}\n\nSummary: Execution Time = ${executionTimeMs} ms\n`;
    const filePath = path.join(outDir, `${q.name}.txt`);
    await fs.writeFile(filePath, fileContent, 'utf8');

    summary.push({
      name: q.name,
      executionTimeMs,
      file: filePath,
    });
  }

  return summary;
}

async function main() {
  const targetDir = process.argv[2] || 'before';
  console.log(`Running EXPLAIN (ANALYZE, BUFFERS) for target: ${targetDir}`);
  const summary = await runExplains(targetDir);
  console.log('\n--- EXPLAIN Summary ---');
  for (const item of summary) {
    console.log(`${item.name}: ${item.executionTimeMs} ms -> ${item.file}`);
  }
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
