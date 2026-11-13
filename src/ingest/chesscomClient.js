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
 * Extracts year and month from an archive URL (.../games/YYYY/MM) and returns
 * the month's UTC start and end timestamps in milliseconds.
 */
function getArchiveMonthRange(archiveUrl) {
  if (typeof archiveUrl !== 'string') return null;
  const match = archiveUrl.match(/\/(\d{4})\/(\d{1,2})(?:\/pgn)?\/?$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return null;
  }
  const startMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, month, 1, 0, 0, 0, 0) - 1;
  return { startMs, endMs };
}

/**
 * Official Chess.com Published Data API docs (https://www.chess.com/news/view/published-data-api):
 * Archive endpoint: GET https://api.chess.com/pub/player/{username}/games/archives
 *   Returns JSON with an array of archive URLs sorted chronologically:
 *   { archives: ["https://api.chess.com/pub/player/{username}/games/2023/01", ...] }
 *
 * Monthly PGN endpoint: GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}/pgn
 *   Returns multi-game PGN string for that month.
 *
 * Architecture note:
 * We fetch archives newest to oldest by reversing the archives list. We fetch
 * {archive}/pgn to stream PGN games directly into parsePgnStream, filtering games
 * by since/until dates and skipping non-standard variants.
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let response = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfterHeader = response.headers?.get?.('retry-after') || response.headers?.['retry-after'];
      const waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 60 : 60;
      if (attempt < maxRetries) {
        const backoffWaitMs = waitSec * 1000 * (2 ** attempt);
        await sleep(backoffWaitMs);
        continue;
      }
      throw new Error(`Chess.com rate limit exceeded (429). Retry after ${waitSec}s.`);
    }

    break;
  }

  return response;
}

/**
 * Fetches the list of monthly archives for a Chess.com player.
 */
async function fetchPlayerArchives(username) {
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Pawnprint-Analytics/1.0 (contact: support@pawnprint.local)',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Chess.com user '${username}' not found`);
    }
    throw new Error(`Chess.com API returned status ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data.archives) ? data.archives : [];
}

/**
 * Parses an archive response into a stream of ParsedGame instances.
 */
async function* streamArchiveGames(response) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const games = Array.isArray(data.games) ? data.games : [];
    for (const item of games) {
      if (item && item.pgn) {
        for await (const g of parsePgnStream(Readable.from([item.pgn]))) {
          if (item.url && (!g.externalId || g.externalId.startsWith('pgn_'))) {
            g.externalId = item.url;
          }
          yield g;
        }
      }
    }
    return;
  }

  let nodeStream = null;
  if (response.body && typeof Readable.fromWeb === 'function' && typeof response.body.getReader === 'function') {
    nodeStream = Readable.fromWeb(response.body);
  } else if (response.body && typeof response.body.pipe === 'function') {
    nodeStream = response.body;
  } else {
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (text.trim().startsWith('{')) {
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data.games)) {
          for (const item of data.games) {
            if (item && item.pgn) {
              for await (const g of parsePgnStream(Readable.from([item.pgn]))) {
                if (item.url && (!g.externalId || g.externalId.startsWith('pgn_'))) {
                  g.externalId = item.url;
                }
                yield g;
              }
            }
          }
          return;
        }
      } catch {}
    }
    nodeStream = Readable.from([text]);
  }

  for await (const game of parsePgnStream(nodeStream)) {
    yield game;
  }
}

/**
 * Fetches user games from Chess.com as an async generator of ParsedGame.
 * Traverses archives newest to oldest, stopping once max games are yielded.
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

    const archives = await fetchPlayerArchives(username);
    const reversedArchives = [...archives].reverse();

    const sinceMs = toEpochMs(since);
    const untilMs = toEpochMs(until);

    let count = 0;

    for (const archiveUrl of reversedArchives) {
      if (max && count >= max) break;

      const monthRange = getArchiveMonthRange(archiveUrl);
      if (monthRange) {
        if (untilMs !== null && monthRange.startMs > untilMs) {
          continue;
        }
        if (sinceMs !== null && monthRange.endMs < sinceMs) {
          break;
        }
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      const pgnUrl = archiveUrl.endsWith('/pgn') ? archiveUrl : `${archiveUrl}/pgn`;
      const response = await fetchWithRetry(pgnUrl, {
        headers: {
          Accept: 'application/x-chess-pgn, application/json',
          'User-Agent': 'Pawnprint-Analytics/1.0 (contact: support@pawnprint.local)',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          continue;
        }
        throw new Error(`Chess.com archive ${pgnUrl} returned status ${response.status}`);
      }

      const monthGames = [];
      for await (const game of streamArchiveGames(response)) {
        monthGames.push(game);
      }

      monthGames.sort((a, b) => {
        const timeA = a.playedAt instanceof Date && !Number.isNaN(a.playedAt.getTime()) ? a.playedAt.getTime() : null;
        const timeB = b.playedAt instanceof Date && !Number.isNaN(b.playedAt.getTime()) ? b.playedAt.getTime() : null;

        if (timeA === null && timeB === null) return 0;
        if (timeA === null) return 1;
        if (timeB === null) return -1;
        return timeB - timeA;
      });

      for (const game of monthGames) {
        const gameTime = game.playedAt instanceof Date && !Number.isNaN(game.playedAt.getTime())
          ? game.playedAt.getTime()
          : null;

        if (untilMs !== null && gameTime !== null && gameTime > untilMs) {
          continue;
        }
        if (sinceMs !== null && gameTime !== null && gameTime < sinceMs) {
          continue;
        }

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
    }
  })();
}

export const chesscomClient = {
  fetchUserGames,
  isStandardChess,
};

export { isStandardChess };
export default chesscomClient;
