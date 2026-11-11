// All stored evals are White-perspective centipawns; loss and classification work in the mover's perspective.

export const MATE_CP = 10000;

// Losses are measured on evals clamped to this range: once a side is a rook or more ahead the game is
// decided, and trading +2500 for +1500 there should not count as a blunder.
export const EVAL_CAP_CP = 1000;

// Fitted so that +-300 cp maps to roughly 75/25 percent and +-1000 cp to roughly 97/3.
const WP_SLOPE = 0.00368208;

function normalizeColor(color) {
  const c = typeof color === 'string' ? color.toLowerCase() : color;
  if (c !== 'white' && c !== 'black') throw new TypeError(`Invalid color: ${color}`);
  return c;
}

function clampEval(cp) {
  return Math.max(-EVAL_CAP_CP, Math.min(EVAL_CAP_CP, cp));
}

export function perspective(cp, color) {
  if (normalizeColor(color) === 'white') return cp;
  return cp === 0 ? 0 : -cp;
}

// Mates share the centipawn axis so before/after arithmetic never special-cases them: every mate sits
// above any capped eval, and each extra move to mate costs 10 cp, so faster mates still order higher.
// mateMoves is White-perspective (positive = White mates); 0 means moverColor just delivered mate.
export function mateToCp(mateMoves, moverColor) {
  if (mateMoves === null || mateMoves === undefined) return 0;
  if (mateMoves === 0) return normalizeColor(moverColor) === 'white' ? MATE_CP : -MATE_CP;
  return Math.sign(mateMoves) * Math.max(EVAL_CAP_CP, MATE_CP - Math.abs(mateMoves) * 10);
}

export function winProbability(cp) {
  const capped = clampEval(cp);
  return 50 + 50 * (2 / (1 + Math.exp(-WP_SLOPE * capped)) - 1);
}

function classify(wpDrop) {
  if (wpDrop >= 20) return 'blunder';
  if (wpDrop >= 10) return 'mistake';
  if (wpDrop >= 5) return 'inaccuracy';
  if (wpDrop < 1) return 'best';
  return 'good';
}

export function evaluateMoveQuality({ evalBeforeCp, evalAfterCp, moverColor }) {
  const before = clampEval(perspective(evalBeforeCp, moverColor));
  const after = clampEval(perspective(evalAfterCp, moverColor));
  const cpLoss = Math.round(Math.max(0, before - after));
  // Classify on the rounded drop so the returned wpDrop and classification always agree.
  const wpDrop = Math.round(Math.max(0, winProbability(before) - winProbability(after)) * 100) / 100;
  return { cpLoss, wpDrop, classification: classify(wpDrop) };
}
