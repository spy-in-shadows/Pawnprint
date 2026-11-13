import { Readable } from 'stream';
import { parsePgnStream } from '../chess/pgnParser.js';
import { isStandardChess } from './standardChess.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toEpochMs(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') {
    return val < 1e11 ? val * 1000 : val;
  }
  const parsed = new Date(val);
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Official Lichess API docs (https://lichess.org/api#tag/Games/operation/apiGamesUser):
 * Endpoint: GET https://lichess.org/api/games/user/{username}
 * Query params:
 *   - max (integer): limit number of games returned
 *   - since (integer): timestamp in milliseconds
 *   - until (integer): timestamp in milliseconds
 *   - clocks (boolean): include clock comments in PGN
 *   - opening (boolean): include opening name and ECO tags
 *   - evals (boolean): include analysis evals from Lichess
 * Header: Accept: application/x-chess-pgn
 *
 * Architecture note:
 * We request clocks=true and opening=true. We intentionally omit evals=true
 * because the system strictly computes all move evaluations using local Stockfish.
 */
async function fetchLichessStream(username, { max, since, until, delayMs = 200 }, maxRetries = 3) {
  const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(username)}`);
  url.searchParams.set('clocks', 'true');
  url.searchParams.set('opening', 'true');

  if (max) {
    url.searchParams.set('max', String(max));
  }
  const sinceMs = toEpochMs(since);
  if (sinceMs !== null) {
    url.searchParams.set('since', String(sinceMs));
  }
  const untilMs = toEpochMs(until);
  if (untilMs !== null) {
    url.searchParams.set('until', String(untilMs));
  }

  const headers = {
    Accept: 'application/x-chess-pgn',
    'User-Agent': 'Pawnprint-Analytics/1.0 (contact: support@pawnprint.local)',
  };

  let response = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    response = await fetch(url.toString(), { headers });

    if (response.status === 429) {
      const retryAfterHeader = response.headers?.get?.('retry-after') || response.headers?.['retry-after'];
      const waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 60 : 60;
      if (attempt < maxRetries) {
        const backoffWaitMs = waitSec * 1000 * (2 ** attempt);
        await sleep(backoffWaitMs);
        continue;
      }
      throw new Error(`Lichess rate limit exceeded (429). Retry after ${waitSec}s.`);
    }

    break;
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Lichess user '${username}' not found`);
    }
    throw new Error(`Lichess API returned status ${response.status}`);
  }

  return response;
}

/**
 * Converts a fetch response body into a Node.js Readable stream.
 */
function toNodeReadable(response) {
  if (response.body && typeof Readable.fromWeb === 'function' && typeof response.body.getReader === 'function') {
    return Readable.fromWeb(response.body);
  }
  if (response.body && typeof response.body.pipe === 'function') {
    return response.body;
  }
  return null;
}

/**
 * Fetches user games from Lichess as an async generator of ParsedGame.
 * Filters out non-standard chess variants and custom FEN starting positions.
 *
 * @param {string} username
 * @param {object} options
 * @param {number} [options.max]
 * @param {Date|number|string} [options.since]
 * @param {Date|number|string} [options.until]
 * @param {number} [options.delayMs=200]
 * @param {object} [options.stats]
 * @returns {AsyncGenerator<object>}
 */
export function fetchUserGames(username, { max, since, until, delayMs = 200, stats = {} } = {}) {
  if (stats && typeof stats === 'object') {
    stats.skippedGames = 0;
  }

  return (async function* () {
    if (stats && typeof stats === 'object') {
      stats.skippedGames = 0;
    }

    const response = await fetchLichessStream(username, { max, since, until, delayMs });

    let nodeStream = toNodeReadable(response);
    if (!nodeStream) {
      const text = typeof response.text === 'function' ? await response.text() : '';
      nodeStream = Readable.from([text]);
    }

    let count = 0;
    for await (const game of parsePgnStream(nodeStream)) {
      if (!isStandardChess(game)) {
        if (stats && typeof stats === 'object') {
          stats.skippedGames = (stats.skippedGames || 0) + 1;
        }
        continue;
      }

      yield game;
      count++;
      if (max && count >= max) {
        break;
      }
    }
  })();
}

export const lichessClient = {
  fetchUserGames,
  isStandardChess,
};

export { isStandardChess };
export default lichessClient;
