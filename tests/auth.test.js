import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import config from '../src/config/env.js';
import { prisma, pgPool } from '../src/config/db.js';

describe('Authentication endpoints and middleware', () => {
  let app;
  let server;
  let baseUrl;

  beforeAll(async () => {
    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('register returns a token and user with 201', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'player1@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('player1@example.com');
    expect(body.user.password_hash).toBeUndefined();
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('duplicate email returns 409 Conflict', async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'duplicate@example.com',
        password: 'password123',
      }),
    });

    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'duplicate@example.com',
        password: 'anotherpassword',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('concurrent registrations for the same email return 409 rather than 500', async () => {
    const payload = {
      email: 'concurrent@example.com',
      password: 'password123',
    };

    const requests = Array.from({ length: 3 }, () =>
      fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status).sort();

    // Exactly one should succeed with 201, and the others must return 409 Conflict (never 500)
    expect(statuses).toEqual([201, 409, 409]);
  });

  it('short password returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'shortpass@example.com',
        password: 'short',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('invalid email returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'not-an-email',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('login ok returns token and user', async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'loginok@example.com',
        password: 'password123',
      }),
    });

    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'loginok@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.user.email).toBe('loginok@example.com');
    expect(body.user.password_hash).toBeUndefined();
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('wrong password returns 401 with the same message as unknown email', async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'known@example.com',
        password: 'password123',
      }),
    });

    const resWrongPass = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'known@example.com',
        password: 'wrongpassword',
      }),
    });

    const resUnknownEmail = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unknown@example.com',
        password: 'password123',
      }),
    });

    expect(resWrongPass.status).toBe(401);
    expect(resUnknownEmail.status).toBe(401);

    const bodyWrong = await resWrongPass.json();
    const bodyUnknown = await resUnknownEmail.json();

    expect(bodyWrong.error.message).toBe(bodyUnknown.error.message);
  });

  it('/me without token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/me`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('/me with a garbage token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: 'Bearer this-is-not-a-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('/me with a valid token returns the user and no hash', async () => {
    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'meuser@example.com',
        password: 'password123',
      }),
    });
    const { token } = await regRes.json();

    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('meuser@example.com');
    expect(body.user.password_hash).toBeUndefined();
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('an expired token (expiresIn -1s) returns 401', async () => {
    const expiredToken = jwt.sign(
      { sub: 999, email: 'expired@example.com' },
      config.jwtSecret,
      { expiresIn: '-1s', algorithm: 'HS256' }
    );

    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
