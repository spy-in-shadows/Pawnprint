import { Chess } from 'chess.js';

/**
 * Prepares a drill from a Lichess-convention puzzle.
 *
 * @param {object} puzzle
 * @param {string} puzzle.fen - FEN before opponent's setup move
 * @param {string|string[]} puzzle.movesUci - space-separated string or array of UCI moves
 * @returns {{
 *   startFen: string,
 *   solverColor: 'white'|'black',
 *   setupMove: string,
 *   solverMoves: string[],
 *   opponentReplies: string[]
 * }}
 */
export function prepareDrill(puzzle) {
  if (!puzzle || typeof puzzle.fen !== 'string' || !puzzle.fen.trim()) {
    throw new Error('Invalid puzzle: missing FEN');
  }

  const movesUci = Array.isArray(puzzle.movesUci)
    ? puzzle.movesUci
    : typeof puzzle.movesUci === 'string'
      ? puzzle.movesUci.trim().split(/\s+/).filter(Boolean)
      : [];

  if (movesUci.length === 0) {
    throw new Error('Invalid puzzle: movesUci cannot be empty');
  }

  const chess = new Chess(puzzle.fen);
  const setupMove = movesUci[0];

  try {
    const appliedSetup = chess.move(setupMove);
    if (!appliedSetup) {
      throw new Error(`Illegal setup move: ${setupMove}`);
    }
  } catch (err) {
    throw new Error(`Illegal setup move: ${setupMove} (${err.message})`);
  }

  const startFen = chess.fen();
  const solverColor = chess.turn() === 'w' ? 'white' : 'black';

  const solverMoves = [];
  const opponentReplies = [];

  for (let i = 1; i < movesUci.length; i++) {
    const moveUci = movesUci[i];
    try {
      const applied = chess.move(moveUci);
      if (!applied) {
        throw new Error(`Illegal move at index ${i}: ${moveUci}`);
      }
    } catch (err) {
      throw new Error(`Illegal move at index ${i}: ${moveUci} (${err.message})`);
    }

    if (i % 2 === 1) {
      solverMoves.push(moveUci);
    } else {
      opponentReplies.push(moveUci);
    }
  }

  return {
    startFen,
    solverColor,
    setupMove,
    solverMoves,
    opponentReplies,
  };
}

export default {
  prepareDrill,
};
