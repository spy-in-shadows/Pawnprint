import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStoredToken, clearStoredToken } from '../src/lib/api';

describe('auth storage resilience', () => {
  const originalLocalStorage = globalThis.localStorage;

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
    vi.restoreAllMocks();
  });

  it('works safely when localStorage.getItem throws', () => {
    globalThis.localStorage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError: The operation is insecure');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(() => {
      const token = getStoredToken();
      expect(token).toBeNull();
    }).not.toThrow();
  });

  it('works safely when localStorage.removeItem throws', () => {
    globalThis.localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error('QuotaExceeded or disabled storage');
      }),
    };

    expect(() => {
      clearStoredToken();
    }).not.toThrow();
  });
});

