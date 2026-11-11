import { describe, expect, it } from 'vitest';
import { validateFen } from '../src/chess/fen.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function expectRejected(fen, pattern) {
  const result = validateFen(fen);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(pattern);
}

describe('validateFen', () => {
  it('accepts the standard start position', () => {
    expect(validateFen(START)).toEqual({ ok: true });
  });

  it('accepts a FEN with surrounding whitespace', () => {
    expect(validateFen(`  ${START}\n`)).toEqual({ ok: true });
  });

  it('accepts a legal middlegame position with Black to move', () => {
    expect(validateFen('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 3')).toEqual({ ok: true });
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, ['fen']]) {
      expectRejected(value, /must be a string/);
    }
  });

  it('rejects the wrong number of fields', () => {
    expectRejected('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', /6 fields, got 4/);
    expectRejected(`${START} extra`, /6 fields, got 7/);
    expectRejected('', /6 fields, got 0/);
  });

  it('rejects placement without 8 ranks', () => {
    expectRejected('rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', /8 ranks, got 7/);
  });

  it('rejects a rank that sums to more than 8', () => {
    expectRejected('rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', /unknown character '9'/);
    expectRejected('rnbqkbnr/pppppppp/8/8/4P4/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1', /rank 4 covers 9 squares/);
  });

  it('rejects a rank that sums to less than 8', () => {
    expectRejected('rnbqkbnr/pppppppp/7/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', /rank 6 covers 7 squares/);
  });

  it('rejects unknown piece characters', () => {
    expectRejected('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBXKBNR w KQkq - 0 1', /unknown character 'X'/);
  });

  it('rejects a missing white king', () => {
    expectRejected('4k3/8/8/8/8/8/8/8 w - - 0 1', /one white king, found 0/);
  });

  it('rejects a missing black king', () => {
    expectRejected('8/8/8/8/8/8/8/4K3 w - - 0 1', /one black king, found 0/);
  });

  it('rejects two white kings', () => {
    expectRejected('4k3/8/8/8/8/8/8/3KK3 w - - 0 1', /one white king, found 2/);
  });

  it('rejects two black kings', () => {
    expectRejected('3kk3/8/8/8/8/8/8/4K3 w - - 0 1', /one black king, found 2/);
  });

  it('rejects a pawn on the first rank', () => {
    expectRejected('4k3/8/8/8/8/8/8/P3K3 w - - 0 1', /pawn on rank 1/);
  });

  it('rejects a pawn on the last rank', () => {
    expectRejected('p3k3/8/8/8/8/8/8/4K3 w - - 0 1', /pawn on rank 8/);
  });

  it('rejects an invalid side to move', () => {
    expectRejected('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', /side to move 'x'/);
    expectRejected('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR W KQkq - 0 1', /side to move 'W'/);
  });

  it('rejects what chess.js rejects when loading', () => {
    expectRejected('4k3/8/8/8/8/8/8/4K3 w - e3 0 1', /en-passant/);
    expectRejected('4k3/8/8/8/8/8/8/4K3 w - - x 1', /half move/);
    expectRejected('4k3/8/8/8/8/8/8/4K3 w - - 0 0', /move number/);
  });
});
