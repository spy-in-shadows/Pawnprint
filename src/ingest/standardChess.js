export const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Checks whether a game is standard chess.
 * Rejects when a Variant header exists and is not 'Standard'/'Chess' (case-insensitive),
 * or when a FEN header differs from the standard start position, or SetUp is '1'.
 *
 * @param {object} game ParsedGame object or headers dictionary
 * @returns {boolean} true if standard chess, false otherwise
 */
export function isStandardChess(game) {
  if (!game || typeof game !== 'object') return false;
  const headers = game.headers || game;

  const variant = (headers.Variant || headers.variant || '').trim().toLowerCase();
  if (variant && variant !== 'standard' && variant !== 'chess') {
    return false;
  }

  const fen = (headers.FEN || headers.fen || '').trim();
  if (fen && fen !== STANDARD_START_FEN) {
    return false;
  }

  const setUp = String(headers.SetUp ?? headers.setup ?? '').trim();
  if (setUp === '1') {
    return false;
  }

  return true;
}
