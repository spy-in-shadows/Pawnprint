import { describe, it, expect } from 'vitest';
import { prepareDrill } from '../src/services/drill.js';

describe('Drill preparation service', () => {
  it('prepares drill from real row 00008 according to Lichess convention', () => {
    const puzzle = {
      id: 8,
      lichessId: '00008',
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
      movesUci: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
      rating: 1819,
    };

    const drill = prepareDrill(puzzle);

    expect(drill.setupMove).toBe('f2g3');
    expect(drill.solverColor).toBe('white');
    expect(drill.solverMoves).toEqual(['e6e7', 'b3c1', 'h6c1']);
    expect(drill.opponentReplies).toEqual(['b2b1', 'b1c1']);
    expect(drill.startFen).toBe('r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25');
  });

  it('throws for an illegal move in a puzzle', () => {
    const invalidPuzzle = {
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
      movesUci: 'e7e6 e6e7', // e7e6 is illegal as first move for black in that position
    };

    expect(() => prepareDrill(invalidPuzzle)).toThrow(/Illegal/);
  });

  it('throws for an empty move list or missing FEN', () => {
    expect(() => prepareDrill({ fen: '' })).toThrow();
    expect(() => prepareDrill({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', movesUci: '' })).toThrow();
  });
});
