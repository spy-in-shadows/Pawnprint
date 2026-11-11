export function validateDateRange(from, to) {
  if (!from || !to) {
    return { valid: true, error: null };
  }
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();

  if (isNaN(fromTime) || isNaN(toTime)) {
    return { valid: false, error: 'Invalid date format' };
  }

  if (fromTime > toTime) {
    return { valid: false, error: 'From date cannot be after To date' };
  }

  return { valid: true, error: null };
}

export function shouldStopPolling(status) {
  if (!status) return false;
  const normalized = String(status).toLowerCase();
  return normalized === 'completed' || normalized === 'failed';
}

export function calculateProgress(analyzed, total) {
  const safeTotal = Number(total) || 0;
  const safeAnalyzed = Number(analyzed) || 0;

  if (safeTotal <= 0) {
    return 0;
  }

  const pct = Math.round((safeAnalyzed / safeTotal) * 100);
  return Math.max(0, Math.min(100, pct));
}
