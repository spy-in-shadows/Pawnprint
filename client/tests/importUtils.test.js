import { describe, it, expect } from 'vitest';
import { validateDateRange, shouldStopPolling, calculateProgress } from '../src/lib/importUtils';

describe('importUtils pure logic', () => {
  describe('validateDateRange', () => {
    it('returns valid when either or both dates are empty', () => {
      expect(validateDateRange('', '')).toEqual({ valid: true, error: null });
      expect(validateDateRange('2026-01-01', '')).toEqual({ valid: true, error: null });
      expect(validateDateRange('', '2026-01-01')).toEqual({ valid: true, error: null });
    });

    it('returns valid when from date is before or equal to to date', () => {
      expect(validateDateRange('2026-01-01', '2026-01-02')).toEqual({ valid: true, error: null });
      expect(validateDateRange('2026-01-01', '2026-01-01')).toEqual({ valid: true, error: null });
    });

    it('returns invalid with error message when from date is strictly after to date', () => {
      const res = validateDateRange('2026-01-02', '2026-01-01');
      expect(res.valid).toBe(false);
      expect(res.error).toBe('From date cannot be after To date');
    });

    it('returns invalid when given an invalid date string', () => {
      const res = validateDateRange('not-a-date', '2026-01-01');
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Invalid date format');
    });
  });

  describe('shouldStopPolling', () => {
    it('returns true for completed and failed statuses', () => {
      expect(shouldStopPolling('completed')).toBe(true);
      expect(shouldStopPolling('COMPLETED')).toBe(true);
      expect(shouldStopPolling('failed')).toBe(true);
      expect(shouldStopPolling('FAILED')).toBe(true);
    });

    it('returns false for queued, running, or empty statuses', () => {
      expect(shouldStopPolling('queued')).toBe(false);
      expect(shouldStopPolling('QUEUED')).toBe(false);
      expect(shouldStopPolling('running')).toBe(false);
      expect(shouldStopPolling('RUNNING')).toBe(false);
      expect(shouldStopPolling('')).toBe(false);
      expect(shouldStopPolling(null)).toBe(false);
      expect(shouldStopPolling(undefined)).toBe(false);
    });
  });

  describe('calculateProgress', () => {
    it('returns 0 when total is 0, negative, or invalid', () => {
      expect(calculateProgress(0, 0)).toBe(0);
      expect(calculateProgress(5, 0)).toBe(0);
      expect(calculateProgress(5, -10)).toBe(0);
      expect(calculateProgress(5, null)).toBe(0);
      expect(calculateProgress(5, undefined)).toBe(0);
      expect(calculateProgress(5, NaN)).toBe(0);
    });

    it('calculates the rounded percentage correctly', () => {
      expect(calculateProgress(1, 3)).toBe(33);
      expect(calculateProgress(2, 4)).toBe(50);
      expect(calculateProgress(10, 10)).toBe(100);
    });

    it('clamps values between 0 and 100', () => {
      expect(calculateProgress(-5, 10)).toBe(0);
      expect(calculateProgress(15, 10)).toBe(100);
    });
  });
});
