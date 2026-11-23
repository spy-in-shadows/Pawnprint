import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// CORS_ORIGINS: comma-separated list of origins allowed to call the API from another origin
// (for example http://localhost:5173 for the Vite dev server). Empty by default, which means
// same-origin only: the API serves the built client itself, so production needs no entries.
function parseList(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// TRUST_PROXY: how many reverse proxies sit in front of the app. 'false' (default) trusts none, so
// req.ip is the socket address; a number trusts that many hops of X-Forwarded-For; 'true' trusts all.
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  throw new Error(`TRUST_PROXY must be false, true or a number of proxy hops (got "${value}")`);
}

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  // Access tokens are short-lived JWTs; sessions last through rotating refresh tokens.
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 7,
  stockfishPath: process.env.STOCKFISH_PATH || '/opt/homebrew/bin/stockfish',
  engineDepth: Number(process.env.ENGINE_DEPTH) || 12,
  engineThreads: Number(process.env.ENGINE_THREADS) || 1,
  engineHashMb: Number(process.env.ENGINE_HASH_MB) || 64,
  pgPoolMax: Number(process.env.PG_POOL_MAX) || 10,
  logLevel: process.env.LOG_LEVEL || 'info',
  jobStaleSeconds: Number(process.env.JOB_STALE_SECONDS) || 120,
  corsOrigins: parseList(process.env.CORS_ORIGINS),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Development aid: log every Prisma query (text, params, duration). Params can include emails and
  // password hashes, so keep it off outside local debugging.
  prismaLogQueries: process.env.PRISMA_LOG_QUERIES === 'true',
};

export default config;

