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

describe('detectMotifs: pins and skewers', () => {
  it('tags an absolute pin of a knight to the king created by the reply', () => {
    // Bb4 lines up b4-c3-d2-e1: the c3 knight is pinned to the e1 king.
    const tags = detect({ fen: '4kb2/8/8/8/8/2N5/7P/4K3 w - - 0 1', move: 'h2h3', best: 'e1d1', reply: 'f8b4' });
    expect(tags).toEqual([{ name: 'pin', kind: 'allowed' }]);
  });

  it('tags a relative pin of a knight to the queen', () => {
    // Rd8 lines up d8-d4-d1: the defended d4 knight now shields the d1 queen.
    const tags = detect({ fen: 'r5k1/8/8/8/3N4/8/7P/3Q3K w - - 0 1', move: 'h2h3', best: 'h1g1', reply: 'a8d8' });
    expect(tags).toEqual([{ name: 'pin', kind: 'allowed' }]);
  });

  it('tags a skewer through the king', () => {
    // Bb2+ runs b2-c3-d4-e5-f6-g7: the king on d4 must step off the diagonal and drop the g7 rook.
    const tags = detect({ fen: 'k7/6R1/8/8/3K4/b7/7P/8 w - - 0 1', move: 'h2h3', best: 'g7g1', reply: 'a3b2' });
    expect(tags).toEqual([{ name: 'skewer', kind: 'allowed' }]);
  });

  it('tags a skewer through the queen', () => {
    // Ba2 runs a2-b3-c4-d5-e6: the queen on c4 has the e6 rook behind it.
    const tags = detect({ fen: '7k/8/4R3/8/2Q5/8/7P/1b2K3 w - - 0 1', move: 'h2h3', best: 'e1d2', reply: 'b1a2' });
    expect(tags).toEqual([{ name: 'skewer', kind: 'allowed' }]);
  });

  it('does not tag a pin that already existed and that the reply leaves alone', () => {
    // The b4 bishop pins the c3 knight to the e1 king before White moves; the move and the
    // reply are both elsewhere on the board.
    const fen = '4k3/8/8/3p4/1b6/2N5/7P/4K3 w - - 0 1';
    expect(detect({ fen, move: 'h2h3', best: 'e1d1', reply: 'e8d7' })).toEqual([]);
    // Same position, but ...d4 attacks the pinned knight, so the pin is exploited.
    expect(detect({ fen, move: 'h2h3', best: 'e1d1', reply: 'd5d4' })).toEqual([{ name: 'pin', kind: 'allowed' }]);
  });

  it("tags a pin the player's own move walks into only when the reply exploits it", () => {
    // Kf1-e1 puts the king behind the e3 knight on the e-file the e8 rook controls.
    const fen = '4r2k/8/8/3p4/8/4N3/5P2/5K2 w - - 0 1';
    expect(detect({ fen, move: 'f1e1', best: 'f1g1', reply: 'd5d4' })).toEqual([{ name: 'pin', kind: 'allowed' }]);
    expect(detect({ fen, move: 'f1e1', best: 'f1g1', reply: 'h8g8' })).toEqual([]);
  });

  it("does not tag 'allowed' for a pin the player's move inflicts on the opponent", () => {
    // Bb5 pins the c6 knight to the e8 king; that pin helps White, so it is not an error tag.
    const tags = detect({ fen: '4k3/p7/2n5/8/8/8/8/4KB2 w - - 0 1', move: 'f1b5', best: 'e1e2', reply: 'a7a6' });
    expect(tags).toEqual([]);
  });

  it("tags a pin the engine's best move had with kind 'missed'", () => {
    // Bb5 would pin the c6 knight to the e8 king along b5-c6-d7-e8; White pushed a pawn instead.
    const tags = detect({ fen: '4k3/p7/2n5/8/8/8/7P/4KB2 w - - 0 1', move: 'h2h3', best: 'f1b5', reply: 'a7a6' });
    expect(tags).toEqual([{ name: 'pin', kind: 'missed' }]);
  });

  it("tags a skewer the engine's best move had with kind 'missed'", () => {
    // Re1+ would run e1-e5-e8: the king on e5 has to leave the file and drop the e8 queen.
    const tags = detect({ fen: '4q3/8/8/4k3/8/8/6P1/R6K w - - 0 1', move: 'g2g3', best: 'a1e1', reply: 'e5d4' });
    expect(tags).toEqual([{ name: 'skewer', kind: 'missed' }]);
  });

  it('adds no pin or skewer tags in a quiet position', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(detect({ fen, move: 'a2a3', best: 'e2e4', reply: 'e7e5', classification: 'mistake' })).toEqual([]);
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
