import { spawn } from 'node:child_process';
import readline from 'node:readline';
import config from '../config/env.js';
import { mateToCp } from './evalMath.js';
import { validateFen } from './fen.js';
import { DataError, EngineError } from '../utils/errors.js';

const QUIT_GRACE_MS = 500;

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

// Returns {depth, cp, mate} for a final score line, or null for lines to ignore. Bound scores come from
// aspiration-window fail-highs/lows and are not real evaluations, so they never replace the last exact one.
function parseInfo(line) {
  const tokens = line.split(/\s+/);
  let depth = null;
  let cp = null;
  let mate = null;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'string' || token === 'lowerbound' || token === 'upperbound') return null;
    if (token === 'pv') break;
    if (token === 'depth') {
      depth = Number(tokens[i + 1]);
      i += 1;
    } else if (token === 'score') {
      const kind = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      if (kind === 'cp') cp = value;
      else if (kind === 'mate') mate = value;
      i += 2;
    }
  }
  if (cp === null && mate === null) return null;
  return { depth, cp, mate };
}

export class StockfishClient {
  constructor({
    binaryPath = config.stockfishPath,
    depth = config.engineDepth,
    threads = config.engineThreads,
    hashSize = config.engineHashMb,
    spawnFn = spawn,
  } = {}) {
    this.binaryPath = binaryPath;
    this.depth = depth;
    this.threads = threads;
    this.hashSize = hashSize;
    this.spawnFn = spawnFn;
    this.engineName = null;
    this.engineVersion = null;
    this.process = null;
    this.isReady = false;
    this._initPromise = null;
    this._waiter = null;
    this._queue = Promise.resolve();
  }

  init() {
    if (this.isReady && this.process) return Promise.resolve();
    if (!this._initPromise) {
      const pending = this._handshake().finally(() => {
        if (this._initPromise === pending) this._initPromise = null;
      });
      this._initPromise = pending;
    }
    return this._initPromise;
  }

  newGame() {
    return this._enqueue(async () => {
      const child = this._readyProcess();
      this._write(child, 'ucinewgame');
      await this._request(child, 'isready', (line) => line === 'readyok');
    });
  }

  evaluatePosition(fen, depth = this.depth) {
    const check = validateFen(fen);
    if (!check.ok) return Promise.reject(new DataError(`Invalid FEN '${fen}': ${check.error}`));
    return this._enqueue(() => this._search(fen.trim(), depth));
  }

  async quit() {
    const child = this.process;
    this.process = null;
    this.isReady = false;
    this._rejectWaiter(new EngineError('Stockfish client is shutting down'));
    if (!child || !isAlive(child)) return;

    this._write(child, 'quit');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (isAlive(child)) child.kill('SIGKILL');
        resolve();
      }, QUIT_GRACE_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async _handshake() {
    if (this.process) this._discard(this.process);
    const child = this._spawn();
    try {
      await this._request(
        child,
        'uci',
        (line) => line === 'uciok',
        (line) => {
          if (!line.startsWith('id name ')) return;
          const [name, ...version] = line.slice('id name '.length).trim().split(/\s+/);
          this.engineName = name;
          this.engineVersion = version.join(' ') || null;
        },
      );
      this._write(child, `setoption name Threads value ${this.threads}`);
      this._write(child, `setoption name Hash value ${this.hashSize}`);
      await this._request(child, 'isready', (line) => line === 'readyok');
      if (this.process !== child) throw new EngineError('Stockfish stopped during startup');
    } catch (err) {
      this._discard(child);
      throw err;
    }
    this.isReady = true;
  }

  async _search(fen, depth) {
    const child = this._readyProcess();
    let last = null;
    this._write(child, `position fen ${fen}`);
    const bestLine = await this._request(
      child,
      `go depth ${depth}`,
      (line) => line.startsWith('bestmove'),
      (line) => {
        if (!line.startsWith('info ')) return;
        const info = parseInfo(line);
        if (info) last = info;
      },
    );

    const bestUci = bestLine.split(/\s+/)[1];
    if (!bestUci || bestUci === '(none)') throw new EngineError(`Stockfish found no legal move in ${fen}`);
    if (!last) throw new EngineError(`Stockfish reported no score for ${fen}`);

    // UCI scores are relative to the side to move.
    const sign = fen.split(' ')[1] === 'b' ? -1 : 1;
    const reachedDepth = last.depth ?? depth;
    if (last.mate !== null) {
      const mate = sign * last.mate;
      return { evalCp: mateToCp(mate), mate, bestUci, depth: reachedDepth };
    }
    return { evalCp: last.cp === 0 ? 0 : sign * last.cp, mate: null, bestUci, depth: reachedDepth };
  }

  _spawn() {
    let child;
    try {
      child = this.spawnFn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      throw this._spawnError(err);
    }
    this.process = child;
    // Writes to an engine that just died fail with EPIPE; the close handler reports the failure.
    child.stdin.on('error', () => {});
    readline
      .createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on('line', (line) => this._onLine(child, line.trim()));
    child.on('error', (err) => {
      if (this.process !== child) return;
      const error = this.isReady ? new EngineError(`Stockfish process error: ${err.message}`) : this._spawnError(err);
      this._discard(child);
      this._rejectWaiter(error, child);
    });
    child.on('close', (code, signal) => this._onClose(child, code, signal));
    return child;
  }

  _spawnError(err) {
    return new EngineError(
      `Could not start Stockfish at '${this.binaryPath}' (${err.message}); set STOCKFISH_PATH to the engine binary`,
    );
  }

  _onClose(child, code, signal) {
    if (this.process !== child) return;
    this._discard(child);
    this._rejectWaiter(new EngineError(`Stockfish exited unexpectedly (code ${code}, signal ${signal})`), child);
  }

  _onLine(child, line) {
    const waiter = this._waiter;
    if (!waiter || waiter.child !== child) return;
    waiter.onLine?.(line);
    if (waiter.isDone(line)) {
      this._waiter = null;
      waiter.resolve(line);
    }
  }

  _request(child, command, isDone, onLine) {
    return new Promise((resolve, reject) => {
      this._waiter = { child, isDone, onLine, resolve, reject };
      this._write(child, command);
    });
  }

  _rejectWaiter(error, child = null) {
    const waiter = this._waiter;
    if (!waiter || (child && waiter.child !== child)) return;
    this._waiter = null;
    waiter.reject(error);
  }

  _readyProcess() {
    if (!this.isReady || !this.process) throw new EngineError('Stockfish is not ready; call init() first');
    return this.process;
  }

  _discard(child) {
    if (this.process === child) {
      this.process = null;
      this.isReady = false;
    }
    if (isAlive(child)) child.kill('SIGKILL');
  }

  _write(child, command) {
    if (child.stdin.writable) child.stdin.write(`${command}\n`);
  }

  // One engine process can run only one search at a time, so every engine call goes through this queue.
  _enqueue(task) {
    const run = this._queue.then(task);
    this._queue = run.catch(() => {});
    return run;
  }
}
