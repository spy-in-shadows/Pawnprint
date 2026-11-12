import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { StockfishClient } from '../src/chess/stockfishClient.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const isAlive = (child) => child.exitCode === null && child.signalCode === null;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A scriptable stand-in for the engine binary. `script.onGo` is 'answer' (reply with a score and a
// best move) or 'hang' (never reply), and can be changed between calls. With `script.holdHandshake`
// set, a new process stays silent after `uci` until `child.releaseHandshake()` is called.
function fakeEngine() {
  const children = [];
  const script = { onGo: 'answer', holdHandshake: false };

  const exit = (child, code, signal) => {
    if (!isAlive(child)) return;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => child.emit('close', code, signal));
  };

  const spawnFn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.commands = [];
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _enc, done) {
        for (const command of chunk.toString().split('\n').filter(Boolean)) {
          child.commands.push(command);
          if (command === 'uci') {
            if (script.holdHandshake) child.releaseHandshake = () => child.stdout.write('id name Stockfish 17\nuciok\n');
            else child.stdout.write('id name Stockfish 17\nuciok\n');
          }
          else if (command === 'isready') child.stdout.write('readyok\n');
          else if (command.startsWith('go') && script.onGo === 'answer') {
            child.stdout.write('info depth 12 score cp 31 nodes 1000 pv e2e4 e7e5\nbestmove e2e4 ponder e7e5\n');
          } else if (command === 'quit') exit(child, 0, null);
        }
        done();
      },
    });
    child.kill = (signal = 'SIGTERM') => {
      exit(child, null, signal);
      return true;
    };
    child.crash = () => exit(child, 1, null);
    children.push(child);
    return child;
  };

  return { spawnFn, children, script, alive: () => children.filter(isAlive) };
}

const clients = [];
const fakes = [];

function setup(options = {}) {
  const fake = fakeEngine();
  const engine = new StockfishClient({ positionTimeoutMs: 50, ...options, spawnFn: fake.spawnFn });
  fakes.push(fake);
  clients.push(engine);
  return { engine, fake };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((engine) => engine.quit()));
  for (const fake of fakes.splice(0)) {
    for (const child of fake.alive()) child.kill('SIGKILL');
  }
});

describe('StockfishClient resilience', () => {
  it('defaults to a 10 s position timeout and three allowed crashes', () => {
    const engine = new StockfishClient({ spawnFn: fakeEngine().spawnFn });
    expect(engine.positionTimeoutMs).toBe(10000);
    expect(engine.maxCrashes).toBe(3);
    expect(engine.hasCrashedTooManyTimes).toBe(false);
  });

  it('rejects on timeout with no fallback value and kills the process', async () => {
    const { engine, fake } = setup();
    await engine.init();
    fake.script.onGo = 'hang';
    const first = fake.children[0];

    const outcome = await engine.evaluatePosition(START).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ name: 'EngineError', isEngineError: true });
    expect(outcome.error.message).toMatch(/timed out/);
    expect(isAlive(first)).toBe(false);
    expect(engine.crashCount).toBe(1);
  });

  it('rejects pending requests and increments crashCount on unexpected exit, then respawns once', async () => {
    const { engine, fake } = setup({ positionTimeoutMs: 5000 });
    await engine.init();
    fake.script.onGo = 'hang';

    const running = engine.evaluatePosition(START).catch((err) => err);
    const queued = engine.evaluatePosition(START).catch((err) => err);
    await flush();
    fake.children[0].crash();

    expect(await running).toMatchObject({ name: 'EngineError', message: expect.stringMatching(/exited unexpectedly/) });
    expect(await queued).toMatchObject({ name: 'EngineError' });
    expect(engine.crashCount).toBe(1);

    await engine.init();
    expect(fake.children).toHaveLength(2);
    expect(fake.alive()).toHaveLength(1);
    expect(engine.isReady).toBe(true);

    fake.script.onGo = 'answer';
    expect(await engine.evaluatePosition(START)).toEqual({ evalCp: 31, mate: null, bestUci: 'e2e4', depth: 12 });
  });

  it('reports hasCrashedTooManyTimes after three crashes and stops respawning', async () => {
    const { engine, fake } = setup({ positionTimeoutMs: 5000 });
    for (let i = 0; i < 3; i += 1) {
      expect(engine.hasCrashedTooManyTimes).toBe(false);
      await engine.init();
      engine.process.crash();
      await flush();
      await flush();
    }
    expect(engine.crashCount).toBe(3);
    expect(engine.hasCrashedTooManyTimes).toBe(true);
    await flush();
    expect(fake.children).toHaveLength(3);
    expect(fake.alive()).toHaveLength(0);
  });

  it('honours a custom maxCrashes', async () => {
    const { engine } = setup({ maxCrashes: 1, positionTimeoutMs: 5000 });
    await engine.init();
    engine.process.crash();
    await flush();
    expect(engine.hasCrashedTooManyTimes).toBe(true);
  });

  it('quit() drains pending requests and prevents respawn', async () => {
    const { engine, fake } = setup({ positionTimeoutMs: 5000 });
    await engine.init();
    fake.script.onGo = 'hang';

    const running = engine.evaluatePosition(START).catch((err) => err);
    const queued = engine.evaluatePosition(START).catch((err) => err);
    await flush();
    await engine.quit();

    expect(await running).toMatchObject({ name: 'EngineError', message: expect.stringMatching(/shutting down/) });
    expect(await queued).toMatchObject({ name: 'EngineError' });
    await flush();
    expect(fake.children[0].commands.at(-1)).toBe('quit');
    expect(fake.children).toHaveLength(1);
    expect(fake.alive()).toHaveLength(0);
    expect(engine.crashCount).toBe(0);
    expect(engine.quitting).toBe(true);
  });

  it('quit() is safe to call twice, and before init()', async () => {
    const { engine, fake } = setup();
    await engine.quit();
    await engine.init();
    await Promise.all([engine.quit(), engine.quit()]);
    await engine.quit();
    expect(fake.alive()).toHaveLength(0);
    expect(engine.process).toBeNull();
  });

  it('init() called twice spawns a single process', async () => {
    const { engine, fake } = setup();
    await Promise.all([engine.init(), engine.init()]);
    await engine.init();
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0].commands.filter((c) => c === 'uci')).toHaveLength(1);
  });

  it('leaves exactly one live process when init() follows a timeout', async () => {
    const { engine, fake } = setup();
    await engine.init();
    fake.script.onGo = 'hang';
    await expect(engine.evaluatePosition(START)).rejects.toThrow(/timed out/);

    await Promise.all([engine.init(), engine.init()]);
    await flush();
    expect(fake.children).toHaveLength(2);
    expect(fake.alive()).toEqual([engine.process]);

    fake.script.onGo = 'answer';
    expect((await engine.evaluatePosition(START)).bestUci).toBe('e2e4');
  });

  it('ignores close events from a superseded process', async () => {
    const { engine, fake } = setup();
    await engine.init();
    fake.script.onGo = 'hang';
    await expect(engine.evaluatePosition(START)).rejects.toThrow(/timed out/);
    await engine.init();
    const [old, current] = fake.children;

    old.emit('close', 1, null);
    await flush();

    expect(engine.crashCount).toBe(1);
    expect(engine.process).toBe(current);
    expect(engine.isReady).toBe(true);
    expect(fake.children).toHaveLength(2);
  });

  it('rejects an invalid FEN before anything is written to stdin', async () => {
    const { engine, fake } = setup();
    await expect(engine.evaluatePosition('rnbqkbnr/pppppppp w KQkq - 0 1')).rejects.toMatchObject({ name: 'DataError' });
    expect(fake.children).toHaveLength(0);

    await engine.init();
    const sent = fake.children[0].commands.length;
    await expect(engine.evaluatePosition('not a fen')).rejects.toMatchObject({ name: 'DataError' });
    expect(fake.children[0].commands).toHaveLength(sent);
  });

  it('rejects evaluatePosition cleanly while the engine is respawning', async () => {
    const { engine, fake } = setup({ positionTimeoutMs: 5000 });
    await engine.init();
    fake.script.holdHandshake = true;
    fake.children[0].crash();
    await flush();
    await flush();
    expect(fake.children).toHaveLength(2);
    expect(engine.isReady).toBe(false);

    await expect(engine.evaluatePosition(START)).rejects.toMatchObject({
      name: 'EngineError',
      message: expect.stringMatching(/not ready/),
    });

    fake.children[1].releaseHandshake();
    await engine.init();
    expect(fake.children).toHaveLength(2);
    expect((await engine.evaluatePosition(START)).evalCp).toBe(31);
  });
});
