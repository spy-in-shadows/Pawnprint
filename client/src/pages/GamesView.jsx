import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { validateDateRange } from '../lib/dashboardUtils';

export function GamesView() {
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [openingFilter, setOpeningFilter] = useState('');

  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [totalGames, setTotalGames] = useState(0);

  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateError, setDateError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    api
      .get('/accounts')
      .then((res) => {
        if (!isMounted) return;
        const list = Array.isArray(res) ? res : res.items || [];
        setAccounts(list);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  const fetchGames = useCallback(async () => {
    const { valid, error: dErr } = validateDateRange(fromDate, toDate);
    if (!valid) {
      setDateError(dErr);
      return;
    }
    setDateError(null);

    setLoading(true);
    setError(null);

    const query = new URLSearchParams();
    query.set('page', String(page));
    query.set('pageSize', String(pageSize));
    if (selectedAccountId) query.set('accountId', selectedAccountId);
    if (fromDate) query.set('from', fromDate);
    if (toDate) query.set('to', toDate);
    if (openingFilter.trim()) query.set('opening', openingFilter.trim().toUpperCase());

    try {
      const res = await api.get(`/games?${query.toString()}`);
      setGames(res.items || []);
      setTotalGames(res.total || 0);
    } catch (err) {
      setError(err.message || 'Failed to load games');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, selectedAccountId, fromDate, toDate, openingFilter]);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  const handleFilterChange = (setter) => (e) => {
    setter(e.target.value);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(totalGames / pageSize));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Games Explorer</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Browse and inspect imported chess games with Stockfish move classifications.
          </p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm flex flex-wrap items-center gap-4">
        <div className="flex items-center space-x-1.5">
          <label htmlFor="account-filter" className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Account:
          </label>
          <select
            id="account-filter"
            value={selectedAccountId}
            onChange={handleFilterChange(setSelectedAccountId)}
            className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Accounts</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.platform ? `${acc.platform.name || acc.platform} - ` : ''}
                {acc.username}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center space-x-1.5">
          <label htmlFor="from-filter" className="text-xs font-medium text-gray-700 dark:text-gray-300">
            From:
          </label>
          <input
            type="date"
            id="from-filter"
            value={fromDate}
            onChange={handleFilterChange(setFromDate)}
            className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex items-center space-x-1.5">
          <label htmlFor="to-filter" className="text-xs font-medium text-gray-700 dark:text-gray-300">
            To:
          </label>
          <input
            type="date"
            id="to-filter"
            value={toDate}
            onChange={handleFilterChange(setToDate)}
            className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex items-center space-x-1.5">
          <label htmlFor="eco-filter" className="text-xs font-medium text-gray-700 dark:text-gray-300">
            ECO:
          </label>
          <input
            type="text"
            id="eco-filter"
            placeholder="e.g. B00"
            maxLength={3}
            value={openingFilter}
            onChange={handleFilterChange(setOpeningFilter)}
            className="text-xs w-20 uppercase rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {(selectedAccountId || fromDate || toDate || openingFilter) && (
          <button
            type="button"
            onClick={() => {
              setSelectedAccountId('');
              setFromDate('');
              setToDate('');
              setOpeningFilter('');
              setPage(1);
            }}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium ml-auto"
          >
            Clear Filters
          </button>
        )}
      </div>

      {dateError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-xs font-medium text-red-700 dark:text-red-300">
          {dateError}
        </div>
      )}

      {/* Main Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-12 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
            <svg
              className="animate-spin h-8 w-8 mb-3 text-blue-600 dark:text-blue-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span className="text-sm font-medium">Loading games...</span>
          </div>
        ) : error ? (
          <div className="p-12 text-center">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium mb-3">{error}</p>
            <button
              type="button"
              onClick={fetchGames}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
            >
              Retry
            </button>
          </div>
        ) : games.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">No games found</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Try adjusting your search filters or import games from your linked chess accounts.
            </p>
            <button
              type="button"
              onClick={() => navigate('/import')}
              className="px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
            >
              Go to Import
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 uppercase tracking-wider font-semibold">
                  <th className="py-3 px-4">Played At</th>
                  <th className="py-3 px-4">Result</th>
                  <th className="py-3 px-4">Opening</th>
                  <th className="py-3 px-4">Time Control</th>
                  <th className="py-3 px-4">Rating</th>
                  <th className="py-3 px-4 text-right">Accuracy</th>
                  <th className="py-3 px-4 text-right">Blunders</th>
                  <th className="py-3 px-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {games.map((g) => {
                  const playedDate = g.playedAt ? new Date(g.playedAt).toLocaleDateString() : 'N/A';
                  const openingLabel = g.opening ? `${g.opening.eco} - ${g.opening.name}` : 'Unknown';
                  const tcLabel = g.timeControl
                    ? `${Math.floor((g.timeControl.baseSeconds || 0) / 60)}+${g.timeControl.incrementSeconds || 0}`
                    : 'N/A';
                  const ratingLabel = g.playerRating
                    ? `${g.playerRating} vs ${g.opponentRating || '?'}`
                    : 'Unrated';

                  return (
                    <tr
                      key={g.id}
                      onClick={() => navigate(`/games/${g.id}`)}
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors"
                    >
                      <td className="py-3 px-4 whitespace-nowrap text-gray-500 dark:text-gray-400 font-mono">
                        {playedDate}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold capitalize ${
                            g.result === 'win'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : g.result === 'loss'
                              ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {g.result || 'N/A'} ({g.color || 'white'})
                        </span>
                      </td>
                      <td className="py-3 px-4 max-w-[200px] truncate text-gray-900 dark:text-gray-100 font-medium" title={openingLabel}>
                        {openingLabel}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-gray-600 dark:text-gray-300 capitalize">
                        {tcLabel} {g.timeControl?.category ? `(${g.timeControl.category})` : ''}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-gray-600 dark:text-gray-300 font-mono">
                        {ratingLabel}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-right font-medium text-gray-900 dark:text-gray-100">
                        {g.accuracyPct !== null && g.accuracyPct !== undefined
                          ? `${Number(g.accuracyPct).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-right">
                        {g.analysisStatus === 'analyzed' ? (
                          <span
                            className={`font-semibold ${
                              g.blunders > 0
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-gray-600 dark:text-gray-300'
                            }`}
                          >
                            {g.blunders}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-center">
                        {g.analysisStatus === 'analyzed' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            Analyzed
                          </span>
                        ) : g.analysisStatus === 'failed' ? (
                          <span
                            title={g.failureReason || 'Analysis failed'}
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 cursor-help"
                          >
                            Failed
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
                            Pending
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        {!loading && games.length > 0 && (
          <div className="p-3 bg-gray-50 dark:bg-gray-700/50 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, totalGames)} of {totalGames} games
            </span>

            <div className="flex items-center space-x-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Previous
              </button>
              <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default GamesView;
