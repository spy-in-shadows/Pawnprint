import { describe, it, expect } from 'vitest';
import { createSession, tryMove } from '../src/lib/puzzleSession';

describe('puzzleSession pure logic', () => {
  // Real puzzle 00008 drill:
  // FEN before setup: r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24
  // Moves: f2g3 e6e7 b2b1 b3c1 b1c1 h6c1
  // Drill:
  //   setupMove: 'f2g3'
  //   solverColor: 'white'
  //   solverMoves: ['e6e7', 'b3c1', 'h6c1']
  //   opponentReplies: ['b2b1', 'b1c1']
  //   startFen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25'
  const realDrill00008 = {
    setupMove: 'f2g3',
    solverColor: 'white',
    solverMoves: ['e6e7', 'b3c1', 'h6c1'],
    opponentReplies: ['b2b1', 'b1c1'],
    startFen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25',
  };

  it('creates session with setup applied and White to move', () => {
    const session = createSession(realDrill00008);
    expect(session.orientation).toBe('white');
    expect(session.step).toBe(0);
    expect(session.done).toBe(false);
    expect(session.fen).toBe(realDrill00008.startFen);
    // Start FEN has 'w' to move
    expect(session.fen.includes(' w ')).toBe(true);
  });

  it('executes full correct sequence e6e7 -> auto b2b1 -> b3c1 -> auto b1c1 -> h6c1 -> done', () => {
    let session = createSession(realDrill00008);

    // Step 1: e6e7
    const res1 = tryMove(session, 'e6', 'e7');
    expect(res1.ok).toBe(true);
    expect(res1.autoReply).toBe('b2b1');
    session = res1.state;
    expect(session.step).toBe(1);
    expect(session.done).toBe(false);

    // Step 2: b3c1
    const res2 = tryMove(session, 'b3', 'c1');
    expect(res2.ok).toBe(true);
    expect(res2.autoReply).toBe('b1c1');
    session = res2.state;
    expect(session.step).toBe(2);
    expect(session.done).toBe(false);

    // Step 3: h6c1 (final move)
    const res3 = tryMove(session, 'h6', 'c1');
    expect(res3.ok).toBe(true);
    expect(res3.autoReply).toBeNull();
    session = res3.state;
    expect(session.step).toBe(3);
    expect(session.done).toBe(true);

    // Cannot continue after done
    const resAfter = tryMove(session, 'h1', 'g1');
    expect(resAfter.ok).toBe(false);
  });

  it('returns ok:false for a wrong legal move (e.g. e6f6) and does not advance', () => {
    const session = createSession(realDrill00008);
    const initialFen = session.fen;

    const res = tryMove(session, 'e6', 'f6');
    expect(res.ok).toBe(false);
    expect(session.step).toBe(0);
    expect(session.fen).toBe(initialFen);
    expect(session.done).toBe(false);
  });

  it('returns ok:false for an illegal move and leaves state unchanged', () => {
    const session = createSession(realDrill00008);
    const initialFen = session.fen;

    const res = tryMove(session, 'e6', 'e8'); // e8 is occupied by king/blocked/illegal
    expect(res.ok).toBe(false);
    expect(session.step).toBe(0);
    expect(session.fen).toBe(initialFen);
  });

  it('handles promotion properly without crashing', () => {
    const promoDrill = {
      setupMove: 'a7a8q',
      solverColor: 'white',
      solverMoves: ['b7b8q'],
      opponentReplies: [],
      startFen: '8/1P6/8/8/8/8/8/4K2k w - - 0 1',
    };

    const session = createSession(promoDrill);
    const res = tryMove(session, 'b7', 'b8', 'q');
    expect(res.ok).toBe(true);
    expect(res.state.done).toBe(true);
  });
});
