import * as authService from '../services/auth.service.js';

export async function register(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.register(email, password);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login(email, password);
    res.status(200).json(result);
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
      },
    });
  } catch (err) {
    next(err);
  }
}

export const authController = {
  register,
  login,
  me,
};

export default authController;
