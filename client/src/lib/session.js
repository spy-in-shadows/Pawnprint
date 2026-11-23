// In-memory session: the access token never touches localStorage. The refresh token lives in an
// httpOnly cookie the browser sends only to /api/v1/auth, so a reload restores the session by
// calling POST /auth/refresh.

const REFRESH_URL = '/api/v1/auth/refresh';
const LOGOUT_URL = '/api/v1/auth/logout';
// CSRF defence expected by the server on the cookie endpoints.
const COOKIE_REQUEST = { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } };

let state = { token: null, user: null };
const listeners = new Set();
let refreshInFlight = null;
let restorePromise = null;

function emit() {
  for (const listener of listeners) listener(state);
}

export function getSession() {
  return state;
}

export function getAccessToken() {
  return state.token;
}

export function setSession(token, user) {
  state = { token, user: user ?? state.user };
  emit();
}

export function clearSession() {
  state = { token: null, user: null };
  emit();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Exchange the refresh cookie for a new access token. Concurrent callers share one request:
// the server rotates the cookie on every refresh and treats a second use of the old one as theft.
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(REFRESH_URL, COOKIE_REQUEST);
        if (!res.ok) {
          clearSession();
          return null;
        }
        const body = await res.json();
        setSession(body.token, body.user);
        return body.token;
      } catch {
        clearSession();
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

// Called once on app start; later calls return the same promise.
export function restoreSession() {
  if (!restorePromise) {
    // Tokens from the previous client version were kept in localStorage; drop them.
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch {
      // Storage unavailable: nothing to clean up.
    }
    restorePromise = refreshSession();
  }
  return restorePromise;
}

export async function logoutSession() {
  try {
    await fetch(LOGOUT_URL, COOKIE_REQUEST);
  } catch {
    // The local session is cleared regardless; the server-side token expires on its own.
  } finally {
    clearSession();
  }
}

// Test helper.
export function resetSessionForTests() {
  state = { token: null, user: null };
  listeners.clear();
  refreshInFlight = null;
  restorePromise = null;
}
