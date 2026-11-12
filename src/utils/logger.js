import config from '../config/env.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const REDACT_KEYS = new Set(['password', 'token', 'authorization', 'jwt']);

function serializeError(err) {
  if (!err || typeof err !== 'object') return err;
  return { name: err.name, message: err.message, stack: err.stack };
}

function redact(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

function createLogger(baseMeta = {}) {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

  function write(level, msg, meta = {}) {
    if (LEVELS[level] < threshold) return;
    const merged = { ...baseMeta, ...meta };
    const safe = redact(merged);
    if (safe.err && typeof safe.err === 'object') {
      safe.err = serializeError(safe.err);
    }
    const record = { ts: new Date().toISOString(), level, msg, ...safe };
    process.stdout.write(JSON.stringify(record) + '\n');
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (childMeta) => createLogger({ ...baseMeta, ...childMeta }),
  };
}

export const logger = createLogger();
