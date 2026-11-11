import { Chess } from 'chess.js';

const PIECES = new Set(['p', 'n', 'b', 'r', 'q', 'k', 'P', 'N', 'B', 'R', 'Q', 'K']);

function checkPlacement(placement) {
  const ranks = placement.split('/');
  if (ranks.length !== 8) return `piece placement must have 8 ranks, got ${ranks.length}`;

  let whiteKings = 0;
  let blackKings = 0;
  for (let i = 0; i < 8; i += 1) {
    const rank = ranks[i];
    let squares = 0;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        squares += Number(ch);
      } else if (PIECES.has(ch)) {
        squares += 1;
        if (ch === 'K') whiteKings += 1;
        else if (ch === 'k') blackKings += 1;
        // ranks[0] is rank 8 and ranks[7] is rank 1
        else if ((ch === 'P' || ch === 'p') && (i === 0 || i === 7)) {
          return `pawn on rank ${8 - i}`;
        }
      } else {
        return `unknown character '${ch}' in piece placement`;
      }
    }
    if (squares !== 8) return `rank ${8 - i} covers ${squares} squares, expected 8`;
  }

  if (whiteKings !== 1) return `expected exactly one white king, found ${whiteKings}`;
  if (blackKings !== 1) return `expected exactly one black king, found ${blackKings}`;
  return null;
}

export function validateFen(fen) {
  if (typeof fen !== 'string') return { ok: false, error: 'FEN must be a string' };
  const trimmed = fen.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 6) return { ok: false, error: `FEN must have 6 fields, got ${trimmed ? fields.length : 0}` };

  const placementError = checkPlacement(fields[0]);
  if (placementError) return { ok: false, error: placementError };
  if (fields[1] !== 'w' && fields[1] !== 'b') return { ok: false, error: `invalid side to move '${fields[1]}'` };

  // chess.js covers the rest: castling rights, en passant square, move counters, side not to move in check.
  try {
    new Chess(fields.join(' '));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}
