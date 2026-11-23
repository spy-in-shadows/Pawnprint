import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSession, setSession, subscribe, restoreSession, logoutSession, resetSessionForTests,
} from '../src/lib/session';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('in-memory session', () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    resetSessionForTests();
    globalThis.localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    vi.restoreAllMocks();
  });

  it('never writes the access token to localStorage', () => {
    setSession('secret-access-token', { id: 1 });
    expect(getSession().token).toBe('secret-access-token');
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('restores the session on start with one refresh call, even if asked twice', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { token: 't1', user: { id: 7, email: 'u@example.com', role: 'user' } }));
    const [a, b] = await Promise.all([restoreSession(), restoreSession()]);
    expect(a).toBe('t1');
    expect(b).toBe('t1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/refresh', {
      method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' },
    });
    expect(getSession()).toEqual({ token: 't1', user: { id: 7, email: 'u@example.com', role: 'user' } });
    // Tokens left by the previous client version are removed.
    expect(localStorage.removeItem).toHaveBeenCalledWith('token');
    expect(localStorage.removeItem).toHaveBeenCalledWith('user');
  });

  it('starts logged out when there is no valid refresh cookie', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    await expect(restoreSession()).resolves.toBeNull();
    expect(getSession()).toEqual({ token: null, user: null });
  });

  it('works when localStorage throws', async () => {
    globalThis.localStorage = { removeItem: vi.fn(() => { throw new Error('SecurityError'); }) };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    await expect(restoreSession()).resolves.toBeNull();
  });

  it('logout calls POST /auth/logout and clears the session', async () => {
    setSession('t1', { id: 1 });
    const seen = [];
    subscribe((s) => seen.push(s));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    await logoutSession();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/logout', {
      method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' },
    });
    expect(getSession()).toEqual({ token: null, user: null });
    expect(seen.at(-1)).toEqual({ token: null, user: null });
  });

  it('logout clears the session even if the request fails', async () => {
    setSession('t1', { id: 1 });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await logoutSession();
    expect(getSession().token).toBeNull();
  });
});
