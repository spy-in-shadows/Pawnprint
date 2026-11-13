import { Chess } from 'chess.js';
import { evaluateMoveQuality, mateToCp } from '../chess/evalMath.js';
import { validateFen } from '../chess/fen.js';
import { DataError } from '../utils/errors.js';

// Terminal positions are resolved from the board, never by the engine. They are stored with
// bestUci 'none' and depth 0, which is how readers tell them apart from searched positions.
const TERMINAL_BEST_UCI = 'none';
const TERMINAL_DEPTH = 0;

function terminalEval(board, moverColor) {
  if (board.isCheckmate()) {
    return { evalCp: mateToCp(0, moverColor), mate: 0, bestUci: TERMINAL_BEST_UCI, depth: TERMINAL_DEPTH };
  }
  if (board.isStalemate() || board.isThreefoldRepetition() || board.isDrawByFiftyMoves()) {
    return { evalCp: 0, mate: null, bestUci: TERMINAL_BEST_UCI, depth: TERMINAL_DEPTH };
  }
  return null;
}

function checkedFen(board, ply) {
  const fen = board.fen();
  const check = validateFen(fen);
  if (!check.ok) throw new DataError(`Invalid FEN after ply ${ply}: ${check.error}`);
  return fen;
}

function tryMove(board, move) {
  try {
    return board.move(move);
  } catch {
    return null;
  }
}

function applyMove(board, { san, uci }, ply) {
  let played = san ? tryMove(board, san) : null;
  if (!played && typeof uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    played = tryMove(board, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
  if (!played) {
    throw new DataError(`Illegal or unparseable move '${san ?? ''}' (uci '${uci ?? ''}') at ply ${ply}`);
  }
}

async function evaluateStart(board, engine, engineVersionId, startCache) {
  const cached = startCache?.get(engineVersionId);
  if (cached) return cached;
  const result = await engine.evaluatePosition(checkedFen(board, 0));
  startCache?.set(engineVersionId, result);
  return result;
}

// Replays the game from the standard start and evaluates each position once, so N plies cost
// N + 1 engine calls; the eval after ply N doubles as the eval before ply N + 1. Stored fenBefore
// values are ignored because the replayed board is the only position we can trust.
export async function analyzeGame({ moves }, engine, { engineVersionId, startCache } = {}) {
  const board = new Chess();
  let before = await evaluateStart(board, engine, engineVersionId, startCache);
  const rows = [];

  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    const ply = move.ply ?? i + 1;
    const moverColor = board.turn() === 'w' ? 'white' : 'black';

    applyMove(board, move, ply);
    const fenAfter = checkedFen(board, ply);
    const after = terminalEval(board, moverColor) ?? (await engine.evaluatePosition(fenAfter));

    const { cpLoss, classification } = evaluateMoveQuality({
      evalBeforeCp: before.evalCp,
      evalAfterCp: after.evalCp,
      moverColor,
    });

    rows.push({
      ply,
      evalBeforeCp: before.evalCp,
      evalAfterCp: after.evalCp,
      bestUci: before.bestUci,
      depth: before.depth,
      mateBefore: before.mate ?? null,
      mateAfter: after.mate ?? null,
      cpLoss,
      classification,
      motifs: [],
    });
    before = after;
  }

  return rows;
}
