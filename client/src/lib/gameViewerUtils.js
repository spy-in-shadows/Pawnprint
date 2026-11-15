import { Chess } from 'chess.js';

export const EVAL_CAP_CP = 1000;
const WP_SLOPE = 0.00368208;

export const CLASSIFICATION_SYMBOLS = {
  best: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export const CLASSIFICATION_STYLES = {
  best: {
    symbol: '',
    text: 'Best',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700',
    dotClass: 'bg-emerald-500',
  },
  good: {
    symbol: '',
    text: 'Good',
    badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-300 dark:border-blue-700',
    dotClass: 'bg-blue-500',
  },
  inaccuracy: {
    symbol: '?!',
    text: 'Inaccuracy',
    badgeClass: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700',
    dotClass: 'bg-yellow-500',
  },
  mistake: {
    symbol: '?',
    text: 'Mistake',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-300 dark:border-amber-700',
    dotClass: 'bg-amber-500',
  },
  blunder: {
    symbol: '??',
    text: 'Blunder',
    badgeClass: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-300 dark:border-red-700',
    dotClass: 'bg-red-500',
  },
};

/**
 * Maps classification name to annotation symbol: best (''), good (''), inaccuracy ('?!'), mistake ('?'), blunder ('??')
 */
export function getClassificationSymbol(classification) {
  if (!classification) return '';
  const key = String(classification).toLowerCase();
  return CLASSIFICATION_SYMBOLS[key] ?? '';
}

/**
 * Calculates win probability percentage from White perspective [-1000, 1000] centipawns
 */
export function winProbability(cp) {
  if (typeof cp !== 'number' || isNaN(cp)) return 50;
  const clamped = Math.max(-EVAL_CAP_CP, Math.min(EVAL_CAP_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-WP_SLOPE * clamped)) - 1);
}

/**
 * Converts UCI move to SAN given the board position (FEN before) using chess.js
 */
export function uciToSan(fenBefore, uci) {
  if (!fenBefore || !uci || uci.length < 4) return uci || '';
  try {
    const chess = new Chess(fenBefore);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5).toLowerCase() : undefined;
    const move = chess.move({ from, to, promotion });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

/**
 * Replays game moves and returns an array of board FENs for each ply index (0..moves.length)
 * plyIndex 0 = starting board FEN before move 1
 * plyIndex N = board FEN after move N (matching ply N's outcome)
 */
export function buildPlyFens(moves = []) {
  const fens = [];
  const startFen = moves[0]?.fenBefore || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  fens.push(startFen);

  let currentChess = null;
  try {
    currentChess = new Chess(startFen);
  } catch {
    currentChess = new Chess();
  }

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const nextMove = moves[i + 1];

    if (nextMove && nextMove.fenBefore) {
      fens.push(nextMove.fenBefore);
      try {
        currentChess = new Chess(nextMove.fenBefore);
      } catch {
        // Fallback keep current
      }
    } else {
      // Last move or missing next fenBefore: replay move with chess.js
      try {
        if (m.fenBefore && m.fenBefore !== currentChess.fen()) {
          currentChess.load(m.fenBefore);
        }
        if (m.uci && m.uci.length >= 4) {
          const from = m.uci.slice(0, 2);
          const to = m.uci.slice(2, 4);
          const promotion = m.uci.length > 4 ? m.uci.slice(4, 5).toLowerCase() : undefined;
          currentChess.move({ from, to, promotion });
        } else if (m.san) {
          currentChess.move(m.san);
        }
        fens.push(currentChess.fen());
      } catch {
        fens.push(m.fenBefore || currentChess.fen());
      }
    }
  }

  return fens;
}

/**
 * Builds win probability series from White's perspective for Recharts
 * Returns an array of items for each ply (ply 0: 50% or initial eval, ply 1..N: eval after move)
 */
export function buildWinProbabilitySeries(moves = []) {
  if (!Array.isArray(moves)) return [];

  const initialCp = moves[0]?.eval?.evalBeforeCp ?? 0;
  const series = [
    {
      ply: 0,
      san: 'Start',
      moverColor: 'white',
      evalCp: initialCp,
      winProbability: Number(winProbability(initialCp).toFixed(1)),
      classification: null,
      symbol: '',
    },
  ];

  moves.forEach((m) => {
    const evalCp = m.eval?.evalAfterCp ?? 0;
    const wp = Number(winProbability(evalCp).toFixed(1));
    const symbol = getClassificationSymbol(m.classification);

    series.push({
      ply: m.ply,
      san: m.san,
      moverColor: m.moverColor,
      evalCp,
      winProbability: wp,
      classification: m.classification,
      symbol,
    });
  });

  return series;
}

/**
 * Returns the scrollTop that brings an item fully into view inside a scroll container,
 * or null when it is already fully visible. All values are in pixels; itemTop is measured
 * from the top of the container's scrollable content. When the item is taller than the
 * view, its top edge is shown. Setting scrollTop on the container scrolls only the list,
 * never the page.
 */
export function scrollTopToReveal({ scrollTop, viewHeight, itemTop, itemHeight }) {
  const itemBottom = itemTop + itemHeight;
  if (itemTop < scrollTop || itemHeight > viewHeight) return itemTop;
  if (itemBottom > scrollTop + viewHeight) return itemBottom - viewHeight;
  return null;
}
