import React, { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { validateDateRange, shouldStopPolling, calculateProgress } from '../lib/importUtils';

export function ImportView() {
  const [accounts, setAccounts] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState(null);

  // Link form state
  const [linkPlatform, setLinkPlatform] = useState('lichess');
  const [linkUsername, setLinkUsername] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);

  // Sync modal state
  const [syncAccount, setSyncAccount] = useState(null);
  const [syncMaxGames, setSyncMaxGames] = useState(50);
  const [syncSince, setSyncSince] = useState('');
  const [syncUntil, setSyncUntil] = useState('');
  const [syncError, setSyncError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // PGN upload state
  const [pgnFile, setPgnFile] = useState(null);
  const [pgnAccountId, setPgnAccountId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  // Active Job progress
  const [activeJob, setActiveJob] = useState(null);
  const pollTimerRef = useRef(null);

  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    setAccountsError(null);
    try {
      const data = await api.get('/accounts');
      const list = Array.isArray(data) ? data : data.items || [];
      setAccounts(list);
    } catch (err) {
      setAccountsError(err.message || 'Failed to load accounts');
    } finally {
      setLoadingAccounts(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  const clearPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, []);

  const trackJob = (jobId) => {
    clearPolling();
    if (!jobId) return;

    const poll = async () => {
      try {
        const job = await api.get(`/imports/${jobId}`);
        setActiveJob(job);
        if (shouldStopPolling(job.status)) {
          clearPolling();
          fetchAccounts();
        }
      } catch (err) {
        clearPolling();
      }
    };

    poll();
    pollTimerRef.current = setInterval(poll, 2000);
  };

  const handleLinkAccount = async (e) => {
    e.preventDefault();
    if (!linkUsername.trim()) return;

    setLinking(true);
    setLinkError(null);

    try {
      await api.post('/accounts', {
        platform: linkPlatform,
        username: linkUsername.trim(),
      });
      setLinkUsername('');
      await fetchAccounts();
    } catch (err) {
      setLinkError(err.message || 'Failed to link account');
    } finally {
      setLinking(false);
    }
  };

  const handleDeleteAccount = async (account) => {
    const confirmed = window.confirm(`Are you sure you want to unlink ${account.platform} account "${account.username}"?`);
    if (!confirmed) return;

    try {
      await api.delete(`/accounts/${account.id}`);
      await fetchAccounts();
    } catch (err) {
      alert(err.message || 'Failed to unlink account');
    }
  };

  const openSyncModal = (account) => {
    setSyncAccount(account);
    setSyncMaxGames(50);
    setSyncSince('');
    setSyncUntil('');
    setSyncError(null);
  };

  const closeSyncModal = () => {
    setSyncAccount(null);
    setSyncError(null);
  };

  const handleStartSync = async (e) => {
    e.preventDefault();
    if (!syncAccount) return;

    const { valid, error } = validateDateRange(syncSince, syncUntil);
    if (!valid) {
      setSyncError(error);
      return;
    }

    setSyncing(true);
    setSyncError(null);

    try {
      const payload = {
        accountId: syncAccount.id,
        maxGames: Number(syncMaxGames),
      };
      if (syncSince) payload.since = syncSince;
      if (syncUntil) payload.until = syncUntil;

      const res = await api.post('/imports', payload);
      closeSyncModal();
      const job = res.job || res;
      setActiveJob(job);
      if (job.id) {
        trackJob(job.id);
      }
    } catch (err) {
      setSyncError(err.message || 'Failed to start import job');
    } finally {
      setSyncing(false);
    }
  };

  const handlePgnUpload = async (e) => {
    e.preventDefault();
    if (!pgnFile) {
      setUploadError('Please select a PGN file.');
      return;
    }

    if (pgnFile.size > 10 * 1024 * 1024) {
      setUploadError('PGN file must be under 10MB.');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', pgnFile);
      if (pgnAccountId) {
        formData.append('accountId', pgnAccountId);
      }

      const res = await api.post('/uploads/pgn', formData);
      setPgnFile(null);
      const job = res.job || (res.jobId ? { id: res.jobId, status: 'queued' } : res);
      setActiveJob(job);
      if (job.id) {
        trackJob(job.id);
      }
      fetchAccounts();
    } catch (err) {
      setUploadError(err.message || 'PGN upload failed');
    } finally {
      setUploading(false);
    }
  };

  const getStatusBadge = (status) => {
    const s = String(status || '').toUpperCase();
    const colors = {
      QUEUED: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
      RUNNING: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
      COMPLETED: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
      FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    };
    return (
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${colors[s] || 'bg-gray-100 text-gray-800'}`}>
        {s || 'UNKNOWN'}
      </span>
    );
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Game Ingestion & Accounts
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Link online platform accounts or upload raw PGN files for analysis.
        </p>
      </div>

      {activeJob && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-3">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Import Job #{activeJob.id}
              </h2>
              {getStatusBadge(activeJob.status)}
            </div>
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
              {calculateProgress(activeJob.analyzed_games || activeJob.analyzedGames, activeJob.total_games || activeJob.totalGames)}%
            </span>
          </div>

          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
            <div
              className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300"
              style={{
                width: `${calculateProgress(
                  activeJob.analyzed_games || activeJob.analyzedGames,
                  activeJob.total_games || activeJob.totalGames
                )}%`,
              }}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400 block text-xs">Analyzed / Total</span>
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {activeJob.analyzed_games ?? activeJob.analyzedGames ?? 0} / {activeJob.total_games ?? activeJob.totalGames ?? 0}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400 block text-xs">Failed Games</span>
              <span className="font-semibold text-red-600 dark:text-red-400">
                {activeJob.failed_games ?? activeJob.failedGames ?? 0}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400 block text-xs">Skipped Games</span>
              <span className="font-semibold text-gray-600 dark:text-gray-300">
                {activeJob.skipped_games ?? activeJob.skippedGames ?? 0}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400 block text-xs">Status</span>
              <span className="font-semibold capitalize text-gray-900 dark:text-gray-100">
                {activeJob.status}
              </span>
            </div>
          </div>

          {(activeJob.status === 'failed' || activeJob.error) && (
            <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
              <span className="font-semibold">Import failed: </span>
              {activeJob.error || 'An unexpected engine or ingestion failure occurred.'}
            </div>
          )}
        </div>
      )}

      {/* Linked Accounts Section */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Linked Accounts
        </h2>

        {accountsError ? (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 flex justify-between items-center">
            <span>{accountsError}</span>
            <button
              onClick={fetchAccounts}
              className="px-3 py-1 bg-red-100 dark:bg-red-800 rounded text-xs font-semibold hover:bg-red-200"
            >
              Retry
            </button>
          </div>
        ) : loadingAccounts ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading accounts...</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">No accounts linked yet.</p>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {accounts.map((acc) => (
              <div key={acc.id} className="py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                    {acc.platform}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400 ml-2">@{acc.username}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 block">
                    Last synced: {acc.last_synced_at || acc.lastSyncedAt ? new Date(acc.last_synced_at || acc.lastSyncedAt).toLocaleString() : 'Never'}
                  </span>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => openSyncModal(acc)}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 hover:bg-indigo-100"
                  >
                    Sync
                  </button>
                  <button
                    onClick={() => handleDeleteAccount(acc)}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300 hover:bg-red-100"
                  >
                    Unlink
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Link Account Form */}
        <form onSubmit={handleLinkAccount} className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Platform
            </label>
            <select
              value={linkPlatform}
              onChange={(e) => setLinkPlatform(e.target.value)}
              className="px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
            >
              <option value="lichess">Lichess</option>
              <option value="chesscom">Chess.com</option>
            </select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Username
            </label>
            <input
              type="text"
              required
              value={linkUsername}
              onChange={(e) => setLinkUsername(e.target.value)}
              placeholder="e.g. magnuscarlsen"
              className="w-full px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={linking}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {linking ? 'Linking...' : 'Link Account'}
          </button>
        </form>
        {linkError && <p className="mt-2 text-xs text-red-600">{linkError}</p>}
      </div>

      {/* PGN File Upload Section */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Upload PGN File
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Upload a standard PGN file (up to 10MB) to ingest and queue for analysis.
        </p>

        <form onSubmit={handlePgnUpload} className="space-y-4">
          {accounts.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Associate with Account (Optional)
              </label>
              <select
                value={pgnAccountId}
                onChange={(e) => setPgnAccountId(e.target.value)}
                className="w-full sm:w-80 px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
              >
                <option value="">None / Standalone</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.platform} - {a.username}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <input
              type="file"
              accept=".pgn"
              onChange={(e) => setPgnFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
            />
          </div>

          <button
            type="submit"
            disabled={uploading || !pgnFile}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload and Analyze'}
          </button>
        </form>
        {uploadError && <p className="mt-2 text-xs text-red-600">{uploadError}</p>}
      </div>

      {/* Sync Modal */}
      {syncAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Sync {syncAccount.platform} (@{syncAccount.username})
            </h3>

            {syncError && (
              <div className="p-3 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded text-sm">
                {syncError}
              </div>
            )}

            <form onSubmit={handleStartSync} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Most recent N games
                </label>
                <select
                  value={syncMaxGames}
                  onChange={(e) => setSyncMaxGames(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
                >
                  <option value={10}>10 games</option>
                  <option value={25}>25 games</option>
                  <option value={50}>50 games</option>
                  <option value={100}>100 games</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  From Date (Optional)
                </label>
                <input
                  type="date"
                  value={syncSince}
                  onChange={(e) => setSyncSince(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  To Date (Optional)
                </label>
                <input
                  type="date"
                  value={syncUntil}
                  onChange={(e) => setSyncUntil(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md dark:bg-gray-900 dark:border-gray-700 text-sm"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={closeSyncModal}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={syncing}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium disabled:opacity-50"
                >
                  {syncing ? 'Starting...' : 'Start Sync'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default ImportView;
