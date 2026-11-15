import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { api } from '../lib/api';
import {
  validateDateRange,
  shapeOpeningsData,
  shapePhasesData,
  shapeTimePressureData,
  shapeTrendData,
  shapeMotifsData,
  shapeSummaryMetrics,
} from '../lib/dashboardUtils';

function ChartCard({
  title,
  subtitle,
  loading,
  error,
  isEmpty,
  onRetry,
  tableData,
  tableColumns,
  children,
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 shadow-sm flex flex-col justify-between">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
      </div>

      <div className="relative min-h-[280px] w-full flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
            <svg
              className="animate-spin h-7 w-7 mb-2 text-blue-600 dark:text-blue-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
            <span>Loading chart data...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center text-center p-4">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium mb-3">{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 text-xs font-semibold rounded bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && isEmpty && (
          <div className="flex flex-col items-center justify-center text-center p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">No analyzed game data available.</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              Sync accounts or upload PGN files to see your analytics.
            </p>
            <Link
              to="/import"
              className="inline-flex items-center text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
            >
              Go to Import &rarr;
            </Link>
          </div>
        )}

        {!loading && !error && !isEmpty && (
          <div className="w-full h-[280px]">
            {children}
            {tableData && tableColumns && (
              <div className="sr-only">
                <table aria-label={`${title} fallback data table`}>
                  <thead>
                    <tr>
                      {tableColumns.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableData.map((row, idx) => (
                      <tr key={idx}>
                        {tableColumns.map((c) => (
                          <td key={c.key}>{String(row[c.key] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function DashboardView() {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [dateError, setDateError] = useState(null);

  const [summaryData, setSummaryData] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(null);

  const [openingsState, setOpeningsState] = useState({ data: [], loading: true, error: null });
  const [phasesState, setPhasesState] = useState({ data: [], loading: true, error: null });
  const [timePressureState, setTimePressureState] = useState({ data: [], loading: true, error: null });
  const [trendState, setTrendState] = useState({ data: [], loading: true, error: null });
  const [motifsState, setMotifsState] = useState({ data: [], loading: true, error: null });

  useEffect(() => {
    let isMounted = true;
    api
      .get('/accounts')
      .then((res) => {
        if (!isMounted) return;
        const list = Array.isArray(res) ? res : res.items || [];
        setAccounts(list);
      })
      .catch(() => {
        // Fallback gracefully if accounts endpoint cannot be reached
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const buildQuery = useCallback(
    (extraParams = {}) => {
      const q = new URLSearchParams();
      if (selectedAccountId) {
        q.append('accountId', selectedAccountId);
      }
      if (fromDate) {
        q.append('from', fromDate);
      }
      if (toDate) {
        q.append('to', toDate);
      }
      Object.entries(extraParams).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          q.append(k, v);
        }
      });
      const str = q.toString();
      return str ? `?${str}` : '';
    },
    [selectedAccountId, fromDate, toDate]
  );

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const query = selectedAccountId ? `?accountId=${selectedAccountId}` : '';
      const res = await api.get(`/analytics/summary${query}`);
      setSummaryData(res);
    } catch (err) {
      setSummaryError(err.message || 'Failed to load summary');
    } finally {
      setSummaryLoading(false);
    }
  }, [selectedAccountId]);

  const fetchOpenings = useCallback(async () => {
    setOpeningsState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(`/analytics/openings${buildQuery()}`);
      const raw = Array.isArray(res) ? res : res.items || [];
      setOpeningsState({ data: shapeOpeningsData(raw), loading: false, error: null });
    } catch (err) {
      setOpeningsState({ data: [], loading: false, error: err.message || 'Failed to load openings' });
    }
  }, [buildQuery]);

  const fetchPhases = useCallback(async () => {
    setPhasesState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(`/analytics/phases${buildQuery()}`);
      const raw = Array.isArray(res) ? res : res.items || [];
      setPhasesState({ data: shapePhasesData(raw), loading: false, error: null });
    } catch (err) {
      setPhasesState({ data: [], loading: false, error: err.message || 'Failed to load phase analytics' });
    }
  }, [buildQuery]);

  const fetchTimePressure = useCallback(async () => {
    setTimePressureState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(`/analytics/time-pressure${buildQuery()}`);
      const raw = Array.isArray(res) ? res : res.items || [];
      setTimePressureState({ data: shapeTimePressureData(raw), loading: false, error: null });
    } catch (err) {
      setTimePressureState({
        data: [],
        loading: false,
        error: err.message || 'Failed to load time pressure analytics',
      });
    }
  }, [buildQuery]);

  const fetchTrend = useCallback(async () => {
    setTrendState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(`/analytics/trend${buildQuery()}`);
      const raw = Array.isArray(res) ? res : res.items || [];
      setTrendState({ data: shapeTrendData(raw), loading: false, error: null });
    } catch (err) {
      setTrendState({ data: [], loading: false, error: err.message || 'Failed to load trend analytics' });
    }
  }, [buildQuery]);

  const fetchMotifs = useCallback(async () => {
    setMotifsState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(`/analytics/motifs${buildQuery()}`);
      const raw = Array.isArray(res) ? res : res.items || [];
      setMotifsState({ data: shapeMotifsData(raw), loading: false, error: null });
    } catch (err) {
      setMotifsState({ data: [], loading: false, error: err.message || 'Failed to load motif analytics' });
    }
  }, [buildQuery]);

  useEffect(() => {
    const { valid, error } = validateDateRange(fromDate, toDate);
    if (!valid) {
      setDateError(error);
      return;
    }
    setDateError(null);

    fetchSummary();
    fetchOpenings();
    fetchPhases();
    fetchTimePressure();
    fetchTrend();
    fetchMotifs();
  }, [fromDate, toDate, selectedAccountId, fetchSummary, fetchOpenings, fetchPhases, fetchTimePressure, fetchTrend, fetchMotifs]);

  const metrics = shapeSummaryMetrics(summaryData);

  return (
    <div className="space-y-6">
      {/* Page Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Analytics Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Longitudinal insights across openings, game phases, time pressure, and tactical motifs.
          </p>
        </div>

        {/* Global Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center space-x-1.5">
            <label htmlFor="account-select" className="text-xs font-medium text-gray-700 dark:text-gray-300">
              Account:
            </label>
            <select
              id="account-select"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
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
            <label htmlFor="from-date" className="text-xs font-medium text-gray-700 dark:text-gray-300">
              From:
            </label>
            <input
              type="date"
              id="from-date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center space-x-1.5">
            <label htmlFor="to-date" className="text-xs font-medium text-gray-700 dark:text-gray-300">
              To:
            </label>
            <input
              type="date"
              id="to-date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {dateError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-xs font-medium text-red-700 dark:text-red-300">
          {dateError}
        </div>
      )}

      {/* Summary Tiles from /analytics/summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Analyzed games */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Analyzed Games</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
            {summaryLoading ? '...' : metrics.analyzedGames.toLocaleString()}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            {metrics.totalMoves.toLocaleString()} total moves evaluated
          </p>
        </div>

        {/* Accuracy */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Overall Accuracy</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-2">
            {summaryLoading ? '...' : `${metrics.accuracyPct}%`}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Win-probability based move rating</p>
        </div>

        {/* Blunders per 100 moves */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Blunders per 100 Moves</p>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-2">
            {summaryLoading ? '...' : metrics.blundersPer100}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{metrics.blunders} total blunder moves</p>
        </div>

        {/* Average centipawn loss */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Average CP Loss</p>
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-2">
            {summaryLoading ? '...' : metrics.avgCpLoss}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Centipawns per played move</p>
        </div>
      </div>

      {summaryError && (
        <div className="text-xs text-red-600 dark:text-red-400 flex items-center justify-between bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
          <span>Failed to load summary rollups: {summaryError}</span>
          <button
            type="button"
            onClick={fetchSummary}
            className="underline font-semibold hover:text-red-800 dark:hover:text-red-200 ml-2"
          >
            Retry
          </button>
        </div>
      )}

      {/* SVG Pattern Definitions for Allowed vs Missed Accessibility */}
      <svg className="sr-only" aria-hidden="true">
        <defs>
          <pattern id="pattern-allowed" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#ef4444" strokeWidth="2" />
          </pattern>
          <pattern id="pattern-missed" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#f59e0b" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>

      {/* Grid of 5 Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 1. Opening blunder rate (bars by opening and ply bucket, top 10 by moves, ECO + name labels) */}
        <ChartCard
          title="Opening Blunder Rate"
          subtitle="Top 10 openings by moves with blunder rate per 100 moves"
          loading={openingsState.loading}
          error={openingsState.error}
          isEmpty={openingsState.data.length === 0}
          onRetry={fetchOpenings}
          tableData={openingsState.data}
          tableColumns={[
            { key: 'eco', label: 'ECO' },
            { key: 'name', label: 'Opening Name' },
            { key: 'plyBucket', label: 'Ply Bucket' },
            { key: 'moves', label: 'Moves' },
            { key: 'blundersPer100', label: 'Blunders/100 Moves' },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={openingsState.data}
              margin={{ top: 10, right: 20, left: -10, bottom: 40 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis
                dataKey="shortName"
                angle={-25}
                textAnchor="end"
                interval={0}
                tick={{ fontSize: 10, fill: 'var(--chart-text)' }}
                height={50}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                label={{
                  value: 'Blunders / 100',
                  angle: -90,
                  position: 'insideLeft',
                  fontSize: 11,
                  fill: 'var(--chart-text)',
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #1f2937)',
                  borderColor: '#374151',
                  borderRadius: '0.375rem',
                  fontSize: '12px',
                  color: '#f9fafb',
                }}
                formatter={(val, name, item) => [
                  `${val} blunders/100 (${item.payload.blunders} blunders in ${item.payload.moves} moves, bucket ${item.payload.plyBucket})`,
                  'Blunder Rate',
                ]}
                labelFormatter={(label, items) => {
                  if (items && items[0]) {
                    return items[0].payload.displayName;
                  }
                  return label;
                }}
              />
              <Bar dataKey="blundersPer100" fill="var(--chart-danger)" radius={[4, 4, 0, 0]} name="Blunder Rate" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 2. Phase accuracy (bars with moves count in the tooltip) */}
        <ChartCard
          title="Phase Accuracy"
          subtitle="Accuracy percentage across opening, middlegame, and endgame"
          loading={phasesState.loading}
          error={phasesState.error}
          isEmpty={phasesState.data.every((p) => p.moves === 0)}
          onRetry={fetchPhases}
          tableData={phasesState.data}
          tableColumns={[
            { key: 'phase', label: 'Phase' },
            { key: 'moves', label: 'Moves Count' },
            { key: 'accuracyPct', label: 'Accuracy %' },
            { key: 'avgCpLoss', label: 'Avg CP Loss' },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={phasesState.data}
              margin={{ top: 10, right: 20, left: -10, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="phase" tick={{ fontSize: 12, fill: 'var(--chart-text)' }} />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                label={{
                  value: 'Accuracy %',
                  angle: -90,
                  position: 'insideLeft',
                  fontSize: 11,
                  fill: 'var(--chart-text)',
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #1f2937)',
                  borderColor: '#374151',
                  borderRadius: '0.375rem',
                  fontSize: '12px',
                  color: '#f9fafb',
                }}
                formatter={(val, name, item) => [
                  `${val}% accuracy (${item.payload.moves} moves evaluated, avg loss ${item.payload.avgCpLoss} cp)`,
                  'Phase Accuracy',
                ]}
              />
              <Bar dataKey="accuracyPct" fill="var(--chart-primary)" radius={[4, 4, 0, 0]} name="Accuracy %" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 3. Time-pressure blunder rate by bucket in the order >50%, 25-50%, 10-25%, <10% */}
        <ChartCard
          title="Time Pressure Blunder Rate"
          subtitle="Blunder frequency across clock remaining buckets"
          loading={timePressureState.loading}
          error={timePressureState.error}
          isEmpty={timePressureState.data.every((b) => b.moves === 0)}
          onRetry={fetchTimePressure}
          tableData={timePressureState.data}
          tableColumns={[
            { key: 'bucket', label: 'Clock Remaining' },
            { key: 'moves', label: 'Moves' },
            { key: 'blunders', label: 'Blunders' },
            { key: 'blundersPer100', label: 'Blunders/100 Moves' },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={timePressureState.data}
              margin={{ top: 10, right: 20, left: -10, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: 'var(--chart-text)' }} />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                label={{
                  value: 'Blunders / 100',
                  angle: -90,
                  position: 'insideLeft',
                  fontSize: 11,
                  fill: 'var(--chart-text)',
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #1f2937)',
                  borderColor: '#374151',
                  borderRadius: '0.375rem',
                  fontSize: '12px',
                  color: '#f9fafb',
                }}
                formatter={(val, name, item) => [
                  `${val} blunders/100 (${item.payload.blunders} blunders in ${item.payload.moves} moves)`,
                  'Blunder Rate',
                ]}
              />
              <Bar dataKey="blundersPer100" fill="var(--chart-warning)" radius={[4, 4, 0, 0]} name="Blunder Rate" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 4. Trend (line with raw and rolling accuracy) */}
        <ChartCard
          title="Accuracy Trend"
          subtitle="Longitudinal performance: raw daily accuracy vs 7-day rolling accuracy"
          loading={trendState.loading}
          error={trendState.error}
          isEmpty={trendState.data.length === 0}
          onRetry={fetchTrend}
          tableData={trendState.data}
          tableColumns={[
            { key: 'date', label: 'Date' },
            { key: 'accuracyPct', label: 'Daily Accuracy %' },
            { key: 'rollingAccuracy', label: 'Rolling Accuracy %' },
            { key: 'games', label: 'Games' },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={trendState.data}
              margin={{ top: 10, right: 20, left: -10, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--chart-text)' }} />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                label={{
                  value: 'Accuracy %',
                  angle: -90,
                  position: 'insideLeft',
                  fontSize: 11,
                  fill: 'var(--chart-text)',
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #1f2937)',
                  borderColor: '#374151',
                  borderRadius: '0.375rem',
                  fontSize: '12px',
                  color: '#f9fafb',
                }}
                formatter={(val, name, item) => [
                  `${val}% (${item.payload.games} games on ${item.payload.date})`,
                  name,
                ]}
              />
              <Legend verticalAlign="top" height={36} wrapperStyle={{ fontSize: '12px' }} />
              <Line
                type="monotone"
                dataKey="accuracyPct"
                stroke="var(--chart-muted)"
                strokeDasharray="4 4"
                dot={{ r: 2 }}
                name="Raw Accuracy"
              />
              <Line
                type="monotone"
                dataKey="rollingAccuracy"
                stroke="var(--chart-primary)"
                strokeWidth={2.5}
                dot={false}
                name="Rolling Accuracy"
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 5. Motif weakness (bars, allowed vs missed as two series, labelled "errors per 100 moves") */}
        <div className="lg:col-span-2">
          <ChartCard
            title="Tactical Motif Weaknesses"
            subtitle="Frequency of allowed opponent tactics vs missed player tactics (errors per 100 moves)"
            loading={motifsState.loading}
            error={motifsState.error}
            isEmpty={motifsState.data.length === 0}
            onRetry={fetchMotifs}
            tableData={motifsState.data}
            tableColumns={[
              { key: 'displayName', label: 'Tactical Motif' },
              { key: 'allowed', label: 'Allowed (errors/100 moves)' },
              { key: 'missed', label: 'Missed (errors/100 moves)' },
              { key: 'totalErrors', label: 'Total Errors' },
            ]}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={motifsState.data}
                margin={{ top: 10, right: 20, left: 0, bottom: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis
                  dataKey="displayName"
                  angle={-20}
                  textAnchor="end"
                  interval={0}
                  tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                  height={50}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                  label={{
                    value: 'Errors / 100 Moves',
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 11,
                    fill: 'var(--chart-text)',
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--tooltip-bg, #1f2937)',
                    borderColor: '#374151',
                    borderRadius: '0.375rem',
                    fontSize: '12px',
                    color: '#f9fafb',
                  }}
                  formatter={(val, name, item) => {
                    const count = name.includes('Allowed') ? item.payload.allowedCount : item.payload.missedCount;
                    return [`${val} (${count} errors)`, name];
                  }}
                />
                <Legend
                  verticalAlign="top"
                  height={36}
                  wrapperStyle={{ fontSize: '12px' }}
                  formatter={(value) => <span style={{ color: 'var(--chart-text)' }}>{value}</span>}
                />
                <Bar
                  dataKey="allowed"
                  fill="url(#pattern-allowed)"
                  stroke="var(--chart-allowed)"
                  strokeWidth={1.5}
                  name="Allowed (errors per 100 moves)"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="missed"
                  fill="url(#pattern-missed)"
                  stroke="var(--chart-missed)"
                  strokeWidth={1.5}
                  name="Missed (errors per 100 moves)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

export default DashboardView;
