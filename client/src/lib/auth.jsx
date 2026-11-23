import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getSession, setSession, subscribe, restoreSession, logoutSession } from './session';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(getSession);
  // false until the startup refresh has answered, so protected pages do not bounce to /login
  // while a valid refresh cookie is being exchanged.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribe(setSessionState);
    let active = true;
    restoreSession().finally(() => {
      if (active) {
        setSessionState(getSession());
        setReady(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback((nextToken, nextUser) => {
    setSession(nextToken, nextUser);
  }, []);

  const logout = useCallback(() => logoutSession(), []);

  const value = {
    token: session.token,
    user: session.user,
    login,
    logout,
    ready,
    isAuthenticated: !!session.token,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
