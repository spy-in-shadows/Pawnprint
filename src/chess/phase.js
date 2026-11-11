// Phase rule, applied in order:
//   1. endgame    if non-pawn, non-king material for both sides combined is <= 24 (N=3, B=3, R=5, Q=9);
//   2. opening    if ply <= 20 and both sides still have a queen;
//   3. middlegame otherwise.
// The starting position totals 62. At 24 or less each side has at most about a queen and a minor piece
// (or a rook and two minors), which is where king activity starts to matter more than piece coordination.

const PIECE_VALUES = { n: 3, b: 3, r: 5, q: 9 };

const ENDGAME_MATERIAL_MAX = 24;
const OPENING_PLY_MAX = 20;

export function classifyPhase(fen, ply) {
  if (typeof fen !== 'string') throw new TypeError('fen must be a string');
  const placement = fen.trim().split(/\s+/)[0];

  let total = 0;
  let whiteQueen = false;
  let blackQueen = false;
  for (const ch of placement) {
    const value = PIECE_VALUES[ch.toLowerCase()];
    if (value === undefined) continue;
    total += value;
    if (ch === 'Q') whiteQueen = true;
    else if (ch === 'q') blackQueen = true;
  }

  if (total <= ENDGAME_MATERIAL_MAX) return 'endgame';
  if (ply <= OPENING_PLY_MAX && whiteQueen && blackQueen) return 'opening';
  return 'middlegame';
}
