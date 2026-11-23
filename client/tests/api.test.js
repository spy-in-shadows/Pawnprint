import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../src/lib/api';
import { setSession, getSession, resetSessionForTests } from '../src/lib/session';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const UNAUTHORIZED = jsonResponse(401, { error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } });

describe('client api module', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    resetSessionForTests();
    globalThis.window = { location: { pathname: '/games', href: '/games' } };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    vi.restoreAllMocks();
  });

  it('prefixes the path with /api/v1 when a relative path is passed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    await api.get('/games');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/v1/games');
  });

  it('attaches the in-memory access token as a Bearer header', async () => {
    setSession('test-auth-jwt', { id: 1 });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { user: 'ok' }));
    await api.get('/profile');
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-auth-jwt');
    expect(options.credentials).toBe('same-origin');
  });

  it('converts an error response shape into an Error with message, code and status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: { message: 'Invalid game format', code: 'VALIDATION_ERROR' } })
    );
    await expect(api.post('/import', { pgn: 'bad' })).rejects.toMatchObject({
      message: 'Invalid game format',
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('on a 401 refreshes once and retries the request with the new token', async () => {
    setSession('expired-token', { id: 1, email: 'a@example.com' });
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/v1/auth/refresh') {
        return jsonResponse(200, { token: 'fresh-token', user: { id: 1, email: 'a@example.com', role: 'user' } });
      }
      return globalThis.fetch.mock.calls.filter(([u]) => u === '/api/v1/games').length === 1
        ? UNAUTHORIZED
        : jsonResponse(200, { items: [] });
    });

    await expect(api.get('/games')).resolves.toEqual({ items: [] });

    const calls = globalThis.fetch.mock.calls;
    expect(calls.map(([u]) => u)).toEqual(['/api/v1/games', '/api/v1/auth/refresh', '/api/v1/games']);
    expect(calls[0][1].headers.Authorization).toBe('Bearer expired-token');
    expect(calls[1][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
    expect(calls[2][1].headers.Authorization).toBe('Bearer fresh-token');
    expect(getSession()).toEqual({ token: 'fresh-token', user: { id: 1, email: 'a@example.com', role: 'user' } });
    expect(globalThis.window.location.href).toBe('/games');
  });

  it('concurrent 401s share one refresh request', async () => {
    setSession('expired-token', { id: 1 });
    let refreshes = 0;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url === '/api/v1/auth/refresh') {
        refreshes += 1;
        return jsonResponse(200, { token: 'fresh-token', user: { id: 1 } });
      }
      return options.headers.Authorization === 'Bearer fresh-token' ? jsonResponse(200, { ok: true }) : UNAUTHORIZED;
    });
    await Promise.all([api.get('/games'), api.get('/accounts'), api.get('/analytics/summary')]);
    expect(refreshes).toBe(1);
  });

  it('when refresh fails it clears the session and redirects to /login', async () => {
    setSession('expired-token', { id: 1 });
    globalThis.fetch = vi.fn(async (url) =>
      url === '/api/v1/auth/refresh'
        ? jsonResponse(401, { error: { message: 'Refresh token expired', code: 'UNAUTHORIZED' } })
        : UNAUTHORIZED
    );

    await expect(api.get('/games')).rejects.toMatchObject({ status: 401 });
    expect(globalThis.fetch.mock.calls.map(([u]) => u)).toEqual(['/api/v1/games', '/api/v1/auth/refresh']);
    expect(getSession()).toEqual({ token: null, user: null });
    expect(globalThis.window.location.href).toBe('/login');
  });

  it('a 401 from login does not trigger a refresh or a redirect', async () => {
    globalThis.window.location = { pathname: '/login', href: '/login' };
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: 'Invalid email or password', code: 'UNAUTHORIZED' } })
    );
    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toThrow('Invalid email or password');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
