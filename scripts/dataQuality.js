import { closeDb } from '../src/config/db.js';
import { CHECK_NAMES, runDataQualityChecks } from '../src/workers/dataQuality.js';

function parseArgs(argv) {
  const args = { accountId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--account') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--account needs a positive integer account id');
      }
      args.accountId = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function printTable(violations) {
  const byCheck = new Map(violations.map((v) => [v.check, v]));
  const width = Math.max(...CHECK_NAMES.map((name) => name.length));
  console.log(`${'CHECK'.padEnd(width)}  RESULT  COUNT  SAMPLE`);
  for (const name of CHECK_NAMES) {
    const violation = byCheck.get(name);
    const result = violation ? 'FAIL' : 'PASS';
    const count = String(violation?.count ?? 0);
    const sample = violation ? violation.sample.join(',') : '';
    console.log(`${name.padEnd(width)}  ${result.padEnd(6)}  ${count.padStart(5)}  ${sample}`);
  }
}

async function main() {
  const { accountId } = parseArgs(process.argv.slice(2));
  const { ok, violations } = await runDataQualityChecks({ accountId });
  if (accountId) console.log(`Account ${accountId}`);
  printTable(violations);
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  })
  .finally(closeDb);
