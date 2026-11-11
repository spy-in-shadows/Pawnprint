import { describe, expect, it } from 'vitest';
import {
  EVAL_CAP_CP, MATE_CP, evaluateMoveQuality, mateToCp, perspective, winProbability,
} from '../src/chess/evalMath.js';

// Inverse of winProbability: the White-perspective eval after a move from 0 cp that drops White's
// win probability by exactly `drop` points.
function evalForDrop(drop) {
  return -Math.log(100 / (50 - drop) - 1) / 0.00368208;
}

const quality = (evalBeforeCp, evalAfterCp, moverColor = 'white') =>
  evaluateMoveQuality({ evalBeforeCp, evalAfterCp, moverColor });

describe('constants', () => {
  it('match the contract', () => {
    expect(MATE_CP).toBe(10000);
    expect(EVAL_CAP_CP).toBe(1000);
  });
});

describe('perspective', () => {
  it('keeps White evals and negates them for Black', () => {
    expect(perspective(150, 'white')).toBe(150);
    expect(perspective(150, 'black')).toBe(-150);
    expect(perspective(-80, 'black')).toBe(80);
    expect(perspective(0, 'black')).toBe(0);
  });

  it('accepts any letter case and rejects unknown colors', () => {
    expect(perspective(42, 'WHITE')).toBe(42);
    expect(perspective(42, 'Black')).toBe(-42);
    expect(() => perspective(42, 'w')).toThrow(TypeError);
  });
});

describe('mateToCp', () => {
  it('maps mate distances to bounded centipawns, faster mates higher', () => {
    expect(mateToCp(1)).toBe(9990);
    expect(mateToCp(3)).toBe(9970);
    expect(mateToCp(-2)).toBe(-9980);
    expect(mateToCp(1)).toBeGreaterThan(mateToCp(3));
  });

  it('signs a delivered mate by the mover', () => {
    expect(mateToCp(0, 'white')).toBe(MATE_CP);
    expect(mateToCp(0, 'black')).toBe(-MATE_CP);
  });

  it('returns 0 when there is no mate', () => {
    expect(mateToCp(null)).toBe(0);
    expect(mateToCp(undefined)).toBe(0);
  });

  it('never drops a very long mate below the eval cap', () => {
    expect(mateToCp(950)).toBe(EVAL_CAP_CP);
    expect(mateToCp(-950)).toBe(-EVAL_CAP_CP);
  });
});

describe('winProbability', () => {
  it('is 50 at equality and symmetric around it', () => {
    expect(winProbability(0)).toBe(50);
    expect(winProbability(300)).toBeCloseTo(75.11, 2);
    expect(winProbability(-300)).toBeCloseTo(24.89, 2);
    expect(winProbability(1000)).toBeCloseTo(97.54, 2);
    expect(winProbability(-1000)).toBeCloseTo(2.46, 2);
  });

  it('increases monotonically with the eval', () => {
    let previous = -Infinity;
    for (let cp = -1000; cp <= 1000; cp += 25) {
      const wp = winProbability(cp);
      expect(wp).toBeGreaterThan(previous);
      previous = wp;
    }
  });

  it('caps evals at +-1000 cp', () => {
    expect(winProbability(5000)).toBe(winProbability(1000));
    expect(winProbability(-MATE_CP)).toBe(winProbability(-1000));
  });
});

describe('evaluateMoveQuality', () => {
  it('reports the loss in the mover perspective and ignores gains', () => {
    expect(quality(50, -250)).toMatchObject({ cpLoss: 300, classification: 'blunder' });
    expect(quality(50, 120)).toEqual({ cpLoss: 0, wpDrop: 0, classification: 'best' });
  });

  it('caps both evals before measuring loss', () => {
    expect(quality(2500, 1500)).toEqual({ cpLoss: 0, wpDrop: 0, classification: 'best' });
    expect(quality(1800, 700).cpLoss).toBe(300);
  });

  it.each([
    [0.99, 'best'],
    [1, 'good'],
    [4.99, 'good'],
    [5, 'inaccuracy'],
    [9.99, 'inaccuracy'],
    [10, 'mistake'],
    [19.99, 'mistake'],
    [20, 'blunder'],
  ])('classifies a win-probability drop of %d as %s', (drop, classification) => {
    expect(quality(0, evalForDrop(drop))).toMatchObject({ wpDrop: drop, classification });
  });

  it('does not flag a move that keeps a forced mate, even a slower one', () => {
    expect(quality(mateToCp(2), mateToCp(4))).toEqual({ cpLoss: 0, wpDrop: 0, classification: 'best' });
  });

  it('flags losing a forced mate as a blunder', () => {
    const result = quality(mateToCp(1), 0);
    expect(result.classification).toBe('blunder');
    expect(result.cpLoss).toBe(EVAL_CAP_CP);
    expect(result.wpDrop).toBeCloseTo(47.54, 2);
  });

  it('treats delivering mate as the best move', () => {
    expect(quality(mateToCp(1), mateToCp(0, 'white'))).toMatchObject({ classification: 'best', cpLoss: 0 });
    expect(quality(mateToCp(-1), mateToCp(0, 'black'), 'black')).toMatchObject({ classification: 'best', cpLoss: 0 });
  });

  it('flags allowing a forced mate from an equal position as a blunder', () => {
    expect(quality(0, mateToCp(-3)).classification).toBe('blunder');
    expect(quality(0, mateToCp(3), 'black').classification).toBe('blunder');
  });

  it('gives identical output for Black when colors and signs are flipped', () => {
    const pairs = [[0, -40], [35, -120], [200, -150], [-60, -700], [mateToCp(2), 0], [1500, 300], [0, mateToCp(-1)]];
    for (const [before, after] of pairs) {
      expect(quality(-before, -after, 'black')).toEqual(quality(before, after, 'white'));
    }
  });
});
