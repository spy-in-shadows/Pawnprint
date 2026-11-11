import { describe, expect, it } from 'vitest';
import { classifyPhase } from '../src/chess/phase.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const QUEENS_OFF = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1';

describe('classifyPhase', () => {
  it('treats the start position at ply 1 as opening', () => {
    expect(classifyPhase(START, 1)).toBe('opening');
  });

  it('treats the last opening ply and the first one after it correctly', () => {
    expect(classifyPhase(START, 20)).toBe('opening');
    expect(classifyPhase(START, 21)).toBe('middlegame');
  });

  it('treats the start position at ply 25 as middlegame', () => {
    expect(classifyPhase(START, 25)).toBe('middlegame');
  });

  it('treats an early queen trade with lots of material left as middlegame', () => {
    expect(classifyPhase(QUEENS_OFF, 10)).toBe('middlegame');
  });

  it('treats K+R vs K+R as endgame', () => {
    expect(classifyPhase('4k2r/8/8/8/8/8/8/R3K3 w - - 0 1', 60)).toBe('endgame');
  });

  it('calls endgame at a total of exactly 24 even on an early ply', () => {
    // White Q+R = 14, Black R+R = 10
    expect(classifyPhase('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R2QK3 w - - 0 1', 30)).toBe('endgame');
    // White Q+N = 12, Black q+b = 12, both queens on board at ply 10
    expect(classifyPhase('2bqk3/pppppppp/8/8/8/8/PPPPPPPP/1N1QK3 w - - 0 1', 10)).toBe('endgame');
  });

  it('does not call endgame at a total of 25', () => {
    // White Q+R+B = 17, Black R+N = 8
    const fen = 'r3k1n1/pppppppp/8/8/8/8/PPPPPPPP/R1BQK3 w - - 0 1';
    expect(classifyPhase(fen, 30)).toBe('middlegame');
    // Black has no queen, so even an early ply is not opening
    expect(classifyPhase(fen, 5)).toBe('middlegame');
  });

  it('counts upper- and lower-case pieces the same way', () => {
    const allWhite = '4k3/8/8/8/8/8/8/RNBQKBNR w - - 0 1'; // 31
    const allBlack = 'rnbqkbnr/8/8/8/8/8/8/4K3 w - - 0 1'; // 31
    expect(classifyPhase(allWhite, 30)).toBe('middlegame');
    expect(classifyPhase(allBlack, 30)).toBe('middlegame');
    // Q+R+B = 17 on one side, 8 on the other: 25 either way round
    expect(classifyPhase('R1BQK3/8/8/8/8/8/8/r3k1n1 w - - 0 1', 30)).toBe('middlegame');
    expect(classifyPhase('r1bqk3/8/8/8/8/8/8/R3K1N1 w - - 0 1', 30)).toBe('middlegame');
  });

  it('needs a queen of each colour for opening, not two queens of one colour', () => {
    expect(classifyPhase('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKQNR w - - 0 1', 10)).toBe('middlegame');
  });

  it('ignores pawns, kings and the non-placement fields', () => {
    expect(classifyPhase('4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1', 1)).toBe('endgame');
    expect(classifyPhase(`  ${START}  `, 1)).toBe('opening');
  });

  it('rejects a non-string fen', () => {
    expect(() => classifyPhase(null, 1)).toThrow(TypeError);
  });
});
