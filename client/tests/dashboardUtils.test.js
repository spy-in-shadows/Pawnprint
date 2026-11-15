import { describe, it, expect } from 'vitest';
import {
  validateDateRange,
  shapeOpeningsData,
  shapePhasesData,
  shapeTimePressureData,
  shapeTrendData,
  shapeMotifsData,
  shapeSummaryMetrics,
  TIME_PRESSURE_BUCKET_ORDER,
} from '../src/lib/dashboardUtils';

describe('dashboardUtils pure logic', () => {
  describe('validateDateRange', () => {
    it('returns valid when both or either dates are empty', () => {
      expect(validateDateRange('', '')).toEqual({ valid: true, error: null });
      expect(validateDateRange('2026-01-01', '')).toEqual({ valid: true, error: null });
      expect(validateDateRange('', '2026-01-10')).toEqual({ valid: true, error: null });
    });

    it('returns valid when from is before or equal to to', () => {
      expect(validateDateRange('2026-01-01', '2026-01-02')).toEqual({ valid: true, error: null });
      expect(validateDateRange('2026-01-01', '2026-01-01')).toEqual({ valid: true, error: null });
    });

    it('returns error when from is strictly after to', () => {
      const res = validateDateRange('2026-01-05', '2026-01-01');
      expect(res.valid).toBe(false);
      expect(res.error).toBe('From date cannot be after To date');
    });

    it('returns error for invalid date formats', () => {
      expect(validateDateRange('invalid-date', '2026-01-01').valid).toBe(false);
      expect(validateDateRange('2026-01-01', 'not-a-date').valid).toBe(false);
    });
  });

  describe('shapeOpeningsData', () => {
    it('sorts openings by moves descending and limits to top 10 with ECO + name labels and ply bucket', () => {
      const input = Array.from({ length: 15 }, (_, i) => ({
        eco: `B${10 + i}`,
        name: `Opening ${i}`,
        plyBucket: '1-10',
        moves: (i + 1) * 10,
        blunders: i,
        blundersPer100: 5.5,
        avgCpLoss: 25.0,
      }));

      const shaped = shapeOpeningsData(input);
      expect(shaped).toHaveLength(10);
      expect(shaped[0].moves).toBe(150);
      expect(shaped[0].eco).toBe('B24');
      expect(shaped[0].displayName).toBe('B24 Opening 14 (1-10)');
      expect(shaped[0].shortName).toBe('B24 Opening 14');
      expect(shaped[9].moves).toBe(60);
    });

    it('reads the /analytics/openings row shape', () => {
      const input = [
        { eco: 'C50', name: 'Italian Game', plyBucket: '11-20', moves: 50, blunders: 2, blundersPer100: 4, avgCpLoss: 18.2 },
      ];
      const shaped = shapeOpeningsData(input);
      expect(shaped).toHaveLength(1);
      expect(shaped[0].displayName).toBe('C50 Italian Game (11-20)');
      expect(shaped[0].blundersPer100).toBe(4);
    });

    it('handles empty or malformed input safely', () => {
      expect(shapeOpeningsData([])).toEqual([]);
      expect(shapeOpeningsData(null)).toEqual([]);
    });
  });

  describe('shapePhasesData', () => {
    it('orders phases opening, middlegame, endgame and preserves moves count', () => {
      const input = [
        { phase: 'endgame', moves: 120, accuracyPct: 68.5, blunders: 5, avgCpLoss: 45.2 },
        { phase: 'opening', moves: 300, accuracyPct: 91.2, blunders: 1, avgCpLoss: 15.0 },
        { phase: 'middlegame', moves: 450, accuracyPct: 75.0, blunders: 12, avgCpLoss: 32.1 },
      ];

      const shaped = shapePhasesData(input);
      expect(shaped).toHaveLength(3);
      expect(shaped[0].phase).toBe('Opening');
      expect(shaped[0].moves).toBe(300);
      expect(shaped[0].accuracyPct).toBe(91.2);

      expect(shaped[1].phase).toBe('Middlegame');
      expect(shaped[1].moves).toBe(450);

      expect(shaped[2].phase).toBe('Endgame');
      expect(shaped[2].moves).toBe(120);
    });

    it('fills missing phases with 0', () => {
      const shaped = shapePhasesData([{ phase: 'opening', moves: 50, accuracyPct: 88 }]);
      expect(shaped).toHaveLength(3);
      expect(shaped[1].phase).toBe('Middlegame');
      expect(shaped[1].moves).toBe(0);
      expect(shaped[1].accuracyPct).toBe(0);
    });
  });

  describe('shapeTimePressureData', () => {
    it('enforces exact bucket order: >50%, 25-50%, 10-25%, <10%', () => {
      const unordered = [
        { bucket: '<10%', moves: 12, blunders: 4, blundersPer100: 33.3, avgCpLoss: 45 },
        { bucket: '>50%', moves: 100, blunders: 2, blundersPer100: 2.0, avgCpLoss: 15 },
        { bucket: '10-25%', moves: 30, blunders: 5, blundersPer100: 16.6, avgCpLoss: 30 },
      ];

      const shaped = shapeTimePressureData(unordered);
      expect(shaped.map((s) => s.bucket)).toEqual(TIME_PRESSURE_BUCKET_ORDER);

      expect(shaped[0]).toEqual({
        bucket: '>50%',
        moves: 100,
        blunders: 2,
        blundersPer100: 2.0,
        avgCpLoss: 15,
      });

      // Missing bucket '25-50%' should be present with 0s
      expect(shaped[1]).toEqual({
        bucket: '25-50%',
        moves: 0,
        blunders: 0,
        blundersPer100: 0,
        avgCpLoss: 0,
      });

      expect(shaped[2].bucket).toBe('10-25%');
      expect(shaped[3].bucket).toBe('<10%');
    });
  });

  describe('shapeTrendData', () => {
    it('shapes trend with raw and rolling accuracy', () => {
      const input = [
        { day: '2026-01-01', games: 3, accuracyPct: 75.5, avgCpLoss: 20, rollingAccuracyPct: 75.5 },
        { day: '2026-01-02', games: 4, accuracyPct: 85.0, avgCpLoss: 12, rollingAccuracyPct: 80.25 },
      ];

      const shaped = shapeTrendData(input);
      expect(shaped).toHaveLength(2);
      expect(shaped[0].date).toBe('2026-01-01');
      expect(shaped[0].accuracyPct).toBe(75.5);
      expect(shaped[0].rollingAccuracy).toBe(75.5);
      expect(shaped[1].rollingAccuracy).toBe(80.25);
      expect(shaped[1].games).toBe(4);
    });
  });

  describe('shapeMotifsData', () => {
    it('merges allowed and missed series for each motif labelled errors per 100 moves', () => {
      const rows = [
        { motif: 'fork', kind: 'allowed', errorCount: 4, totalMoves: 160, errorsPer100Moves: 2.5 },
        { motif: 'fork', kind: 'missed', errorCount: 6, totalMoves: 160, errorsPer100Moves: 3.75 },
        { motif: 'pin', kind: 'allowed', errorCount: 2, totalMoves: 160, errorsPer100Moves: 1.25 },
        { motif: 'hanging_piece', kind: 'missed', errorCount: 8, totalMoves: 160, errorsPer100Moves: 5.0 },
      ];

      const shaped = shapeMotifsData(rows);
      expect(shaped).toHaveLength(3);

      const fork = shaped.find((m) => m.motif === 'fork');
      expect(fork.allowed).toBe(2.5);
      expect(fork.missed).toBe(3.75);
      expect(fork.allowedCount).toBe(4);
      expect(fork.missedCount).toBe(6);
      expect(fork.totalErrors).toBe(10);
      expect(fork.displayName).toBe('fork');

      const pin = shaped.find((m) => m.motif === 'pin');
      expect(pin.allowed).toBe(1.25);
      expect(pin.missed).toBe(0);

      const hanging = shaped.find((m) => m.motif === 'hanging_piece');
      expect(hanging.displayName).toBe('hanging piece');
      expect(hanging.allowed).toBe(0);
      expect(hanging.missed).toBe(5.0);
    });
  });

  describe('shapeSummaryMetrics', () => {
    it('calculates aggregate summary across accounts correctly', () => {
      const summaryPayload = {
        accounts: [
          {
            accountId: 1,
            analyzedGames: 10,
            totalMoves: 400,
            blunders: 8,
            avgCpLoss: 25.0,
            accuracyPct: 80.0,
          },
          {
            accountId: 2,
            analyzedGames: 5,
            totalMoves: 200,
            blunders: 10,
            avgCpLoss: 40.0,
            accuracyPct: 70.0,
          },
        ],
      };

      const metrics = shapeSummaryMetrics(summaryPayload);
      expect(metrics.analyzedGames).toBe(15);
      expect(metrics.totalMoves).toBe(600);
      expect(metrics.blunders).toBe(18);
      // blundersPer100 = (18 / 600) * 100 = 3.0
      expect(metrics.blundersPer100).toBe(3.0);
      // avgCpLoss = (25*400 + 40*200) / 600 = (10000 + 8000) / 600 = 30.0
      expect(metrics.avgCpLoss).toBe(30.0);
      // accuracyPct = (80*400 + 70*200) / 600 = (32000 + 14000) / 600 = 76.7
      expect(metrics.accuracyPct).toBe(76.7);
    });

    it('handles single account summary object or null safely', () => {
      const single = {
        accountId: 1,
        analyzedGames: 12,
        totalMoves: 500,
        blunders: 5,
        avgCpLoss: 20.0,
        accuracyPct: 85.0,
      };

      const metrics = shapeSummaryMetrics(single);
      expect(metrics.analyzedGames).toBe(12);
      expect(metrics.blundersPer100).toBe(1.0);

      const empty = shapeSummaryMetrics(null);
      expect(empty.analyzedGames).toBe(0);
      expect(empty.accuracyPct).toBe(0);
    });
  });
});
