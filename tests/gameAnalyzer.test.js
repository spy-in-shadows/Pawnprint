import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATE_CP } from '../src/chess/evalMath.js';
import { DataError } from '../src/utils/errors.js';
import { analyzeGame } from '../src/workers/gameAnalyzer.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Answers evaluatePosition from a FEN -> result table (falling back to a quiet default) and
// records every FEN it was asked about.
function fakeEngine(scripted = {}) {
  const fens = [];
  return {
    fens,
    get calls() {
      return fens.length;
    },
    async evaluatePosition(fen) {
      fens.push(fen);
      return scripted[fen] ?? { evalCp: 20, mate: null, bestUci: 'e2e4', depth: 12 };
    },
  };
}

function toMoves(sans) {
  const board = new Chess();
  return sans.map((san, i) => {
    const played = board.move(san);
    return { ply: i + 1, san: played.san, uci: played.from + played.to + (played.promotion ?? ''), fenBefore: 'garbage' };
  });
}

function fenAfter(sans) {
  const board = new Chess();
  sans.forEach((san) => board.move(san));
  return board.fen();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analyzeGame', () => {
  it('makes N + 1 engine calls for N plies', async () => {
    const engine = fakeEngine();
    const rows = await analyzeGame({ moves: toMoves(['e4', 'e5', 'Nf3', 'Nc6']) }, engine, { engineVersionId: 1 });

    expect(engine.calls).toBe(5);
    expect(new Set(engine.fens).size).toBe(5);
    expect(rows.map((r) => r.ply)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ bestUci: 'e2e4', depth: 12, mateBefore: null, mateAfter: null, motifs: [] });
  });

  it('reuses the after eval of one ply as the before eval of the next', async () => {
    const sans = ['e4', 'e5', 'Nf3'];
    const engine = fakeEngine({
      [START]: { evalCp: 30, mate: null, bestUci: 'e2e4', depth: 12 },
      [fenAfter(sans.slice(0, 1))]: { evalCp: 35, mate: null, bestUci: 'e7e5', depth: 12 },
      [fenAfter(sans.slice(0, 2))]: { evalCp: 40, mate: null, bestUci: 'g1f3', depth: 12 },
      [fenAfter(sans)]: { evalCp: 25, mate: null, bestUci: 'b8c6', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(rows.map((r) => [r.evalBeforeCp, r.evalAfterCp, r.bestUci])).toEqual([
      [30, 35, 'e2e4'],
      [35, 40, 'e7e5'],
      [40, 25, 'g1f3'],
    ]);
  });

  it('serves the start position from startCache on later games', async () => {
    const startCache = new Map();
    const first = fakeEngine();
    await analyzeGame({ moves: toMoves(['d4', 'd5']) }, first, { engineVersionId: 7, startCache });
    expect(first.calls).toBe(3);
    expect(startCache.has(7)).toBe(true);

    const second = fakeEngine();
    const rows = await analyzeGame({ moves: toMoves(['e4', 'c5']) }, second, { engineVersionId: 7, startCache });
    expect(second.calls).toBe(2);
    expect(second.fens).not.toContain(START);
    expect(rows[0].bestUci).toBe('e2e4');

    const otherVersion = fakeEngine();
    await analyzeGame({ moves: toMoves(['e4', 'c5']) }, otherVersion, { engineVersionId: 8, startCache });
    expect(otherVersion.calls).toBe(3);
  });

  it("resolves fool's mate from the board without an engine call", async () => {
    const sans = ['f3', 'e5', 'g4', 'Qh4#'];
    const engine = fakeEngine({
      [fenAfter(sans.slice(0, 3))]: { evalCp: -9990, mate: -1, bestUci: 'd8h4', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(engine.calls).toBe(4);
    expect(engine.fens).not.toContain(fenAfter(sans));
    const last = rows[3];
    expect(last).toMatchObject({
      ply: 4,
      evalBeforeCp: -9990,
      evalAfterCp: -MATE_CP,
      mateBefore: -1,
      mateAfter: 0,
      bestUci: 'd8h4',
      cpLoss: 0,
      classification: 'best',
    });
  });

  it('scores a stalemate as 0 without an engine call', async () => {
    const sans = ['e3', 'a5', 'Qh5', 'Ra6', 'Qxa5', 'h5', 'h4', 'Rah6', 'Qxc7', 'f6',
      'Qxd7+', 'Kf7', 'Qxb7', 'Qd3', 'Qxb8', 'Qh7', 'Qxc8', 'Kg6', 'Qe6'];
    const engine = fakeEngine();
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(engine.calls).toBe(sans.length);
    const last = rows.at(-1);
    expect(last.evalAfterCp).toBe(0);
    expect(last.mateAfter).toBeNull();
  });

  it('marks terminal positions with bestUci none and depth 0 when play continues after a repetition', async () => {
    const sans = ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8', 'e4'];
    const engine = fakeEngine();
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(rows[7].evalAfterCp).toBe(0);
    expect(rows[8]).toMatchObject({ bestUci: 'none', depth: 0, evalBeforeCp: 0 });
  });

  it('throws DataError for an illegal move and names the ply', async () => {
    const moves = toMoves(['e4', 'e5']);
    moves.push({ ply: 3, san: 'Ke3', uci: 'e1e3', fenBefore: 'garbage' });

    await expect(analyzeGame({ moves }, fakeEngine(), { engineVersionId: 1 })).rejects.toThrow(DataError);
    await expect(analyzeGame({ moves }, fakeEngine(), { engineVersionId: 1 })).rejects.toThrow(/at ply 3/);
  });

  it('falls back to the UCI when the SAN does not parse', async () => {
    const moves = [
      { ply: 1, san: '??', uci: 'e2e4', fenBefore: 'garbage' },
      { ply: 2, san: null, uci: 'e7e5', fenBefore: 'garbage' },
    ];
    const engine = fakeEngine();
    const rows = await analyzeGame({ moves }, engine, { engineVersionId: 1 });

    expect(rows).toHaveLength(2);
    expect(engine.fens.at(-1)).toBe(fenAfter(['e4', 'e5']));
  });

  it('throws DataError when the replayed board yields an invalid FEN', async () => {
    const moves = toMoves(['e4', 'e5']);
    const corruptedAt = fenAfter(['e4']);
    const realFen = Chess.prototype.fen;
    vi.spyOn(Chess.prototype, 'fen').mockImplementation(function corrupted(...args) {
      const fen = realFen.apply(this, args);
      return fen === corruptedAt ? '8/8/8/8/8/8/8/8 w - - 0 1' : fen;
    });
    const engine = fakeEngine();

    const err = await analyzeGame({ moves }, engine, { engineVersionId: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.message).toMatch(/ply 1/);
    expect(engine.calls).toBe(1);
  });

  it('measures cpLoss from the mover perspective for Black', async () => {
    const sans = ['e4', 'f6', 'd4', 'g5'];
    const engine = fakeEngine({
      [fenAfter(sans.slice(0, 3))]: { evalCp: 80, mate: null, bestUci: 'e7e6', depth: 12 },
      [fenAfter(sans)]: { evalCp: 9990, mate: 1, bestUci: 'd1h5', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });
    const blunder = rows[3];

    expect(blunder.evalBeforeCp).toBe(80);
    expect(blunder.evalAfterCp).toBe(9990);
    expect(blunder.mateAfter).toBe(1);
    // The eval moved toward White, which is a loss for Black: capped 1000 - 80 = 920.
    expect(blunder.cpLoss).toBe(920);
    expect(blunder.classification).toBe('blunder');
  });

  it("tags motifs on a scripted blunder from the engine's best move and best reply", async () => {
    // 2.Ba6?? drops the bishop to bxa6; the eval after 2.Ba6 carries Black's best reply.
    const sans = ['e4', 'e5', 'Ba6'];
    const engine = fakeEngine({
      [fenAfter(sans.slice(0, 2))]: { evalCp: 30, mate: null, bestUci: 'g1f3', depth: 12 },
      [fenAfter(sans)]: { evalCp: -300, mate: null, bestUci: 'b7a6', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(rows[2]).toMatchObject({ classification: 'blunder', motifs: [{ name: 'hanging_piece', kind: 'allowed' }] });
    expect(rows[0].motifs).toEqual([]);
    expect(rows[1].motifs).toEqual([]);
  });

  it('adds missed_mate when a blunder throws away a forced mate', async () => {
    const sans = ['e4', 'e5', 'Ba6'];
    const engine = fakeEngine({
      [fenAfter(sans.slice(0, 2))]: { evalCp: 9970, mate: 3, bestUci: 'g1f3', depth: 12 },
      [fenAfter(sans)]: { evalCp: -300, mate: null, bestUci: 'b7a6', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(rows[2].classification).toBe('blunder');
    expect(rows[2].motifs).toEqual([
      { name: 'hanging_piece', kind: 'allowed' },
      { name: 'missed_mate', kind: 'missed' },
    ]);
  });

  it('does not tag a forced mate that only gets longer', async () => {
    const sans = ['e4', 'e5', 'Ba6'];
    const engine = fakeEngine({
      [fenAfter(sans.slice(0, 2))]: { evalCp: 9970, mate: 3, bestUci: 'g1f3', depth: 12 },
      [fenAfter(sans)]: { evalCp: 9960, mate: 4, bestUci: 'b7a6', depth: 12 },
    });
    const rows = await analyzeGame({ moves: toMoves(sans) }, engine, { engineVersionId: 1 });

    expect(rows[2].classification).toBe('best');
    expect(rows[2].motifs).toEqual([]);
  });

  it('ignores the stored fenBefore', async () => {
    const moves = toMoves(['e4', 'e5']).map((m) => ({ ...m, fenBefore: 'not a fen at all' }));
    const engine = fakeEngine();
    await analyzeGame({ moves }, engine, { engineVersionId: 1 });

    expect(engine.fens).toEqual([START, fenAfter(['e4']), fenAfter(['e4', 'e5'])]);
  });
});
