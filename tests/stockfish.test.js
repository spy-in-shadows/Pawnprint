import { EventEmitter } from 'node:events';
import { accessSync, constants } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/env.js';
import { StockfishClient } from '../src/chess/stockfishClient.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Answers the handshake like a real engine and records every command it receives.
function fakeSpawn(commands) {
  return () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _enc, done) {
        for (const command of chunk.toString().split('\n').filter(Boolean)) {
          commands.push(command);
          if (command === 'uci') child.stdout.write('id name Stockfish 17\nuciok\n');
          if (command === 'isready') child.stdout.write('readyok\n');
        }
        done();
      },
    });
    child.kill = (signal) => {
      child.signalCode = signal;
      setImmediate(() => child.emit('close', null, signal));
    };
    return child;
  };
}

describe('StockfishClient with a fake engine process', () => {
  it('sends uci, both setoption lines and isready in that order', async () => {
    const commands = [];
    const engine = new StockfishClient({ threads: 1, hashSize: 64, spawnFn: fakeSpawn(commands) });
    await engine.init();
    expect(commands).toEqual(['uci', 'setoption name Threads value 1', 'setoption name Hash value 64', 'isready']);
    expect(engine.engineName).toBe('Stockfish');
    expect(engine.engineVersion).toBe('17');
    await engine.quit();
  });

  it('rejects an invalid FEN with DataError and sends nothing to the engine', async () => {
    const commands = [];
    const engine = new StockfishClient({ spawnFn: fakeSpawn(commands) });
    await engine.init();
    commands.length = 0;
    await expect(engine.evaluatePosition('not a fen')).rejects.toMatchObject({ name: 'DataError', isDataError: true });
    await expect(engine.evaluatePosition('8/8/8/8/8/8/8/8 w - - 0 1')).rejects.toMatchObject({ name: 'DataError' });
    expect(commands).toEqual([]);
    await engine.quit();
  });

  it('reports a clear EngineError when the binary cannot be spawned', async () => {
    const engine = new StockfishClient({ binaryPath: '/nonexistent/stockfish' });
    await expect(engine.init()).rejects.toMatchObject({ name: 'EngineError', message: expect.stringMatching(/STOCKFISH_PATH/) });
    expect(engine.isReady).toBe(false);
  });
});

function binaryAvailable() {
  try {
    accessSync(config.stockfishPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const hasBinary = binaryAvailable();
if (!hasBinary) {
  console.warn(`Skipping Stockfish engine tests: no executable at STOCKFISH_PATH (${config.stockfishPath}).`);
}

describe.skipIf(!hasBinary)(`StockfishClient against the engine at ${config.stockfishPath}`, () => {
  let engine;

  beforeAll(async () => {
    engine = new StockfishClient({ depth: 8 });
    await engine.init();
  });

  afterAll(async () => {
    await engine?.quit();
  });

  it('reads the engine name and version from the handshake', () => {
    expect(engine.engineName).toBe('Stockfish');
    expect(engine.engineVersion).toMatch(/\S/);
    expect(engine.isReady).toBe(true);
  });

  it('evaluates the start position near zero at depth 8', async () => {
    await engine.newGame();
    const result = await engine.evaluatePosition(START, 8);
    expect(result.mate).toBeNull();
    expect(typeof result.evalCp).toBe('number');
    expect(Math.abs(result.evalCp)).toBeLessThan(100);
    expect(result.bestUci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    expect(result.depth).toBe(8);
  });

  it('returns a White-perspective score when Black is to move', async () => {
    // Black has no queen, so the side to move is badly behind.
    const result = await engine.evaluatePosition('rnb1kbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2', 8);
    expect(result.mate).toBeNull();
    expect(result.evalCp).toBeGreaterThan(300);
  });

  it('maps a White mate in one to mate +1 and +9990 cp', async () => {
    const result = await engine.evaluatePosition('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 8);
    expect(result).toMatchObject({ mate: 1, evalCp: 9990, bestUci: 'a1a8' });
  });

  it('maps a Black mate in one to mate -1 and -9990 cp', async () => {
    const result = await engine.evaluatePosition('r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1', 8);
    expect(result).toMatchObject({ mate: -1, evalCp: -9990, bestUci: 'a8a1' });
  });

  it('queues concurrent evaluations on the single engine', async () => {
    const [a, b] = await Promise.all([
      engine.evaluatePosition(START, 8),
      engine.evaluatePosition('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 8),
    ]);
    expect(typeof a.evalCp).toBe('number');
    expect(typeof b.evalCp).toBe('number');
    expect(a.bestUci).toBeTruthy();
    expect(b.bestUci).toBeTruthy();
  });

  it('rejects with EngineError when the position has no legal move', async () => {
    await expect(engine.evaluatePosition('R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1', 8)).rejects.toMatchObject({
      name: 'EngineError',
    });
    const after = await engine.evaluatePosition(START, 8);
    expect(after.mate).toBeNull();
  });
});
