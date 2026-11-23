import config from '../config/env.js';
import * as authService from '../services/auth.service.js';
import * as sessionService from '../services/session.service.js';

export const REFRESH_COOKIE = 'refresh_token';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/v1/auth',
    secure: config.nodeEnv === 'production',
  };
}

function setRefreshCookie(res, raw) {
  res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions(), maxAge: sessionService.refreshTtlMs() });
}

// Login, register and refresh all answer { token, user }; the refresh token travels only in the cookie.
async function respondWithSession(res, status, { token, user }) {
  const { refreshToken } = await sessionService.startSession(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(status).json({ token, user });
}

export async function register(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.register(email, password);
    await respondWithSession(res, 201, result);
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login(email, password);
    await respondWithSession(res, 200, result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const result = await sessionService.rotate(req.cookies?.[REFRESH_COOKIE]);
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ token: result.token, user: result.user });
  } catch (err) {
    if (err.status === 401) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
    }
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    await sessionService.revoke(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    res.status(200).json({
      user: {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
      },
    });
  } catch (err) {
    next(err);
  }
}

export const authController = {
  register,
  login,
  refresh,
  logout,
  me,
};

export default authController;
