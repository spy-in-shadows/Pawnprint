import { Chess } from 'chess.js';

/**
 * Pure puzzle session state management according to Lichess convention.
 * drill: {
 *   startFen: string,
 *   solverColor: 'white' | 'black',
 *   setupMove: string,
 *   solverMoves: string[],
 *   opponentReplies: string[]
 * }
 */
export function createSession(drill) {
  if (!drill || !drill.startFen) {
    throw new Error('Invalid drill: startFen is required');
  }

  const solverMoves = Array.isArray(drill.solverMoves) ? drill.solverMoves : [];
  const opponentReplies = Array.isArray(drill.opponentReplies) ? drill.opponentReplies : [];

  return {
    drill: {
      ...drill,
      solverMoves,
      opponentReplies,
    },
    fen: drill.startFen,
    orientation: drill.solverColor || 'white',
    step: 0,
    done: solverMoves.length === 0,
  };
}

/**
 * Attempts a move by the solver on the current session state.
 * Validates against drill.solverMoves[step].
 * Returns:
 *   - Success: { ok: true, state: nextState, autoReply: string | null }
 *   - Wrong or illegal: { ok: false }
 */
export function tryMove(state, from, to, promotion) {
  if (!state || state.done) {
    return { ok: false };
  }

  const { drill, fen, step } = state;
  const expectedUci = drill.solverMoves[step];
  if (!expectedUci) {
    return { ok: false };
  }

  const promoChar = promotion ? String(promotion).toLowerCase() : undefined;
  const playedUci = `${from}${to}${promoChar || ''}`;

  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { ok: false };
  }

  // Check if played move is legal in chess.js
  let playedMove;
  try {
    playedMove = chess.move({
      from,
      to,
      promotion: promoChar,
    });
  } catch {
    return { ok: false };
  }

  if (!playedMove) {
    return { ok: false };
  }

  // Normalise expected UCI vs played move
  // Expected move might include promotion
  const moveMatches =
    playedUci === expectedUci ||
    (!promoChar && `${from}${to}` === expectedUci) ||
    (promoChar && `${from}${to}${promoChar}` === expectedUci);

  if (!moveMatches) {
    return { ok: false };
  }

  const nextFenAfterSolver = chess.fen();
  const nextStep = step + 1;
  const isDone = nextStep >= drill.solverMoves.length;

  const autoReply = !isDone ? drill.opponentReplies[step] || null : null;

  let finalFen = nextFenAfterSolver;
  if (autoReply && !isDone) {
    try {
      const oppFrom = autoReply.slice(0, 2);
      const oppTo = autoReply.slice(2, 4);
      const oppPromo = autoReply.length > 4 ? autoReply[4].toLowerCase() : undefined;
      chess.move({
        from: oppFrom,
        to: oppTo,
        promotion: oppPromo,
      });
      finalFen = chess.fen();
    } catch {
      // If auto-reply fails, retain board after solver move
    }
  }

  const nextState = {
    ...state,
    fen: finalFen,
    step: nextStep,
    done: isDone,
  };

  return {
    ok: true,
    state: nextState,
    autoReply,
  };
}
