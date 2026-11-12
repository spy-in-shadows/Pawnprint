import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import {
  parseClockToMs,
  parseTimeControl,
  parsePgnStream,
  parsePgnString,
  tokenizeMoveText,
} from '../src/chess/pgnParser.js';

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
      category: 'classical',
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
});
