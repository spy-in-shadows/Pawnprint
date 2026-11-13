import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

function engineKey(engine) {
  if (!engine.engineName) {
    throw new Error('Engine must be initialized before its version is registered');
  }
  return {
    name: engine.engineName,
    version: engine.engineVersion ?? 'unknown',
    defaultDepth: engine.depth,
    threads: engine.threads,
    hashSize: engine.hashSize,
  };
}

function isUniqueViolation(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function findEngineVersion(key) {
  return prisma.engineVersion.findUnique({
    where: { name_version_defaultDepth_threads_hashSize: key },
    select: { id: true },
  });
}

// engine_versions rows are immutable: evals point at them, so an existing row is only ever read.
export async function registerEngineVersion(engine) {
  const key = engineKey(engine);
  const existing = await findEngineVersion(key);
  if (existing) return existing.id;

  try {
    const created = await prisma.engineVersion.create({ data: key, select: { id: true } });
    return created.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findEngineVersion(key);
    if (!winner) throw err;
    return winner.id;
  }
}
