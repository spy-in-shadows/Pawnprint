import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, apiRequest } from '../src/lib/api';

describe('client api module', () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  let mockStorage = {};

  beforeEach(() => {
    mockStorage = {};
    globalThis.localStorage = {
      getItem: vi.fn((key) => mockStorage[key] || null),
      setItem: vi.fn((key, value) => {
        mockStorage[key] = String(value);
      }),
      removeItem: vi.fn((key) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    vi.restoreAllMocks();
  });

  it('prefixes the path with /api/v1 when a relative path is passed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    await api.get('/games');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/v1/games');
  });

  it('attaches the Authorization Bearer token when stored in localStorage', async () => {
    mockStorage['token'] = 'test-auth-jwt';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ user: 'ok' }),
    });

    await api.get('/profile');
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers['Authorization']).toBe('Bearer test-auth-jwt');
  });

  it('converts an error response shape into an Error with message, code and status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({
        error: {
          message: 'Invalid game format',
          code: 'VALIDATION_ERROR',
        },
      }),
    });

    await expect(api.post('/import', { pgn: 'bad' })).rejects.toMatchObject({
      message: 'Invalid game format',
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('handles 401 unauthorized by clearing the stored token', async () => {
    mockStorage['token'] = 'expired-token';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      json: async () => ({
        error: {
          message: 'Token expired',
          code: 'UNAUTHORIZED',
        },
      }),
    });

    await expect(api.get('/protected-resource')).rejects.toThrow('Token expired');
    expect(localStorage.removeItem).toHaveBeenCalledWith('token');
    expect(mockStorage['token']).toBeUndefined();
  });
});

