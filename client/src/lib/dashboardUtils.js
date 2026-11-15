export const TIME_PRESSURE_BUCKET_ORDER = ['>50%', '25-50%', '10-25%', '<10%'];

export function validateDateRange(from, to) {
  if (!from && !to) {
    return { valid: true, error: null };
  }

  let fromDate = null;
  let toDate = null;

  if (from) {
    fromDate = new Date(from);
    if (isNaN(fromDate.getTime())) {
      return { valid: false, error: 'Invalid from date format' };
    }
  }

  if (to) {
    toDate = new Date(to);
    if (isNaN(toDate.getTime())) {
      return { valid: false, error: 'Invalid to date format' };
    }
  }

  if (fromDate && toDate && fromDate > toDate) {
    return { valid: false, error: 'From date cannot be after To date' };
  }

  return { valid: true, error: null };
}

// The shaping helpers read the row shapes returned by src/repositories/analytics.repo.js.

export function shapeOpeningsData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const sorted = [...rows].sort((a, b) => (Number(b.moves) || 0) - (Number(a.moves) || 0));

  return sorted.slice(0, 10).map((item) => {
    const eco = item.eco || '???';
    const name = item.name || 'Unknown';
    const plyBucket = item.plyBucket || 'all';
    return {
      eco,
      name,
      displayName: `${eco} ${name} (${plyBucket})`,
      shortName: `${eco} ${name}`,
      plyBucket,
      moves: Number(item.moves || 0),
      blunders: Number(item.blunders || 0),
      blundersPer100: Number(item.blundersPer100 || 0),
      avgCpLoss: Number(item.avgCpLoss || 0),
    };
  });
}

export function shapePhasesData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const phaseOrder = ['opening', 'middlegame', 'endgame'];
  const byPhase = new Map();
  rows.forEach((r) => {
    if (r && r.phase) byPhase.set(r.phase.toLowerCase(), r);
  });

  return phaseOrder.map((phase) => {
    const r = byPhase.get(phase) || {};
    return {
      phase: phase.charAt(0).toUpperCase() + phase.slice(1),
      phaseKey: phase,
      moves: Number(r.moves || 0),
      accuracyPct: Number(r.accuracyPct || 0),
      blunders: Number(r.blunders || 0),
      avgCpLoss: Number(r.avgCpLoss || 0),
    };
  });
}

export function shapeTimePressureData(items = []) {
  const byBucket = new Map();
  if (Array.isArray(items)) {
    items.forEach((item) => {
      if (item && item.bucket) byBucket.set(item.bucket, item);
    });
  }

  return TIME_PRESSURE_BUCKET_ORDER.map((bucket) => {
    const r = byBucket.get(bucket) || {};
    return {
      bucket,
      moves: Number(r.moves || 0),
      blunders: Number(r.blunders || 0),
      blundersPer100: Number(r.blundersPer100 || 0),
      avgCpLoss: Number(r.avgCpLoss || 0),
    };
  });
}

export function shapeTrendData(rows = []) {
  if (!Array.isArray(rows)) return [];

  // `day` is already a YYYY-MM-DD string in UTC; parsing it as a Date would shift it by the viewer's zone.
  return rows.map((r) => ({
    date: r.day || '',
    games: Number(r.games || 0),
    accuracyPct: Number(r.accuracyPct || 0),
    rollingAccuracy: Number(r.rollingAccuracyPct || 0),
    avgCpLoss: Number(r.avgCpLoss || 0),
  }));
}

export function shapeMotifsData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const motifMap = new Map();

  rows.forEach((row) => {
    if (!row || !row.motif) return;

    if (!motifMap.has(row.motif)) {
      motifMap.set(row.motif, {
        motif: row.motif,
        displayName: row.motif.replace(/_/g, ' '),
        allowed: 0,
        missed: 0,
        allowedCount: 0,
        missedCount: 0,
        totalErrors: 0,
      });
    }

    const entry = motifMap.get(row.motif);
    const rate = Number(row.errorsPer100Moves || 0);
    const count = Number(row.errorCount || 0);

    if (row.kind === 'allowed') {
      entry.allowed = rate;
      entry.allowedCount = count;
    } else if (row.kind === 'missed') {
      entry.missed = rate;
      entry.missedCount = count;
    }
    entry.totalErrors += count;
  });

  return Array.from(motifMap.values()).sort(
    (a, b) => (b.allowed + b.missed) - (a.allowed + a.missed)
  );
}

export function shapeSummaryMetrics(summaryData) {
  if (!summaryData) {
    return {
      analyzedGames: 0,
      accuracyPct: 0,
      blundersPer100: 0,
      avgCpLoss: 0,
      totalMoves: 0,
      blunders: 0,
    };
  }

  let analyzedGames = 0;
  let totalMoves = 0;
  let blunders = 0;
  let weightedCpLossSum = 0;
  let weightedAccSum = 0;

  const accounts = summaryData.accounts || (summaryData.accountId ? [summaryData] : (Array.isArray(summaryData) ? summaryData : []));

  accounts.forEach((acc) => {
    const ag = Number(acc.analyzedGames !== undefined ? acc.analyzedGames : (acc.analyzed_games || 0));
    const tm = Number(acc.totalMoves !== undefined ? acc.totalMoves : (acc.total_moves || 0));
    const b = Number(acc.blunders || 0);
    const cpl = Number(acc.avgCpLoss !== undefined ? acc.avgCpLoss : (acc.avg_cp_loss || 0));
    const accPct = Number(acc.accuracyPct !== undefined ? acc.accuracyPct : (acc.accuracy_pct || 0));

    analyzedGames += ag;
    totalMoves += tm;
    blunders += b;
    weightedCpLossSum += cpl * tm;
    weightedAccSum += accPct * tm;
  });

  const blundersPer100 = totalMoves > 0 ? Number(((blunders / totalMoves) * 100).toFixed(2)) : 0;
  const avgCpLoss = totalMoves > 0 ? Number((weightedCpLossSum / totalMoves).toFixed(1)) : 0;
  const accuracyPct = totalMoves > 0 ? Number((weightedAccSum / totalMoves).toFixed(1)) : 0;

  return {
    analyzedGames,
    accuracyPct,
    blundersPer100,
    avgCpLoss,
    totalMoves,
    blunders,
  };
}
