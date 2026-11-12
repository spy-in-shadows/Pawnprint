import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import * as userRepo from '../repositories/user.repo.js';
import { ValidationError, ConflictError, UnauthorizedError } from '../utils/errors.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_SALT_ROUNDS = 10;
const INVALID_CREDENTIALS_MSG = 'Invalid email or password';

export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export function generateToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export async function register(rawEmail, password) {
  const email = normalizeEmail(rawEmail);

  if (!email || !EMAIL_REGEX.test(email)) {
    throw new ValidationError('Invalid email format');
  }

  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }

  const existing = await userRepo.findByEmail(email);
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  const created = await userRepo.create({ email, passwordHash });

  const user = { id: created.id, email: created.email };
  const token = generateToken(user);

  return { token, user };
}

export async function login(rawEmail, password) {
  const email = normalizeEmail(rawEmail);

  if (!email || typeof password !== 'string') {
    throw new UnauthorizedError(INVALID_CREDENTIALS_MSG);
  }

  const userRecord = await userRepo.findByEmail(email);
  if (!userRecord) {
    // Avoid user enumeration
    throw new UnauthorizedError(INVALID_CREDENTIALS_MSG);
  }

  const isMatch = await bcrypt.compare(password, userRecord.passwordHash);
  if (!isMatch) {
    throw new UnauthorizedError(INVALID_CREDENTIALS_MSG);
  }

  const user = { id: userRecord.id, email: userRecord.email };
  const token = generateToken(user);

  return { token, user };
}

export const authService = {
  register,
  login,
  verifyToken,
  generateToken,
};

export default authService;
