import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parsePgnString } from '../src/chess/pgnParser.js';
import { createApp } from '../src/app.js';
import { prisma, pgPool } from '../src/config/db.js';
import { generateToken } from '../src/services/auth.service.js';
import { seed } from '../prisma/seed/index.js';

const MOVES =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0';

function pgn(count, prefix) {
  let s = '';
  for (let i = 1; i <= count; i += 1) {
    s += `[Event "${prefix} ${i}"]\n[Site "https://lichess.org/${prefix}${String(i).padStart(7, '0')}"]\n`
      + `[Date "2026.01.15"]\n[White "loadtester"]\n[Black "opp${i}"]\n[Result "1-0"]\n[TimeControl "180+0"]\n\n${MOVES}\n\n`;
  }
  return s;
}

// Counts how many times a zero-delay timer fires while `work` runs. A timer can only fire when the
// event loop gets a turn, so 0 means the work blocked the loop from start to finish.
async function timerTicksDuring(work) {
  let ticks = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    ticks += 1;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  const result = await work();
  running = false;
  return { ticks, result };
}

describe('PGN parsing keeps the event loop free', () => {
  const text = pgn(200, 'unit');

  it('parsePgnString yields between games, so timers run while it parses', async () => {
    const { ticks, result } = await timerTicksDuring(() => parsePgnString(text));
    expect(result).toHaveLength(200);
    expect(ticks).toBeGreaterThan(10);
  });

  it('without yielding (yieldEvery: 0) the same parse blocks every timer', async () => {
    const { ticks, result } = await timerTicksDuring(() => parsePgnString(text, { yieldEvery: 0 }));
    expect(result).toHaveLength(200);
    expect(ticks).toBe(0);
  });
});

describe('PGN upload over HTTP', () => {
  let server;
  let base;
  let token;

  beforeAll(async () => {
    await seed(prisma);
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await prisma.user.deleteMany({ where: { email: 'nonblocking_upload@example.com' } });
    const user = await prisma.user.create({ data: { email: 'nonblocking_upload@example.com', passwordHash: 'x' } });
    token = generateToken(user);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: 'nonblocking_upload@example.com' } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    await pgPool.end();
  });

  it('health answers quickly while a large upload is being parsed', async () => {
    // About 3,000 games: parsing them in one blocking run takes over 1.5 s on a laptop.
    const form = new FormData();
    form.append('file', new Blob([pgn(3000, 'http')]), 'big.pgn');
    let uploadDoneAt = null;
    const upload = fetch(`${base}/api/v1/uploads/pgn`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => {
      uploadDoneAt = Date.now();
      return { status: res.status, body: await res.json() };
    });

    // Poll health for the whole upload; the slowest answer shows the longest time the server
    // could not serve anyone else.
    const latencies = [];
    let healthDoneAt = 0;
    while (uploadDoneAt === null) {
      const started = Date.now();
      const health = await fetch(`${base}/health`);
      await health.arrayBuffer();
      healthDoneAt = Date.now();
      if (uploadDoneAt === null) latencies.push(healthDoneAt - started);
    }

    expect(latencies.length).toBeGreaterThan(5);
    expect(Math.max(...latencies)).toBeLessThan(750);

    const result = await upload;
    expect(result.status).toBe(202);
    expect(result.body.insertedCount).toBe(3000);
  }, 120000);
});
