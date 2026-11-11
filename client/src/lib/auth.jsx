import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage might be unavailable or disabled
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => safeStorageGet('token'));
  const [user, setUser] = useState(() => {
    const raw = safeStorageGet('user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  const login = useCallback((nextToken, nextUser) => {
    setToken(nextToken);
    safeStorageSet('token', nextToken);
    if (nextUser) {
      setUser(nextUser);
      safeStorageSet('user', JSON.stringify(nextUser));
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    safeStorageRemove('token');
    safeStorageRemove('user');
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

