import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Between tests: reset the module registry so env.js is re-executed with the
// current process.env rather than returning the cached module from the first load.
async function loadConfig(overrides) {
  vi.resetModules();
  const saved = { ...process.env };
  // Clear all non-essential vars so previous test values do not leak through.
  for (const key of Object.keys(process.env)) {
    if (!['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'PWD'].includes(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, overrides);
  try {
    const mod = await import('../src/config/env.js');
    return mod.default;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'PWD'].includes(key)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  }
}

describe('config loader', () => {
  it('throws when JWT_SECRET is missing', async () => {
    await expect(loadConfig({ DATABASE_URL: 'postgresql://x' })).rejects.toThrow(
      'Missing required environment variable: JWT_SECRET'
    );
  });

  it('throws when DATABASE_URL is missing', async () => {
    await expect(loadConfig({ JWT_SECRET: 'secret' })).rejects.toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });

  it('applies numeric defaults when optional vars are absent', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgresql://x', JWT_SECRET: 'secret' });
    expect(config.engineDepth).toBe(12);
    expect(config.engineThreads).toBe(1);
    expect(config.engineHashMb).toBe(64);
    expect(config.pgPoolMax).toBe(10);
    expect(config.jobStaleSeconds).toBe(120);
    expect(config.port).toBe(3000);
  });

  it('coerces numeric env vars from strings', async () => {
    const config = await loadConfig({
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: 'secret',
      PORT: '4000',
      ENGINE_DEPTH: '20',
      ENGINE_THREADS: '4',
      ENGINE_HASH_MB: '128',
      PG_POOL_MAX: '20',
      JOB_STALE_SECONDS: '300',
    });
    expect(config.port).toBe(4000);
    expect(config.engineDepth).toBe(20);
    expect(config.engineThreads).toBe(4);
    expect(config.engineHashMb).toBe(128);
    expect(config.pgPoolMax).toBe(20);
    expect(config.jobStaleSeconds).toBe(300);
  });
});
