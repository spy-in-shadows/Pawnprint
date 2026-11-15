import { describe, it, expect } from 'vitest';
import { ecoByGameId } from '../scripts/reclassifyOpenings.js';

describe('ecoByGameId', () => {
  it('maps each exported game to its ECO code', () => {
    const pgn = [
      '[Event "Rated blitz game"]',
      '[Site "https://lichess.org/abcd1234"]',
      '[ECO "B90"]',
      '[Opening "Sicilian Defense: Najdorf Variation"]',
      '',
      '1-0',
      '',
      '[Event "Rated rapid game"]',
      '[Site "https://lichess.org/zzzz9999"]',
      '[GameId "wxyz5678"]',
      '[ECO "C42"]',
      '',
      '1/2-1/2',
      '',
    ].join('\n');

    const result = ecoByGameId(pgn);
    expect(result.get('abcd1234')).toBe('B90');
    expect(result.get('wxyz5678')).toBe('C42');
    expect(result.size).toBe(2);
  });

  it('skips games without a usable ECO header', () => {
    const pgn = '[Site "https://lichess.org/abcd1234"]\n[ECO "?"]\n\n*\n\n[Site "https://lichess.org/efgh5678"]\n\n*\n';
    expect(ecoByGameId(pgn).size).toBe(0);
  });

  it('returns an empty map for empty input', () => {
    expect(ecoByGameId('').size).toBe(0);
  });
});
