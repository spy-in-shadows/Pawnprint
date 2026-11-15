import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { api } from '../lib/api';
import {
  CLASSIFICATION_STYLES,
  getClassificationSymbol,
  uciToSan,
  buildPlyFens,
  buildWinProbabilitySeries,
  scrollTopToReveal,
} from '../lib/gameViewerUtils';

export function GameView() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPly, setSelectedPly] = useState(0);

  const fetchGame = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/games/${id}`);
      setGame(data);
      setSelectedPly(0);
    } catch (err) {
      setError(err.message || 'Failed to load game');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchGame();
  }, [fetchGame]);

  const moves = useMemo(() => game?.moves || [], [game]);
  const totalPlies = moves.length;

  const fens = useMemo(() => buildPlyFens(moves), [moves]);
  const wpSeries = useMemo(() => buildWinProbabilitySeries(moves), [moves]);

  // Current position FEN
  const currentFen = fens[selectedPly] || fens[0] || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Navigation handlers
  const goToFirst = useCallback(() => setSelectedPly(0), []);
  const goToPrev = useCallback(() => setSelectedPly((p) => Math.max(0, p - 1)), []);
  const goToNext = useCallback(() => setSelectedPly((p) => Math.min(totalPlies, p + 1)), [totalPlies]);
  const goToLast = useCallback(() => setSelectedPly(totalPlies), [totalPlies]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToFirst();
      } else if (e.key === 'End') {
        e.preventDefault();
        goToLast();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToPrev, goToNext, goToFirst, goToLast]);

  // Keep the selected move visible in the move list. Only the list scrolls, not the page.
  const moveListRef = useRef(null);
  useEffect(() => {
    const list = moveListRef.current;
    if (!list) return;
    if (selectedPly === 0) {
      list.scrollTop = 0;
      return;
    }
    const item = list.querySelector(`[data-ply="${selectedPly}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const next = scrollTopToReveal({
      scrollTop: list.scrollTop,
      viewHeight: list.clientHeight,
      itemTop: itemRect.top - listRect.top + list.scrollTop,
      itemHeight: itemRect.height,
    });
    if (next !== null) list.scrollTop = next;
  }, [selectedPly, moves]);

  // Selected move details
  const selectedMove = selectedPly > 0 ? moves[selectedPly - 1] : null;

  // Best move converted to SAN via chess.js
  const bestMoveSan = useMemo(() => {
    if (!selectedMove || !selectedMove.eval?.bestUci) return null;
    return uciToSan(selectedMove.fenBefore, selectedMove.eval.bestUci);
  }, [selectedMove]);

  // Owner color
  const ownerColor = game?.color === 'black' ? 'black' : 'white';

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
        <svg
          className="animate-spin h-8 w-8 mb-3 text-blue-600 dark:text-blue-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <span className="text-sm font-medium">Loading game details...</span>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
        <p className="text-sm text-red-600 dark:text-red-400 font-medium mb-3">{error || 'Game not found'}</p>
        <div className="space-x-3">
          <button
            type="button"
            onClick={fetchGame}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => navigate('/games')}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200"
          >
            Back to Games
          </button>
        </div>
      </div>
    );
  }

  const isAnalyzed = game.analysisStatus === 'analyzed';

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <Link
            to="/games"
            className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline flex items-center space-x-1"
          >
            <span>&larr; Back to Games</span>
          </Link>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <h1 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {game.opening ? `${game.opening.eco} - ${game.opening.name}` : 'Chess Game'}
          </h1>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold capitalize ${
              game.result === 'win'
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                : game.result === 'loss'
                ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
            }`}
          >
            {game.result} ({game.color})
          </span>
        </div>

        <div className="flex items-center space-x-3 text-xs text-gray-500 dark:text-gray-400">
          <span>{game.playerRating ? `${game.playerRating} vs ${game.opponentRating || '?'}` : 'Unrated'}</span>
          <span>•</span>
          <span>{game.totalPlies} plies</span>
          <span>•</span>
          <span>{game.playedAt ? new Date(game.playedAt).toLocaleDateString() : ''}</span>
        </div>
      </div>

      {!isAnalyzed && (
        <div className="p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center justify-between">
          <span>
            <strong>Note:</strong> This game is not analyzed ({game.analysisStatus}
            {game.failureReason ? `: ${game.failureReason}` : ''}). Board and move replay are fully interactive, but Stockfish evaluations and classifications are unavailable.
          </span>
        </div>
      )}

      {/* Main Layout: Left = Chessboard & Controls; Right = Move list & Details */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Board + Navigation + Evaluation Graph */}
        <div className="lg:col-span-7 space-y-4">
          {/* Chessboard Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm flex flex-col items-center">
            <div className="w-[420px] max-w-full aspect-square">
              <Chessboard
                position={currentFen}
                boardOrientation={ownerColor}
                arePiecesDraggable={false}
                customBoardStyle={{
                  borderRadius: '6px',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                }}
              />
            </div>

            {/* Stepper Controls */}
            <div className="flex items-center justify-center space-x-2 mt-4 w-full">
              <button
                type="button"
                onClick={goToFirst}
                disabled={selectedPly === 0}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40"
                title="First move (Home)"
              >
                &laquo; First
              </button>
              <button
                type="button"
                onClick={goToPrev}
                disabled={selectedPly === 0}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40"
                title="Previous move (Left arrow)"
              >
                &lsaquo; Prev
              </button>

              <span className="text-xs font-mono px-3 text-gray-600 dark:text-gray-300">
                Ply {selectedPly} / {totalPlies}
              </span>

              <button
                type="button"
                onClick={goToNext}
                disabled={selectedPly >= totalPlies}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40"
                title="Next move (Right arrow)"
              >
                Next &rsaquo;
              </button>
              <button
                type="button"
                onClick={goToLast}
                disabled={selectedPly >= totalPlies}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40"
                title="Last move (End)"
              >
                Last &raquo;
              </button>
            </div>
          </div>

          {/* Evaluation Graph Card (Clickable to jump) */}
          {isAnalyzed && (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                  Evaluation Graph (White Win Probability %)
                </h2>
                <span className="text-[11px] text-gray-400">Click graph to jump to move</span>
              </div>

              <div className="w-full h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={wpSeries}
                    margin={{ top: 5, right: 10, left: -25, bottom: 0 }}
                    onClick={(e) => {
                      if (e && e.activePayload && e.activePayload[0]) {
                        setSelectedPly(e.activePayload[0].payload.ply);
                      }
                    }}
                  >
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: 'var(--chart-text)' }} />
                    <XAxis dataKey="ply" tick={{ fontSize: 9, fill: 'var(--chart-text)' }} />
                    <ReferenceLine y={50} stroke="#9ca3af" strokeDasharray="3 3" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1f2937',
                        borderColor: '#374151',
                        borderRadius: '0.375rem',
                        fontSize: '11px',
                        color: '#f9fafb',
                      }}
                      formatter={(val, name, item) => [
                        `${val}% win prob (ply ${item.payload.ply} ${item.payload.san} ${item.payload.symbol})`,
                        'White WP',
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="winProbability"
                      stroke="var(--chart-primary)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Details Panel + Move List */}
        <div className="lg:col-span-5 space-y-4">
          {/* Selected Move Details Panel */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300 mb-3">
              Move Details (Ply {selectedPly})
            </h2>

            {selectedPly === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Starting board position before move 1. Use the arrow keys or buttons to navigate.
              </p>
            ) : selectedMove ? (
              <div className="space-y-3 text-xs">
                {/* Move & Classification row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-sm text-gray-900 dark:text-gray-100">
                      {Math.ceil(selectedMove.ply / 2)}.
                      {selectedMove.moverColor === 'black' ? '..' : ''} {selectedMove.san}
                    </span>
                    <span className="text-gray-400 font-mono">({selectedMove.uci})</span>
                  </div>

                  {selectedMove.classification && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${
                        CLASSIFICATION_STYLES[selectedMove.classification]?.badgeClass || ''
                      }`}
                    >
                      {CLASSIFICATION_STYLES[selectedMove.classification]?.text || selectedMove.classification}
                      {getClassificationSymbol(selectedMove.classification) && (
                        <span className="ml-1 font-bold">
                          {getClassificationSymbol(selectedMove.classification)}
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {/* Metrics row */}
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Centipawn Loss:</span>{' '}
                    <span className="font-semibold text-gray-800 dark:text-gray-200">
                      {selectedMove.cpLoss !== null && selectedMove.cpLoss !== undefined
                        ? `${selectedMove.cpLoss} cp`
                        : '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Best Move:</span>{' '}
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {bestMoveSan ? `${bestMoveSan} (${selectedMove.eval?.bestUci})` : '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Clock Remaining:</span>{' '}
                    <span className="font-mono text-gray-800 dark:text-gray-200">
                      {selectedMove.clockRemainingMs !== null && selectedMove.clockRemainingMs !== undefined
                        ? `${Math.floor(selectedMove.clockRemainingMs / 1000)}s`
                        : '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Time Spent:</span>{' '}
                    <span className="font-mono text-gray-800 dark:text-gray-200">
                      {selectedMove.timeSpentMs !== null && selectedMove.timeSpentMs !== undefined
                        ? `${(selectedMove.timeSpentMs / 1000).toFixed(1)}s`
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* Tactical Motifs */}
                {selectedMove.motifs && selectedMove.motifs.length > 0 && (
                  <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
                    <span className="text-gray-500 dark:text-gray-400 block mb-1 font-medium">Tactical Motifs:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedMove.motifs.map((m, idx) => (
                        <span
                          key={idx}
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                            m.kind === 'allowed'
                              ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-800'
                              : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                          }`}
                        >
                          {m.name.replace(/_/g, ' ')} ({m.kind})
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* Move List Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300 mb-3">
              Move List
            </h2>

            <div ref={moveListRef} className="max-h-72 overflow-y-auto space-y-1 pr-1 text-xs">
              {moves.reduce((acc, m, idx) => {
                if (m.moverColor === 'white') {
                  acc.push([m]);
                } else {
                  if (acc.length === 0) {
                    acc.push([null, m]);
                  } else {
                    acc[acc.length - 1].push(m);
                  }
                }
                return acc;
              }, []).map((pair, turnIdx) => {
                const whiteMove = pair[0];
                const blackMove = pair[1];

                return (
                  <div key={turnIdx} className="grid grid-cols-12 gap-1 items-center py-0.5">
                    <span className="col-span-2 text-gray-400 font-mono text-right pr-2">
                      {turnIdx + 1}.
                    </span>

                    {/* White Move */}
                    <div className="col-span-5">
                      {whiteMove ? (
                        <button
                          type="button"
                          data-ply={whiteMove.ply}
                          onClick={() => setSelectedPly(whiteMove.ply)}
                          className={`w-full text-left px-2 py-1 rounded flex items-center justify-between transition-colors ${
                            selectedPly === whiteMove.ply
                              ? 'bg-blue-600 text-white font-bold'
                              : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          <span>{whiteMove.san}</span>
                          {whiteMove.classification && (
                            <span
                              className={`text-[11px] font-bold ${
                                selectedPly === whiteMove.ply
                                  ? 'text-white'
                                  : whiteMove.classification === 'blunder'
                                  ? 'text-red-600 dark:text-red-400'
                                  : whiteMove.classification === 'mistake'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : whiteMove.classification === 'inaccuracy'
                                  ? 'text-yellow-600 dark:text-yellow-400'
                                  : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              {getClassificationSymbol(whiteMove.classification) || '•'}
                            </span>
                          )}
                        </button>
                      ) : null}
                    </div>

                    {/* Black Move */}
                    <div className="col-span-5">
                      {blackMove ? (
                        <button
                          type="button"
                          data-ply={blackMove.ply}
                          onClick={() => setSelectedPly(blackMove.ply)}
                          className={`w-full text-left px-2 py-1 rounded flex items-center justify-between transition-colors ${
                            selectedPly === blackMove.ply
                              ? 'bg-blue-600 text-white font-bold'
                              : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          <span>{blackMove.san}</span>
                          {blackMove.classification && (
                            <span
                              className={`text-[11px] font-bold ${
                                selectedPly === blackMove.ply
                                  ? 'text-white'
                                  : blackMove.classification === 'blunder'
                                  ? 'text-red-600 dark:text-red-400'
                                  : blackMove.classification === 'mistake'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : blackMove.classification === 'inaccuracy'
                                  ? 'text-yellow-600 dark:text-yellow-400'
                                  : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              {getClassificationSymbol(blackMove.classification) || '•'}
                            </span>
                          )}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default GameView;
