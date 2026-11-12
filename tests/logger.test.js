import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let logger;

async function loadLogger(logLevel = 'debug') {
  vi.resetModules();
  vi.doMock('../src/config/env.js', () => ({
    default: {
      port: 3000, nodeEnv: 'test', databaseUrl: 'postgresql://x',
      jwtSecret: 's', jwtExpiresIn: '7d', stockfishPath: '/usr/bin/stockfish',
      engineDepth: 12, engineThreads: 1, engineHashMb: 64, pgPoolMax: 10,
      logLevel, jobStaleSeconds: 120,
    },
  }));
  const mod = await import('../src/utils/logger.js');
  return mod.logger;
}

function capture(fn) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(chunk);
    return true;
  });
  fn();
  spy.mockRestore();
  return lines.map((l) => JSON.parse(l.replace(/\n$/, '')));
}

describe('logger', () => {
  describe('level filtering', () => {
    it('suppresses debug when level is info', async () => {
      const log = await loadLogger('info');
      const records = capture(() => {
        log.debug('should not appear');
        log.info('should appear');
      });
      expect(records).toHaveLength(1);
      expect(records[0].level).toBe('info');
      expect(records[0].msg).toBe('should appear');
    });

    it('suppresses info and debug when level is warn', async () => {
      const log = await loadLogger('warn');
      const records = capture(() => {
        log.debug('no');
        log.info('no');
        log.warn('yes');
        log.error('yes');
      });
      expect(records).toHaveLength(2);
      expect(records[0].level).toBe('warn');
      expect(records[1].level).toBe('error');
    });

    it('emits all levels when level is debug', async () => {
      const log = await loadLogger('debug');
      const records = capture(() => {
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
      });
      expect(records).toHaveLength(4);
    });
  });

  describe('JSON shape', () => {
    it('emits ts, level, msg, and meta fields', async () => {
      const log = await loadLogger('debug');
      const records = capture(() => log.info('test', { userId: 42 }));
      expect(records).toHaveLength(1);
      const r = records[0];
      expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.level).toBe('info');
      expect(r.msg).toBe('test');
      expect(r.userId).toBe(42);
    });
  });

  describe('error serialization', () => {
    it('serializes meta.err as {name, message, stack}', async () => {
      const log = await loadLogger('debug');
      const err = new TypeError('boom');
      const records = capture(() => log.error('failed', { err }));
      expect(records).toHaveLength(1);
      const serialized = records[0].err;
      expect(serialized.name).toBe('TypeError');
      expect(serialized.message).toBe('boom');
      expect(typeof serialized.stack).toBe('string');
    });
  });

  describe('redaction', () => {
    it('redacts password, token, authorization, and jwt', async () => {
      const log = await loadLogger('debug');
      const records = capture(() =>
        log.info('auth', {
          password: 'secret',
          token: 'abc',
          authorization: 'Bearer xyz',
          jwt: 'ey...',
          safe: 'visible',
        })
      );
      expect(records).toHaveLength(1);
      const r = records[0];
      expect(r.password).toBe('[redacted]');
      expect(r.token).toBe('[redacted]');
      expect(r.authorization).toBe('[redacted]');
      expect(r.jwt).toBe('[redacted]');
      expect(r.safe).toBe('visible');
    });
  });

  describe('child logger', () => {
    it('merges base meta into every log call', async () => {
      const log = await loadLogger('debug');
      const child = log.child({ component: 'worker', workerId: 1 });
      const records = capture(() => child.info('started', { jobId: 7 }));
      expect(records).toHaveLength(1);
      const r = records[0];
      expect(r.component).toBe('worker');
      expect(r.workerId).toBe(1);
      expect(r.jobId).toBe(7);
    });

    it('call meta overrides child base meta', async () => {
      const log = await loadLogger('debug');
      const child = log.child({ phase: 'init' });
      const records = capture(() => child.info('override', { phase: 'run' }));
      expect(records[0].phase).toBe('run');
    });
  });
});
