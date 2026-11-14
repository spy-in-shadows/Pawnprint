import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { InteractivePuzzleBoard } from '../components/InteractivePuzzleBoard';

const REASON_LABELS = {
  MOTIF_WEAKNESS: 'Tactical Motif Weakness',
  OPENING_PHASE_WEAKNESS: 'Opening Phase Weakness',
};

export function TrainingPlanView() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [generateMessage, setGenerateMessage] = useState(null);

  const [activePlanId, setActivePlanId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/training/plans');
      const list = Array.isArray(data) ? data : data.plans || [];
      setPlans(list);
      if (list.length > 0) {
        setActivePlanId(list[0].id);
        const firstItem = (list[0].items || [])[0];
        if (firstItem) {
          setSelectedItemId(firstItem.id);
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to load training plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const handleGeneratePlan = async () => {
    setGenerating(true);
    setError(null);
    setGenerateMessage(null);
    try {
      const newPlan = await api.post('/training/plans', {});
      if (newPlan.message && (!newPlan.items || newPlan.items.length === 0)) {
        setGenerateMessage(newPlan.message);
      }
      await fetchPlans();
    } catch (err) {
      setError(err.message || 'Failed to generate training plan');
    } finally {
      setGenerating(false);
    }
  };

  const handleItemCompleted = (itemId) => {
    setPlans((prev) =>
      prev.map((p) => {
        if (p.id !== activePlanId) return p;
        return {
          ...p,
          items: (p.items || []).map((it) =>
            it.id === itemId ? { ...it, completedAt: new Date().toISOString() } : it
          ),
        };
      })
    );
  };

  const currentPlan = plans.find((p) => p.id === activePlanId) || plans[0] || null;
  const currentItems = currentPlan?.items || [];
  const selectedItem = currentItems.find((it) => it.id === selectedItemId) || currentItems[0] || null;

  // Group current plan items by reasonCode
  const groupedItems = currentItems.reduce((acc, item) => {
    const code = item.reasonCode || 'OTHER';
    if (!acc[code]) acc[code] = [];
    acc[code].push(item);
    return acc;
  }, {});

  const totalItems = currentItems.length;
  const completedCount = currentItems.filter((it) => Boolean(it.completedAt)).length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Personalized Training</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Targeted puzzle drills synthesized directly from your longitudinal blunder motifs and opening phases.
          </p>
        </div>

        <button
          type="button"
          onClick={handleGeneratePlan}
          disabled={generating}
          className="inline-flex items-center justify-center px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm disabled:opacity-50 transition-colors"
        >
          {generating ? 'Generating Plan...' : 'Generate New Plan'}
        </button>
      </div>

      {generateMessage && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg text-xs font-medium text-blue-800 dark:text-blue-300">
          {generateMessage}
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-xs font-medium text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={fetchPlans} className="underline font-semibold ml-2">
            Retry
          </button>
        </div>
      )}

      {loading ? (
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
          <span className="text-sm font-medium">Loading training plans...</span>
        </div>
      ) : plans.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">No training plans yet</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 max-w-md mx-auto">
            Click &quot;Generate New Plan&quot; to synthesize personalized tactics drills matching your recent mistakes.
          </p>
          <button
            type="button"
            onClick={handleGeneratePlan}
            disabled={generating}
            className="px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Generate Plan'}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Plan Selector Bar */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center space-x-2">
              <label htmlFor="plan-select" className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Active Plan:
              </label>
              <select
                id="plan-select"
                value={activePlanId || ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setActivePlanId(id);
                  const p = plans.find((x) => x.id === id);
                  if (p && (p.items || []).length > 0) {
                    setSelectedItemId(p.items[0].id);
                  }
                }}
                className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    Plan #{p.id} ({p.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Recent'}) —{' '}
                    {(p.items || []).length} drills
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Completed: <strong className="text-gray-900 dark:text-gray-100">{completedCount}</strong> of{' '}
              <strong className="text-gray-900 dark:text-gray-100">{totalItems}</strong> drills
            </div>
          </div>

          {totalItems === 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-xs text-gray-500 dark:text-gray-400">
              {currentPlan?.message || 'No puzzles assigned in this training plan.'}
            </div>
          ) : (
            /* Main Content: Left = Grouped Drills List; Right = Puzzle Solver */
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Drills List Grouped by Reason */}
              <div className="lg:col-span-5 space-y-4">
                {Object.entries(groupedItems).map(([reasonCode, items]) => {
                  const title = REASON_LABELS[reasonCode] || reasonCode.replace(/_/g, ' ');

                  return (
                    <div
                      key={reasonCode}
                      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm space-y-2"
                    >
                      <h2 className="text-xs font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300 flex items-center justify-between">
                        <span>{title}</span>
                        <span className="text-[11px] font-normal text-gray-400">
                          {items.filter((i) => Boolean(i.completedAt)).length}/{items.length}
                        </span>
                      </h2>

                      <div className="space-y-1 pt-1">
                        {items.map((it, idx) => {
                          const isSelected = selectedItem?.id === it.id;
                          const isDone = Boolean(it.completedAt);
                          const rating = it.puzzle?.rating ? `Rating: ${it.puzzle.rating}` : '';
                          const phase = it.puzzle?.phaseTag ? it.puzzle.phaseTag : '';

                          return (
                            <button
                              key={it.id}
                              type="button"
                              onClick={() => setSelectedItemId(it.id)}
                              className={`w-full text-left p-2.5 rounded-lg flex items-center justify-between transition-colors ${
                                isSelected
                                  ? 'bg-blue-50 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-700'
                                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 border border-transparent'
                              }`}
                            >
                              <div className="flex items-center space-x-2.5">
                                <span
                                  className={`h-4 w-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                    isDone
                                      ? 'bg-emerald-500 text-white'
                                      : 'border border-gray-400 text-transparent'
                                  }`}
                                >
                                  {isDone ? '✓' : ''}
                                </span>
                                <div>
                                  <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 block">
                                    Puzzle #{idx + 1} {it.puzzle?.lichessId ? `(${it.puzzle.lichessId})` : ''}
                                  </span>
                                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                                    {rating} {phase ? `• ${phase}` : ''}
                                  </span>
                                </div>
                              </div>

                              <span
                                className={`text-[11px] font-medium px-2 py-0.5 rounded ${
                                  isDone
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                                }`}
                              >
                                {isDone ? 'Completed' : 'To Solve'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Interactive Board Solver */}
              <div className="lg:col-span-7 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 shadow-sm">
                {selectedItem ? (
                  <div>
                    <div className="flex items-center justify-between pb-3 mb-4 border-b border-gray-100 dark:border-gray-700">
                      <div>
                        <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                          Tactical Puzzle Drill{' '}
                          {selectedItem.puzzle?.lichessId ? `(${selectedItem.puzzle.lichessId})` : ''}
                        </h2>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {REASON_LABELS[selectedItem.reasonCode] || selectedItem.reasonCode}
                          {selectedItem.puzzle?.rating ? ` • Rating: ${selectedItem.puzzle.rating}` : ''}
                        </p>
                      </div>

                      {Boolean(selectedItem.completedAt) && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          Completed
                        </span>
                      )}
                    </div>

                    <InteractivePuzzleBoard
                      key={selectedItem.id}
                      item={selectedItem}
                      planId={currentPlan.id}
                      onItemCompleted={handleItemCompleted}
                    />
                  </div>
                ) : (
                  <div className="p-12 text-center text-xs text-gray-500 dark:text-gray-400">
                    Select a puzzle from the list to start solving.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TrainingPlanView;
