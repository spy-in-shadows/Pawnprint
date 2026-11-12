import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  stockfishPath: process.env.STOCKFISH_PATH || '/opt/homebrew/bin/stockfish',
  engineDepth: Number(process.env.ENGINE_DEPTH) || 12,
  engineThreads: Number(process.env.ENGINE_THREADS) || 1,
  engineHashMb: Number(process.env.ENGINE_HASH_MB) || 64,
  pgPoolMax: Number(process.env.PG_POOL_MAX) || 10,
  logLevel: process.env.LOG_LEVEL || 'info',
  jobStaleSeconds: Number(process.env.JOB_STALE_SECONDS) || 120,
};

export default config;

