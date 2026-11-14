import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { api } from '../lib/api';
import { createSession, tryMove } from '../lib/puzzleSession';

export function InteractivePuzzleBoard({
  item,
  planId,
  onItemCompleted,
}) {
  const drill = item.drill;
  const isAlreadyCompleted = Boolean(item.completedAt);

  const [session, setSession] = useState(() => (drill ? createSession(drill) : null));
  const [boardFen, setBoardFen] = useState(() => (drill ? drill.startFen : ''));
  const [feedback, setFeedback] = useState(null); // { type: 'success'|'error'|'completed', message: string }
  const [hintSquare, setHintSquare] = useState(null);
  const [isCompleted, setIsCompleted] = useState(isAlreadyCompleted);
  const [isSaving, setIsSaving] = useState(false);

  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Reset or initialize session when item changes
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (drill) {
      const s = createSession(drill);
      setSession(s);
      setBoardFen(s.fen);
      setFeedback(null);
      setHintSquare(null);
      setIsCompleted(Boolean(item.completedAt));
    }
  }, [drill, item.id, item.completedAt]);

  const handleCompletion = useCallback(async () => {
    setIsCompleted(true);
    setFeedback({ type: 'completed', message: 'Puzzle Solved! Great tactic!' });
    setIsSaving(true);
    try {
      await api.patch(`/training/plans/${planId}/items/${item.id}`, { completed: true });
      if (onItemCompleted) {
        onItemCompleted(item.id);
      }
    } catch (err) {
      // Retain completed state locally even if server patch returns error
    } finally {
      setIsSaving(false);
    }
  }, [planId, item.id, onItemCompleted]);

  const onPieceDrop = (sourceSquare, targetSquare, piece) => {
    if (!session || session.done || isCompleted) {
      return false;
    }

    // Determine promotion piece if pawn reaches 8th/1st rank
    let promotion;
    const isPawn = piece && (piece.endsWith('P') || piece.endsWith('p'));
    if (isPawn && (targetSquare.endsWith('8') || targetSquare.endsWith('1'))) {
      promotion = 'q';
    }

    const res = tryMove(session, sourceSquare, targetSquare, promotion);

    if (!res.ok) {
      // Flash feedback for wrong move
      setFeedback({ type: 'error', message: 'Incorrect move. Try again!' });
      return false; // Snaps piece back
    }

    // Clear hint if present
    setHintSquare(null);

    // Update board to solver's move first
    let tempChess;
    try {
      tempChess = new Chess(session.fen);
      tempChess.move({ from: sourceSquare, to: targetSquare, promotion });
      setBoardFen(tempChess.fen());
    } catch {
      // Fallback
    }

    setFeedback({ type: 'success', message: 'Correct move!' });

    if (res.state.done) {
      setSession(res.state);
      setBoardFen(res.state.fen);
      handleCompletion();
      return true;
    }

    // Play opponent's reply after 350 ms delay
    if (res.autoReply) {
      timerRef.current = setTimeout(() => {
        setSession(res.state);
        setBoardFen(res.state.fen);
      }, 350);
    } else {
      setSession(res.state);
      setBoardFen(res.state.fen);
    }

    return true;
  };

  const handleShowHint = () => {
    if (!session || session.done || isCompleted) return;
    const nextMoveUci = session.drill.solverMoves[session.step];
    if (nextMoveUci && nextMoveUci.length >= 2) {
      const fromSq = nextMoveUci.slice(0, 2);
      setHintSquare(fromSq);
      setFeedback({ type: 'info', message: `Hint: move piece on ${fromSq}` });
    }
  };

  const handleReset = () => {
    if (!drill) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const s = createSession(drill);
    setSession(s);
    setBoardFen(s.fen);
    setFeedback(null);
    setHintSquare(null);
    setIsCompleted(false);
  };

  if (!drill) {
    return (
      <div className="p-6 text-center text-xs text-gray-500 dark:text-gray-400">
        Drill data unavailable for this puzzle.
      </div>
    );
  }

  const totalMoves = drill.solverMoves.length;
  const currentStep = session ? session.step : 0;
  const solverSide = drill.solverColor || 'white';

  const customSquareStyles = {};
  if (hintSquare) {
    customSquareStyles[hintSquare] = {
      backgroundColor: 'rgba(251, 191, 36, 0.5)',
      borderRadius: '4px',
    };
  }

  return (
    <div className="flex flex-col items-center space-y-4">
      {/* Status Bar */}
      <div className="w-full flex items-center justify-between text-xs">
        <div className="flex items-center space-x-2">
          <span className="font-semibold text-gray-800 dark:text-gray-200 capitalize">
            {solverSide} to Move
          </span>
          <span className="text-gray-400">•</span>
          <span className="text-gray-600 dark:text-gray-400">
            Move {Math.min(totalMoves, currentStep + 1)} of {totalMoves}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {!isCompleted && !session?.done && (
            <button
              type="button"
              onClick={handleShowHint}
              className="px-2.5 py-1 rounded text-xs font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
            >
              Hint
            </button>
          )}

          <button
            type="button"
            onClick={handleReset}
            className="px-2.5 py-1 rounded text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Chessboard Container */}
      <div className="w-[380px] max-w-full aspect-square relative">
        <Chessboard
          position={boardFen}
          boardOrientation={solverSide}
          onPieceDrop={onPieceDrop}
          customSquareStyles={customSquareStyles}
          customBoardStyle={{
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
          }}
        />
      </div>

      {/* Feedback Banner */}
      <div className="w-full min-h-[36px] flex items-center justify-center">
        {feedback && (
          <div
            className={`w-full text-center py-2 px-3 rounded-lg text-xs font-medium ${
              feedback.type === 'completed'
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700'
                : feedback.type === 'error'
                ? 'bg-red-50 text-red-800 dark:bg-red-900/40 dark:text-red-300 border border-red-300 dark:border-red-700'
                : feedback.type === 'success'
                ? 'bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                : 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
            }`}
          >
            {feedback.message} {isSaving && '(saving...)'}
          </div>
        )}
      </div>
    </div>
  );
}

export default InteractivePuzzleBoard;
