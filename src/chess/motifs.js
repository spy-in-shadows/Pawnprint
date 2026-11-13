import { Chess } from 'chess.js';

const EXAMINED_CLASSIFICATIONS = new Set(['mistake', 'blunder']);

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: Infinity };
const SLIDERS = new Set(['b', 'r', 'q']);
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const other = (color) => (color === 'w' ? 'b' : 'w');
const backRank = (color) => (color === 'w' ? '1' : '8');

function piecesOf(board, color) {
  const out = [];
  for (const row of board.board()) {
    for (const cell of row) {
      if (cell && cell.color === color) out.push(cell);
    }
  }
  return out;
}

function kingSquare(board, color) {
  return piecesOf(board, color).find((p) => p.type === 'k')?.square ?? null;
}

// Plays a UCI move on a copy of the position; null when the move is missing or illegal there.
function playUci(fen, uci) {
  if (typeof uci !== 'string' || !UCI_RE.test(uci)) return null;
  const board = new Chess(fen);
  try {
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { board, move };
  } catch {
    return null;
  }
}

function isHanging(board, square, ownerColor) {
  return board.attackers(square, other(ownerColor)).length > 0 && board.attackers(square, ownerColor).length === 0;
}

function hangingSquares(board, color) {
  return new Set(
    piecesOf(board, color)
      .filter((p) => p.type !== 'k' && isHanging(board, p.square, color))
      .map((p) => p.square),
  );
}

// The piece that just moved attacks at least two enemy pieces that are worth more than it, or the king.
function isFork(board, move) {
  const attackerType = move.promotion ?? move.piece;
  const victims = other(move.color);
  const targets = piecesOf(board, victims).filter(
    (p) => (p.type === 'k' || PIECE_VALUE[p.type] > PIECE_VALUE[attackerType])
      && board.attackers(p.square, move.color).includes(move.to),
  );
  return targets.length >= 2;
}

// A capture of a piece nobody defended in the position the capture was played from.
function winsUndefendedPiece(boardBeforeCapture, move) {
  return Boolean(move.captured) && boardBeforeCapture.attackers(move.to, other(move.color)).length === 0;
}

function coords(square) {
  return [square.charCodeAt(0) - 97, Number(square[1]) - 1];
}

function isStrictlyBetween(square, a, b) {
  const [sx, sy] = coords(square);
  const [ax, ay] = coords(a);
  const [bx, by] = coords(b);
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  const aligned = ax === bx || ay === by || Math.abs(bx - ax) === Math.abs(by - ay);
  if (!aligned) return false;
  for (let x = ax + dx, y = ay + dy; x !== bx || y !== by; x += dx, y += dy) {
    if (x === sx && y === sy) return true;
  }
  return false;
}

// Moving the piece off move.from opens a line from another slider of the same side onto a piece
// worth at least a minor (or the king) that the slider did not attack before.
function isDiscoveredAttack(boardBefore, boardAfter, move) {
  const side = move.color;
  const sliders = piecesOf(boardAfter, side).filter((p) => SLIDERS.has(p.type) && p.square !== move.to);
  return piecesOf(boardAfter, other(side))
    .filter((p) => PIECE_VALUE[p.type] >= PIECE_VALUE.n)
    .some((target) => {
      const attackersNow = boardAfter.attackers(target.square, side);
      const attackersThen = boardBefore.attackers(target.square, side);
      return sliders.some(
        (s) => attackersNow.includes(s.square)
          && !attackersThen.includes(s.square)
          && isStrictlyBetween(move.from, s.square, target.square),
      );
    });
}

// The side to move is in check with its king on its own back rank and no square to step to.
function isBackRankCheck(board) {
  if (!board.inCheck()) return false;
  const color = board.turn();
  const king = kingSquare(board, color);
  if (!king || king[1] !== backRank(color)) return false;
  return board.moves({ square: king, verbose: true }).length === 0;
}

// What the opponent's engine reply does to the position the player left behind.
function allowedMotifs({ before, after, played, reply }) {
  const found = [];
  const player = played.color;

  const hangingBefore = hangingSquares(before, player);
  const newlyHanging = [...hangingSquares(after, player)].some((sq) => sq === played.to || !hangingBefore.has(sq));
  if (newlyHanging || (reply && winsUndefendedPiece(after, reply.move))) found.push('hanging_piece');

  if (reply) {
    if (isFork(reply.board, reply.move)) found.push('fork');
    if (isBackRankCheck(reply.board)) found.push('back_rank');
    if (isDiscoveredAttack(after, reply.board, reply.move)) found.push('discovered_attack');
  }
  // Pin and skewer detection on the reply joins here.
  return found;
}

// What the engine's best move would have achieved that the played move did not.
function missedMotifs({ before, after, played, best }) {
  const found = [];
  if (isFork(best.board, best.move) && !isFork(after, played)) found.push('fork');
  if (winsUndefendedPiece(before, best.move) && !winsUndefendedPiece(before, played)) found.push('hanging_piece');
  if (best.board.isCheckmate() && isBackRankCheck(best.board) && !(after.isCheckmate() && isBackRankCheck(after))) {
    found.push('back_rank');
  }
  // Pin and skewer detection on the best move joins here.
  return found;
}

export function detectMotifs({ fenBefore, fenAfter, moveUci, bestUci, bestReplyUci, classification }) {
  if (!EXAMINED_CLASSIFICATIONS.has(classification)) return [];

  const playedLine = playUci(fenBefore, moveUci);
  if (!playedLine) return [];
  const before = new Chess(fenBefore);
  const after = new Chess(fenAfter ?? playedLine.board.fen());
  const played = playedLine.move;

  const allowed = allowedMotifs({ before, after, played, reply: playUci(after.fen(), bestReplyUci) });

  const best = bestUci === moveUci ? null : playUci(fenBefore, bestUci);
  const missed = best ? missedMotifs({ before, after, played, best }) : [];

  return [
    ...allowed.map((name) => ({ name, kind: 'allowed' })),
    ...missed.map((name) => ({ name, kind: 'missed' })),
  ];
}

// Mate distances are White-perspective: positive means White mates. A mate that only gets longer
// is not a miss; losing it, or handing it to the opponent, is. mateAfter 0 is a delivered mate.
export function isMissedMate(mateBefore, mateAfter, moverColor) {
  const sign = moverColor === 'white' ? 1 : -1;
  if (mateBefore == null || mateBefore * sign <= 0) return false;
  if (mateAfter === 0) return false;
  return mateAfter == null || mateAfter * sign < 0;
}
