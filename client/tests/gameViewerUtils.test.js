import { describe, it, expect } from 'vitest';
import {
  getClassificationSymbol,
  winProbability,
  uciToSan,
  buildPlyFens,
  buildWinProbabilitySeries,
} from '../src/lib/gameViewerUtils';

describe('gameViewerUtils pure logic', () => {
  describe('classification symbol mapping', () => {
    it('maps classifications to their conventional chess annotation symbols', () => {
      expect(getClassificationSymbol('best')).toBe('');
      expect(getClassificationSymbol('good')).toBe('');
      expect(getClassificationSymbol('inaccuracy')).toBe('?!');
      expect(getClassificationSymbol('mistake')).toBe('?');
      expect(getClassificationSymbol('blunder')).toBe('??');
      expect(getClassificationSymbol('UNKNOWN')).toBe('');
      expect(getClassificationSymbol(null)).toBe('');
    });
  });

  describe('winProbability', () => {
    it('returns 50 for 0 cp', () => {
      expect(winProbability(0)).toBeCloseTo(50, 1);
    });

    it('returns ~75% for +300 cp and ~25% for -300 cp', () => {
      expect(winProbability(300)).toBeGreaterThan(70);
      expect(winProbability(300)).toBeLessThan(80);
      expect(winProbability(-300)).toBeGreaterThan(20);
      expect(winProbability(-300)).toBeLessThan(30);
    });

    it('clamps win probability to 1000 cap', () => {
      const atCap = winProbability(1000);
      const aboveCap = winProbability(5000);
      expect(atCap).toBeCloseTo(aboveCap, 5);
    });
  });

  describe('uciToSan', () => {
    it('converts UCI e2e4 to e4 from starting position', () => {
      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(uciToSan(startFen, 'e2e4')).toBe('e4');
      expect(uciToSan(startFen, 'g1f3')).toBe('Nf3');
    });

    it('handles promotions', () => {
      const promoFen = '8/4P3/8/8/8/8/8/4K2k w - - 0 1';
      expect(uciToSan(promoFen, 'e7e8q')).toBe('e8=Q');
    });

    it('returns original uci if fen or move is invalid', () => {
      expect(uciToSan(null, 'e2e4')).toBe('e2e4');
      expect(uciToSan('invalid-fen', 'e2e4')).toBe('e2e4');
    });
  });

  describe('buildPlyFens', () => {
    it('returns array of FENs matching plies 0..N', () => {
      const moves = [
        {
          ply: 1,
          san: 'e4',
          uci: 'e2e4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        },
        {
          ply: 2,
          san: 'e5',
          uci: 'e7e5',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        },
      ];

      const fens = buildPlyFens(moves);
      expect(fens).toHaveLength(3);
      expect(fens[0]).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      expect(fens[1]).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
      // After 2. ... e5
      expect(fens[2]).toContain('4p3');
    });
  });

  describe('buildWinProbabilitySeries', () => {
    it('constructs Recharts series data from White perspective', () => {
      const moves = [
        {
          ply: 1,
          san: 'e4',
          moverColor: 'white',
          eval: { evalBeforeCp: 20, evalAfterCp: 35 },
          classification: 'good',
        },
        {
          ply: 2,
          san: 'e5',
          moverColor: 'black',
          eval: { evalBeforeCp: 35, evalAfterCp: 30 },
          classification: 'best',
        },
        {
          ply: 3,
          san: 'f4',
          moverColor: 'white',
          eval: { evalBeforeCp: 30, evalAfterCp: -150 },
          classification: 'inaccuracy',
        },
      ];

      const series = buildWinProbabilitySeries(moves);
      expect(series).toHaveLength(4);
      expect(series[0].ply).toBe(0);
      expect(series[0].san).toBe('Start');
      expect(series[0].evalCp).toBe(20);

      expect(series[1].ply).toBe(1);
      expect(series[1].san).toBe('e4');
      expect(series[1].evalCp).toBe(35);
      expect(series[1].symbol).toBe('');

      expect(series[3].ply).toBe(3);
      expect(series[3].symbol).toBe('?!');
      expect(series[3].winProbability).toBeLessThan(50);
    });
  });
});
