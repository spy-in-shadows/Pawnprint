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

export function shapeOpeningsData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const sorted = [...rows].sort((a, b) => (Number(b.moves) || 0) - (Number(a.moves) || 0));
  const top10 = sorted.slice(0, 10);

  return top10.map((item) => {
    const eco = item.eco || '???';
    const name = item.opening_name || item.name || 'Unknown';
    const plyBucket = item.ply_bucket || item.plyBucket || 'all';
    const moves = Number(item.moves || 0);
    const blunders = Number(item.blunders || 0);
    const blundersPer100 = moves > 0
      ? (item.blunders_per_100_moves !== undefined
          ? Number(item.blunders_per_100_moves)
          : Number(((blunders / moves) * 100).toFixed(2)))
      : 0;
    const avgCpLoss = Number(item.avg_cp_loss !== undefined ? item.avg_cp_loss : (item.avgCpLoss || 0));

    return {
      eco,
      name,
      displayName: `${eco} ${name} (${plyBucket})`,
      shortName: `${eco} ${name}`,
      plyBucket,
      moves,
      blunders,
      blundersPer100,
      avgCpLoss,
    };
  });
}

export function shapePhasesData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const phaseOrder = ['opening', 'middlegame', 'endgame'];
  const map = new Map();

  rows.forEach((r) => {
    if (r && (r.phase || r.name)) {
      const key = (r.phase || r.name).toLowerCase();
      map.set(key, r);
    }
  });

  return phaseOrder.map((phase) => {
    const r = map.get(phase);
    const moves = r ? Number(r.moves || r.total_moves || 0) : 0;
    const accuracy = r ? Number(r.accuracy_pct !== undefined ? r.accuracy_pct : (r.accuracy || 0)) : 0;
    const blunders = r ? Number(r.blunders || 0) : 0;
    const avgCpLoss = r ? Number(r.avg_cp_loss !== undefined ? r.avg_cp_loss : (r.avgCpLoss || 0)) : 0;

    return {
      phase: phase.charAt(0).toUpperCase() + phase.slice(1),
      phaseKey: phase,
      moves,
      accuracyPct: accuracy,
      blunders,
      avgCpLoss,
    };
  });
}

export function shapeTimePressureData(items = []) {
  const map = new Map();
  if (Array.isArray(items)) {
    items.forEach((item) => {
      if (item && item.bucket) {
        map.set(item.bucket, item);
      }
    });
  }

  return TIME_PRESSURE_BUCKET_ORDER.map((bucket) => {
    const existing = map.get(bucket);
    const moves = existing ? Number(existing.moves || 0) : 0;
    const blunders = existing ? Number(existing.blunders || 0) : 0;
    const blundersPer100 = moves > 0
      ? (existing.blunders_per_100_moves !== undefined
          ? Number(existing.blunders_per_100_moves)
          : Number(((blunders / moves) * 100).toFixed(2)))
      : 0;
    const avgCpLoss = existing ? Number(existing.avg_cp_loss !== undefined ? existing.avg_cp_loss : (existing.avgCpLoss || 0)) : 0;

    return {
      bucket,
      moves,
      blunders,
      blundersPer100,
      avgCpLoss,
    };
  });
}

export function shapeTrendData(rows = []) {
  if (!Array.isArray(rows)) return [];

  return rows.map((r) => {
    const dateStr = r.game_date || r.date || '';
    const date = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : '';
    const accuracyPct = Number(r.accuracy_pct !== undefined ? r.accuracy_pct : (r.accuracy || 0));
    const rollingAccuracy = Number(r.rolling_accuracy_pct !== undefined ? r.rolling_accuracy_pct : (r.rolling_accuracy || accuracyPct));
    const moves = Number(r.moves || 0);
    const avgCpLoss = Number(r.avg_cp_loss !== undefined ? r.avg_cp_loss : (r.avgCpLoss || 0));

    return {
      date,
      accuracyPct,
      rollingAccuracy,
      moves,
      avgCpLoss,
    };
  });
}

export function shapeMotifsData(rows = []) {
  if (!Array.isArray(rows)) return [];

  const motifMap = new Map();

  rows.forEach((row) => {
    if (!row || (!row.motif && !row.motif_name && !row.name)) return;
    const motifName = row.motif || row.motif_name || row.name;

    if (!motifMap.has(motifName)) {
      motifMap.set(motifName, {
        motif: motifName,
        displayName: motifName.replace(/_/g, ' '),
        allowed: 0,
        missed: 0,
        allowedCount: 0,
        missedCount: 0,
        totalErrors: 0,
      });
    }

    const entry = motifMap.get(motifName);
    const rate = Number(row.errors_per_100_moves !== undefined ? row.errors_per_100_moves : (row.errorsPer100Moves || 0));
    const count = Number(row.error_count !== undefined ? row.error_count : (row.errorCount || row.count || 0));

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
