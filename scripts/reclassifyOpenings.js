// Links already-imported Lichess games that have no opening to the seeded openings table.
// Games do not store the ECO header, so it is read again from the Lichess export-by-ids
// endpoint (headers only). Chess.com and uploaded games are counted and left unchanged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgPool, closeDb } from '../src/config/db.js';

const EXPORT_URL = 'https://lichess.org/api/games/export/_ids?moves=false&clocks=false&evals=false&opening=true';
const BATCH_SIZE = 300; // Lichess accepts up to 300 ids per request.

/**
 * Reads a multi-game PGN export and returns a Map of game id -> ECO code.
 * The id comes from the GameId header, or from the last path segment of Site.
 */
export function ecoByGameId(pgnText) {
  const result = new Map();
  for (const block of pgnText.split(/\n\s*\n(?=\[)/)) {
    const header = (name) => block.match(new RegExp(`^\\[${name} "([^"]*)"\\]`, 'm'))?.[1] ?? null;
    const id = header('GameId') ?? header('Site')?.split('/').pop() ?? null;
    const eco = header('ECO');
    if (id && eco && eco !== '?') result.set(id, eco);
  }
  return result;
}

async function fetchEcoCodes(ids) {
  const response = await fetch(EXPORT_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/x-chess-pgn',
      'Content-Type': 'text/plain',
      'User-Agent': 'Pawnprint-Analytics/1.0 (contact: support@pawnprint.local)',
    },
    body: ids.join(','),
  });
  if (!response.ok) {
    throw new Error(`Lichess export returned status ${response.status}`);
  }
  return ecoByGameId(await response.text());
}

async function main() {
  const { rows } = await pgPool.query(
    `SELECT g.id, g.external_id, p.name AS platform
       FROM games g JOIN platforms p ON p.id = g.platform_id
      WHERE g.opening_id IS NULL`
  );
  const lichess = rows.filter((r) => r.platform === 'lichess');
  console.log(`Games without an opening: ${rows.length} (Lichess: ${lichess.length})`);

  let updated = 0;
  for (let i = 0; i < lichess.length; i += BATCH_SIZE) {
    const batch = lichess.slice(i, i + BATCH_SIZE);
    const ecoById = await fetchEcoCodes(batch.map((g) => g.external_id));
    for (const game of batch) {
      const eco = ecoById.get(game.external_id);
      if (!eco) continue;
      const res = await pgPool.query(
        `UPDATE games
            SET opening_id = (SELECT id FROM openings WHERE eco = $1 ORDER BY id LIMIT 1)
          WHERE id = $2 AND opening_id IS NULL
            AND EXISTS (SELECT 1 FROM openings WHERE eco = $1)`,
        [eco, game.id]
      );
      updated += res.rowCount;
    }
  }
  console.log(`Games linked to an opening: ${updated}`);
  console.log(`Still without an opening: ${rows.length - updated}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main()
    .catch((err) => {
      console.error('Reclassification failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
