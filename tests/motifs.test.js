import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { detectMotifs, isMissedMate } from '../src/chess/motifs.js';

function play(fen, uci) {
  const board = new Chess(fen);
  board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return board.fen();
}

function detect({ fen, move, best, reply, classification = 'blunder' }) {
  return detectMotifs({
    fenBefore: fen,
    fenAfter: play(fen, move),
    moveUci: move,
    bestUci: best,
    bestReplyUci: reply,
    classification,
  });
}

// White's queen leaves d1, so nothing covers c2 any more.
const KNIGHT_FORK = { fen: '6k1/8/8/8/3n4/8/8/R2QK3 w - - 0 1', move: 'd1h5', best: 'a1a7', reply: 'd4c2' };

describe('detectMotifs: allowed', () => {
  it('tags a knight fork that the reply lands on king and rook', () => {
    expect(detect(KNIGHT_FORK)).toEqual([{ name: 'fork', kind: 'allowed' }]);
  });

  it('tags a piece left en prise and taken by the reply', () => {
    const tags = detect({ fen: '4k3/8/8/3n4/8/8/8/2B1K3 w - - 0 1', move: 'c1e3', best: 'e1d2', reply: 'd5e3' });
    expect(tags).toEqual([{ name: 'hanging_piece', kind: 'allowed' }]);
  });

  it('tags a piece left en prise even when the reply does something else', () => {
    const tags = detect({ fen: '4k3/8/8/3n4/8/8/8/2B1K3 w - - 0 1', move: 'c1e3', best: 'e1d2', reply: 'e8e7' });
    expect(tags).toEqual([{ name: 'hanging_piece', kind: 'allowed' }]);
  });

  it('tags a back-rank check when the rook leaves the first rank', () => {
    const tags = detect({ fen: '2r3k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', move: 'd1d3', best: 'h2h3', reply: 'c8c1' });
    expect(tags).toEqual([{ name: 'back_rank', kind: 'allowed' }]);
  });

  it('tags a discovered attack when the reply uncovers a bishop onto the queen', () => {
    const tags = detect({ fen: '4k3/1b6/8/3n4/8/8/8/3Q2K1 w - - 0 1', move: 'd1f3', best: 'd1d5', reply: 'd5b4' });
    expect(tags).toEqual([{ name: 'discovered_attack', kind: 'allowed' }]);
  });

  it('does not tag a fork or hanging pieces that already existed before the move', () => {
    // The c2 knight already attacks the rook and queen; the reply plays elsewhere.
    const tags = detect({ fen: '7k/p7/8/8/8/4Q3/2n4P/R6K w - - 0 1', move: 'h2h3', best: 'e3e5', reply: 'a7a6' });
    expect(tags).toEqual([]);
  });

  it('skips reply-based tags when there is no engine reply', () => {
    expect(detect({ ...KNIGHT_FORK, reply: 'none' })).toEqual([]);
    expect(detect({ ...KNIGHT_FORK, reply: undefined })).toEqual([]);
  });
});

describe('detectMotifs: missed', () => {
  it("tags a knight fork the engine's best move had", () => {
    const tags = detect({ fen: '2q3k1/8/8/3N4/8/8/8/4K3 w - - 0 1', move: 'e1e2', best: 'd5e7', reply: 'g8h8' });
    expect(tags).toEqual([{ name: 'fork', kind: 'missed' }]);
  });

  it('does not tag a missed fork when the played move forks as well', () => {
    // Nf6+ forks king and rook, Ne7+ forks king and queen; the played one is just worse.
    const fen = '2q1r1k1/8/8/3N4/8/8/8/7K w - - 0 1';
    const tags = detect({ fen, move: 'd5f6', best: 'd5e7', reply: 'g8f8' });
    expect(tags.filter((t) => t.kind === 'missed')).toEqual([]);
  });

  it('tags an undefended piece the best move would have captured', () => {
    const tags = detect({ fen: '4k3/8/8/8/3n4/8/8/3QK3 w - - 0 1', move: 'e1f2', best: 'd1d4', reply: 'e8e7' });
    expect(tags).toEqual([{ name: 'hanging_piece', kind: 'missed' }]);
  });

  it('tags a missed back-rank mate', () => {
    const tags = detect({ fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', move: 'h2h3', best: 'd1d8', reply: 'g8f8' });
    expect(tags).toEqual([{ name: 'back_rank', kind: 'missed' }]);
  });

  it('adds no missed tags when the best move was played', () => {
    const tags = detect({ fen: '2q3k1/8/8/3N4/8/8/8/4K3 w - - 0 1', move: 'd5e7', best: 'd5e7', reply: 'g8f8' });
    expect(tags.filter((t) => t.kind === 'missed')).toEqual([]);
  });
});

describe('detectMotifs: gate', () => {
  it.each(['best', 'good', 'inaccuracy', null])('returns [] for classification %s', (classification) => {
    expect(detect({ ...KNIGHT_FORK, classification })).toEqual([]);
  });

  it('examines mistakes as well as blunders', () => {
    expect(detect({ ...KNIGHT_FORK, classification: 'mistake' })).toEqual([{ name: 'fork', kind: 'allowed' }]);
  });
});

describe('isMissedMate', () => {
  it('flags White losing a forced mate', () => {
    expect(isMissedMate(3, null, 'white')).toBe(true);
    expect(isMissedMate(2, -4, 'white')).toBe(true);
  });

  it('does not flag White when the mate only gets longer or is delivered', () => {
    expect(isMissedMate(3, 4, 'white')).toBe(false);
    expect(isMissedMate(3, 2, 'white')).toBe(false);
    expect(isMissedMate(1, 0, 'white')).toBe(false);
  });

  it('flags Black losing a forced mate', () => {
    expect(isMissedMate(-3, null, 'black')).toBe(true);
    expect(isMissedMate(-2, 5, 'black')).toBe(true);
  });

  it('does not flag Black when the mate only gets longer or is delivered', () => {
    expect(isMissedMate(-3, -4, 'black')).toBe(false);
    expect(isMissedMate(-1, 0, 'black')).toBe(false);
  });

  it('does not flag a mover who had no forced mate', () => {
    expect(isMissedMate(null, null, 'white')).toBe(false);
    expect(isMissedMate(-3, null, 'white')).toBe(false);
    expect(isMissedMate(3, null, 'black')).toBe(false);
  });
});
