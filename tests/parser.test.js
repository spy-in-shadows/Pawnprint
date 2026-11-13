import { describe, expect, it, vi, afterEach } from 'vitest';
import { Readable } from 'stream';
import {
  parseClockToMs,
  parseTimeControl,
  parsePgnStream,
  parsePgnString,
  tokenizeMoveText,
} from '../src/chess/pgnParser.js';
import { isStandardChess } from '../src/ingest/standardChess.js';
import { fetchUserGames as fetchLichessGames, lichessClient } from '../src/ingest/lichessClient.js';
import { fetchUserGames as fetchChesscomGames, chesscomClient } from '../src/ingest/chesscomClient.js';

describe('pgnParser clock and time control helpers', () => {
  it('parses clock strings into milliseconds', () => {
    expect(parseClockToMs('0:03:00')).toBe(180000);
    expect(parseClockToMs('0:03:00.5')).toBe(180500);
    expect(parseClockToMs('1:15:30')).toBe(4530000);
    expect(parseClockToMs('2:00')).toBe(120000);
    expect(parseClockToMs('45')).toBe(45000);
    expect(parseClockToMs('45.2')).toBe(45200);
  });

  it('returns null for empty or invalid clock strings', () => {
    expect(parseClockToMs(null)).toBeNull();
    expect(parseClockToMs(undefined)).toBeNull();
    expect(parseClockToMs('')).toBeNull();
    expect(parseClockToMs('invalid')).toBeNull();
  });

  it('parses time controls and classifies category correctly', () => {
    expect(parseTimeControl('60+0')).toEqual({
      baseSeconds: 60,
      incrementSeconds: 0,
      category: 'bullet',
    });
    expect(parseTimeControl('120+1')).toEqual({
      baseSeconds: 120,
      incrementSeconds: 1,
      category: 'bullet',
    });
    expect(parseTimeControl('180+2')).toEqual({
      baseSeconds: 180,
      incrementSeconds: 2,
      category: 'blitz',
    });
    expect(parseTimeControl('300+0')).toEqual({
      baseSeconds: 300,
      incrementSeconds: 0,
      category: 'blitz',
    });
    expect(parseTimeControl('600+0')).toEqual({
      baseSeconds: 600,
      incrementSeconds: 0,
      category: 'rapid',
    });
    expect(parseTimeControl('900+10')).toEqual({
      baseSeconds: 900,
      incrementSeconds: 10,
      category: 'rapid',
    });
    expect(parseTimeControl('1800+0')).toEqual({
      baseSeconds: 1800,
      incrementSeconds: 0,
      category: 'classical',
    });
    expect(parseTimeControl('-')).toEqual({
      baseSeconds: 0,
      incrementSeconds: 0,
      category: 'correspondence',
    });
    expect(parseTimeControl('1/86400')).toEqual({
      baseSeconds: 86400,
      incrementSeconds: 0,
      category: 'correspondence',
    });
    expect(parseTimeControl('')).toEqual({
      baseSeconds: 0,
      incrementSeconds: 0,
      category: 'classical',
    });
    expect(parseTimeControl(null)).toEqual({
      baseSeconds: 0,
      incrementSeconds: 0,
      category: 'classical',
    });
    expect(parseTimeControl('?')).toEqual({
      baseSeconds: 0,
      incrementSeconds: 0,
      category: 'classical',
    });
  });
});

describe('pgnParser PGN parsing', () => {
  it('parses headers and basic metadata correctly', async () => {
    const pgn = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcd1234"]
[Date "2023.08.15"]
[White "MagnusCarlsen"]
[Black "HikaruNakamura"]
[Result "1-0"]
[UTCDate "2023.08.15"]
[UTCTime "18:30:00"]
[WhiteElo "2850"]
[BlackElo "2820"]
[ECO "C50"]
[Opening "Italian Game"]
[TimeControl "180+2"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);

    const game = games[0];
    expect(game.externalId).toBe('abcd1234');
    expect(game.white).toBe('MagnusCarlsen');
    expect(game.black).toBe('HikaruNakamura');
    expect(game.whiteElo).toBe(2850);
    expect(game.blackElo).toBe(2820);
    expect(game.resultRaw).toBe('1-0');
    expect(game.eco).toBe('C50');
    expect(game.openingName).toBe('Italian Game');
    expect(game.timeControl).toEqual({
      baseSeconds: 180,
      incrementSeconds: 2,
      category: 'blitz',
    });
    expect(game.playedAt).toBeInstanceOf(Date);
    expect(game.playedAt.toISOString()).toBe('2023-08-15T18:30:00.000Z');
    expect(game.totalPlies).toBe(6);
    expect(game.parseError).toBeNull();
    expect(game.moves).toHaveLength(6);

    expect(game.moves[0]).toMatchObject({
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
      moverColor: 'white',
      phase: 'opening',
    });
  });

  it('computes clocks and time spent while ignoring eval comments', async () => {
    const pgn = `[Event "Live Chess"]
[Site "https://chess.com/game/live/987654321"]
[White "PlayerOne"]
[Black "PlayerTwo"]
[Result "1-0"]
[TimeControl "180+2"]

1. e4 { [%eval +0.22] [%clk 0:02:58] } 1... e5 { [%eval +0.18] [%clk 0:02:59] } 2. Nf3 { [%clk 0:02:56] } 2... Nc6 { [%clk 0:02:57] } 1-0`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);

    const game = games[0];
    expect(game.externalId).toBe('987654321');
    expect(game.moves).toHaveLength(4);

    // Initial base: 180,000 ms, increment: 2,000 ms
    // Move 1 (White e4): clock = 178,000 ms. Spent = 180,000 - 178,000 + 2,000 = 4,000 ms
    expect(game.moves[0].clockRemainingMs).toBe(178000);
    expect(game.moves[0].timeSpentMs).toBe(4000);

    // Move 2 (Black e5): clock = 179,000 ms. Spent = 180,000 - 179,000 + 2,000 = 3,000 ms
    expect(game.moves[1].clockRemainingMs).toBe(179000);
    expect(game.moves[1].timeSpentMs).toBe(3000);

    // Move 3 (White Nf3): clock = 176,000 ms. Spent = 178,000 - 176,000 + 2,000 = 4,000 ms
    expect(game.moves[2].clockRemainingMs).toBe(176000);
    expect(game.moves[2].timeSpentMs).toBe(4000);

    // Move 4 (Black Nc6): clock = 177,000 ms. Spent = 179,000 - 177,000 + 2,000 = 4,000 ms
    expect(game.moves[3].clockRemainingMs).toBe(177000);
    expect(game.moves[3].timeSpentMs).toBe(4000);
  });

  it('ignores nested variations and keeps only main line moves', async () => {
    const pgn = `[Event "Variation Test"]
[Site "https://lichess.org/varTest123"]
[Result "*"]

1. e4 ( 1. d4 d5 ( 1... Nf6 2. c4 ) 2. c4 ) 1... e5 2. Nf3 ( 2. f4 exf4 ) 2... Nc6 *`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);

    const sans = games[0].moves.map((m) => m.san);
    expect(sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(games[0].totalPlies).toBe(4);
    expect(games[0].resultRaw).toBe('*');
  });

  it('handles multi-game streams accurately', async () => {
    const pgn = `[Event "Game 1"]
[Site "https://lichess.org/game1"]
[White "Alpha"]
[Black "Beta"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "Game 2"]
[Site "https://lichess.org/game2"]
[White "Gamma"]
[Black "Delta"]
[Result "0-1"]

1. d4 d5 2. c4 c6 0-1

[Event "Game 3"]
[Site "https://lichess.org/game3"]
[White "Epsilon"]
[Black "Zeta"]
[Result "1/2-1/2"]

1. c4 e5 1/2-1/2`;

    const stream = Readable.from([pgn]);
    const games = [];
    for await (const game of parsePgnStream(stream)) {
      games.push(game);
    }

    expect(games).toHaveLength(3);
    expect(games[0].white).toBe('Alpha');
    expect(games[0].resultRaw).toBe('1-0');
    expect(games[1].white).toBe('Gamma');
    expect(games[1].resultRaw).toBe('0-1');
    expect(games[2].white).toBe('Epsilon');
    expect(games[2].resultRaw).toBe('1/2-1/2');
  });

  it('reconstructs games from streams chunked at awkward byte boundaries', async () => {
    const pgn = `[Event "Awkward Chunk Test"]
[Site "https://lichess.org/chunkTest99"]
[White "StreamTester"]
[Black "BufferChecker"]
[Result "1-0"]
[TimeControl "180+0"]

1. e4 { [%clk 0:02:59] } 1... c5 { [%clk 0:02:58] } 2. Nf3 { [%clk 0:02:57] } 2... d6 { [%clk 0:02:56] } 1-0`;

    // Emit 3-byte chunks to cut across lines, headers, moves, and comments
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < pgn.length; i += chunkSize) {
      chunks.push(pgn.slice(i, i + chunkSize));
    }

    const stream = Readable.from(chunks);
    const games = [];
    for await (const g of parsePgnStream(stream)) {
      games.push(g);
    }

    expect(games).toHaveLength(1);
    expect(games[0].externalId).toBe('chunkTest99');
    expect(games[0].white).toBe('StreamTester');
    expect(games[0].moves).toHaveLength(4);
    expect(games[0].moves[0].san).toBe('e4');
    expect(games[0].moves[3].san).toBe('d6');
  });

  it('handles games with missing headers and result *', async () => {
    const pgn = `1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);

    const game = games[0];
    expect(game.white).toBe('?');
    expect(game.black).toBe('?');
    expect(game.resultRaw).toBe('*');
    expect(game.totalPlies).toBe(6);
    expect(game.externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(game.parseError).toBeNull();
  });

  it('does not throw on illegal moves, yielding moves so far and setting parseError', async () => {
    const pgn = `[Event "Illegal Move Test"]
[Site "https://lichess.org/illegal123"]
[White "GoodPlayer"]
[Black "BadPlayer"]
[Result "*"]

1. e4 e5 2. Ke2 Ke7 3. Ke8 *`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);

    const game = games[0];
    expect(game.externalId).toBe('illegal123');
    // Moves 1-4 (e4, e5, Ke2, Ke7) are legal
    expect(game.moves).toHaveLength(4);
    expect(game.totalPlies).toBe(4);
    expect(game.parseError).toBe('Illegal move at ply 5: Ke8');
  });

  it('sets parseError and returns zero moves for invalid start FEN under SetUp 1', async () => {
    const pgn = `[Event "Bad FEN"]
[Site "https://lichess.org/badFen123"]
[SetUp "1"]
[FEN "invalid/fen/string w - - 0 1"]
[Result "*"]

1. e4 e5 *`;

    const games = await parsePgnString(pgn);
    expect(games).toHaveLength(1);
    expect(games[0].parseError).toBe('Invalid start FEN: invalid/fen/string w - - 0 1');
    expect(games[0].moves).toEqual([]);
    expect(games[0].totalPlies).toBe(0);
  });
});

const sampleStandardPgn = `[Event "Live Chess"]
[Site "https://lichess.org/std1"]
[Date "2023.05.01"]
[UTCDate "2023.05.01"]
[UTCTime "12:00:00"]
[White "Player1"]
[Black "Player2"]
[Result "1-0"]
[Variant "Standard"]

1. e4 e5 2. Nf3 Nc6 1-0`;

const sampleStandardPgn2 = `[Event "Live Chess 2"]
[Site "https://lichess.org/std2"]
[Date "2023.05.02"]
[UTCDate "2023.05.02"]
[UTCTime "12:00:00"]
[White "Player3"]
[Black "Player4"]
[Result "0-1"]

1. d4 d5 2. c4 e6 0-1`;

const sampleStandardPgn3 = `[Event "Live Chess 3"]
[Site "https://lichess.org/std3"]
[Date "2023.05.03"]
[UTCDate "2023.05.03"]
[UTCTime "12:00:00"]
[White "Player5"]
[Black "Player6"]
[Result "1/2-1/2"]

1. c4 c5 1/2-1/2`;

const sampleCrazyhousePgn = `[Event "Crazyhouse"]
[Site "https://lichess.org/crazy1"]
[Date "2023.05.01"]
[UTCDate "2023.05.01"]
[UTCTime "12:00:00"]
[White "CrazyPlayer"]
[Black "OtherPlayer"]
[Result "1-0"]
[Variant "Crazyhouse"]

1. e4 e5 1-0`;

const sampleCustomFenPgn = `[Event "Custom FEN"]
[Site "https://lichess.org/custom1"]
[Date "2023.05.01"]
[UTCDate "2023.05.01"]
[UTCTime "12:00:00"]
[White "CustomPlayer"]
[Black "OtherPlayer"]
[Result "1-0"]
[SetUp "1"]
[FEN "8/8/8/8/8/8/4K3/4k3 w - - 0 1"]

1. Ke3 Kd1 1-0`;

describe('isStandardChess helper', () => {
  it('accepts games with standard variant or default FEN', () => {
    expect(isStandardChess({ headers: { Variant: 'Standard' } })).toBe(true);
    expect(isStandardChess({ headers: { Variant: 'standard' } })).toBe(true);
    expect(isStandardChess({ headers: { Variant: 'Chess' } })).toBe(true);
    expect(isStandardChess({ headers: { Variant: 'chess' } })).toBe(true);
    expect(isStandardChess({ headers: {} })).toBe(true);
    expect(isStandardChess({ headers: { FEN: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' } })).toBe(true);
  });

  it('rejects games with non-standard variants', () => {
    expect(isStandardChess({ headers: { Variant: 'Crazyhouse' } })).toBe(false);
    expect(isStandardChess({ headers: { Variant: 'Chess960' } })).toBe(false);
    expect(isStandardChess({ headers: { variant: 'threeCheck' } })).toBe(false);
    expect(isStandardChess({ headers: { Variant: 'King of the Hill' } })).toBe(false);
  });

  it('rejects games with non-standard initial FEN or SetUp 1', () => {
    expect(isStandardChess({ headers: { FEN: '8/8/8/8/8/8/4K3/4k3 w - - 0 1' } })).toBe(false);
    expect(isStandardChess({ headers: { SetUp: '1' } })).toBe(false);
    expect(isStandardChess({ headers: { SetUp: 1 } })).toBe(false);
  });

  it('returns false for null or undefined game input', () => {
    expect(isStandardChess(null)).toBe(false);
    expect(isStandardChess(undefined)).toBe(false);
  });
});

describe('lichessClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('honors Retry-After on 429 with fake timers and succeeds on retry', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        return {
          status: 429,
          ok: false,
          headers: { 'retry-after': '3' },
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => sampleStandardPgn,
      };
    });

    const runPromise = (async () => {
      const games = [];
      for await (const g of fetchLichessGames('player1', { max: 1 })) {
        games.push(g);
      }
      return games;
    })();

    await vi.advanceTimersByTimeAsync(3000);
    const result = await runPromise;

    expect(attempts).toBe(2);
    expect(result).toHaveLength(1);
    expect(result[0].white).toBe('Player1');
  });

  it('retries up to 3 times on 429 with exponential backoff and throws', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return {
        status: 429,
        ok: false,
        headers: { 'retry-after': '1' },
      };
    });

    const runPromise = (async () => {
      const games = [];
      for await (const g of fetchLichessGames('player1')) {
        games.push(g);
      }
      return games;
    })();

    const catchPromise = runPromise.catch((err) => err);

    // attempt 0 retry: wait 1 * 1000 * 1 = 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // attempt 1 retry: wait 1 * 1000 * 2 = 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    // attempt 2 retry: wait 1 * 1000 * 4 = 4000ms
    await vi.advanceTimersByTimeAsync(4000);

    const err = await catchPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('429');
    expect(attempts).toBe(4);
  });

  it('respects max, since and until bounds', async () => {
    let requestedUrl = null;
    globalThis.fetch = vi.fn(async (url) => {
      requestedUrl = url;
      const multiGamePgn = `${sampleStandardPgn}\n\n${sampleStandardPgn2}\n\n${sampleStandardPgn3}`;
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => multiGamePgn,
      };
    });

    const sinceDate = new Date('2023-01-01T00:00:00Z');
    const untilDate = new Date('2023-12-31T23:59:59Z');

    const games = [];
    for await (const g of fetchLichessGames('player1', { max: 2, since: sinceDate, until: untilDate })) {
      games.push(g);
    }

    expect(games).toHaveLength(2);
    expect(requestedUrl).toContain('max=2');
    expect(requestedUrl).toContain(`since=${sinceDate.getTime()}`);
    expect(requestedUrl).toContain(`until=${untilDate.getTime()}`);
    expect(requestedUrl).toContain('clocks=true');
    expect(requestedUrl).toContain('opening=true');
  });

  it('skips variants and custom-FEN games, tracking count in stats.skippedGames', async () => {
    const combinedPgn = `${sampleStandardPgn}\n\n${sampleCrazyhousePgn}\n\n${sampleCustomFenPgn}\n\n${sampleStandardPgn2}`;
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { 'content-type': 'application/x-chess-pgn' },
      text: async () => combinedPgn,
    }));

    const stats = {};
    const games = [];
    for await (const g of fetchLichessGames('player1', { stats })) {
      games.push(g);
    }

    expect(games).toHaveLength(2);
    expect(games[0].white).toBe('Player1');
    expect(games[1].white).toBe('Player3');
    expect(stats.skippedGames).toBe(2);
  });

  it('resets stats.skippedGames between consecutive runs', async () => {
    const combinedPgnWithVariants = `${sampleStandardPgn}\n\n${sampleCrazyhousePgn}`;
    const cleanStandardPgn = `${sampleStandardPgn}`;

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => (callCount === 1 ? combinedPgnWithVariants : cleanStandardPgn),
      };
    });

    const stats = {};

    const run1Games = [];
    for await (const g of fetchLichessGames('player1', { stats })) {
      run1Games.push(g);
    }
    expect(run1Games).toHaveLength(1);
    expect(stats.skippedGames).toBe(1);

    const run2Games = [];
    for await (const g of fetchLichessGames('player1', { stats })) {
      run2Games.push(g);
    }
    expect(run2Games).toHaveLength(1);
    expect(stats.skippedGames).toBe(0);
  });

  it('exports lichessClient object with fetchUserGames and isStandardChess', () => {
    expect(typeof lichessClient.fetchUserGames).toBe('function');
    expect(typeof lichessClient.isStandardChess).toBe('function');
  });
});

describe('chesscomClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('walks Chess.com archives newest to oldest and stops once max is reached', async () => {
    const requestedUrls = [];
    globalThis.fetch = vi.fn(async (url) => {
      requestedUrls.push(url);
      if (url.includes('/games/archives')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: [
              'https://api.chess.com/pub/player/erik/games/2023/01',
              'https://api.chess.com/pub/player/erik/games/2023/02',
              'https://api.chess.com/pub/player/erik/games/2023/03',
            ],
          }),
        };
      }
      if (url.includes('/2023/03/pgn')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/x-chess-pgn' },
          text: async () => `${sampleStandardPgn}\n\n${sampleStandardPgn2}`,
        };
      }
      if (url.includes('/2023/02/pgn')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/x-chess-pgn' },
          text: async () => sampleStandardPgn3,
        };
      }
      return { status: 404, ok: false };
    });

    const games = [];
    for await (const g of fetchChesscomGames('erik', { max: 2, delayMs: 0 })) {
      games.push(g);
    }

    expect(games).toHaveLength(2);
    expect(requestedUrls[0]).toContain('/games/archives');
    expect(requestedUrls[1]).toContain('/2023/03/pgn');
    expect(requestedUrls).toHaveLength(2);
  });

  it('yields Chess.com games newest first within a single month archive', async () => {
    const gameMay01 = sampleStandardPgn.replace(/Player1/g, 'PlayerMay01').replace(/2023\.05\.01/g, '2023.05.01');
    const gameMay15 = sampleStandardPgn.replace(/Player1/g, 'PlayerMay15').replace(/2023\.05\.01/g, '2023.05.15');
    const gameMay30 = sampleStandardPgn.replace(/Player1/g, 'PlayerMay30').replace(/2023\.05\.01/g, '2023.05.30');

    // Archive lists games oldest first: May 01, May 15, May 30
    const oldestFirstPgn = `${gameMay01}\n\n${gameMay15}\n\n${gameMay30}`;

    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/games/archives')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: ['https://api.chess.com/pub/player/erik/games/2023/05'],
          }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => oldestFirstPgn,
      };
    });

    const games = [];
    for await (const g of fetchChesscomGames('erik', { max: 2, delayMs: 0 })) {
      games.push(g);
    }

    expect(games).toHaveLength(2);
    expect(games[0].white).toBe('PlayerMay30');
    expect(games[1].white).toBe('PlayerMay15');
  });

  it('filters games by since and until dates in Chess.com archives', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/games/archives')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: ['https://api.chess.com/pub/player/erik/games/2023/05'],
          }),
        };
      }
      const gameEarly = sampleStandardPgn; // 2023.05.01
      const gameMid = sampleStandardPgn2.replace(/2023\.05\.02/g, '2023.05.10');
      const gameLate = sampleStandardPgn3.replace(/2023\.05\.03/g, '2023.05.20');
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => `${gameEarly}\n\n${gameMid}\n\n${gameLate}`,
      };
    });

    const since = new Date('2023-05-05T00:00:00Z');
    const until = new Date('2023-05-15T00:00:00Z');

    const games = [];
    for await (const g of fetchChesscomGames('erik', { since, until, delayMs: 0 })) {
      games.push(g);
    }

    expect(games).toHaveLength(1);
    expect(games[0].white).toBe('Player3');
  });

  it('handles 429 Retry-After on Chess.com requests with fake timers', async () => {
    vi.useFakeTimers();
    let archiveAttempts = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/games/archives')) {
        archiveAttempts++;
        if (archiveAttempts === 1) {
          return {
            status: 429,
            ok: false,
            headers: { 'retry-after': '2' },
          };
        }
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: ['https://api.chess.com/pub/player/erik/games/2023/05'],
          }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => sampleStandardPgn,
      };
    });

    const runPromise = (async () => {
      const games = [];
      for await (const g of fetchChesscomGames('erik', { delayMs: 0 })) {
        games.push(g);
      }
      return games;
    })();

    await vi.advanceTimersByTimeAsync(2000);
    const games = await runPromise;

    expect(archiveAttempts).toBe(2);
    expect(games).toHaveLength(1);
  });

  it('skips variants and resets stats.skippedGames between runs in Chess.com', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/games/archives')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: ['https://api.chess.com/pub/player/erik/games/2023/05'],
          }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => `${sampleStandardPgn}\n\n${sampleCrazyhousePgn}`,
      };
    });

    const stats = {};
    const run1 = [];
    for await (const g of fetchChesscomGames('erik', { stats, delayMs: 0 })) {
      run1.push(g);
    }
    expect(run1).toHaveLength(1);
    expect(stats.skippedGames).toBe(1);

    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/games/archives')) {
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json' },
          json: async () => ({
            archives: ['https://api.chess.com/pub/player/erik/games/2023/05'],
          }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/x-chess-pgn' },
        text: async () => sampleStandardPgn,
      };
    });

    const run2 = [];
    for await (const g of fetchChesscomGames('erik', { stats, delayMs: 0 })) {
      run2.push(g);
    }
    expect(run2).toHaveLength(1);
    expect(stats.skippedGames).toBe(0);
  });

  it('exports chesscomClient object with fetchUserGames and isStandardChess', () => {
    expect(typeof chesscomClient.fetchUserGames).toBe('function');
    expect(typeof chesscomClient.isStandardChess).toBe('function');
  });
});
