'use strict';

const DEAD_ENDPOINT_DAYS = 21;
const REGRESSION_THRESHOLD = 0.20; // 20% worse P90 triggers regression insight
const ANOMALY_Z_THRESHOLD = 2.5;   // Z-score threshold for latency anomaly

function getInsights(db) {
  const insights = [];

  try {
    insights.push(...detectLatencyAnomalies(db));
  } catch (_) {}

  try {
    insights.push(...detectDeadEndpoints(db));
  } catch (_) {}

  try {
    insights.push(...detectReleaseRegressions(db));
  } catch (_) {}

  try {
    insights.push(...detectUntrackedRoutes(db));
  } catch (_) {}

  return insights;
}

function detectUntrackedRoutes(db) {
  const untracked = db.getUntrackedRoutes();
  return untracked.map((r) => ({
    type: 'UNTRACKED',
    severity: 'info',
    route: r.route,
    method: r.method,
    message: `\`${r.method} ${r.route}\` est déclaré dans l'application mais n'a reçu aucune requête depuis le début du monitoring.`,
    data: { first_seen_ts: r.first_seen },
  }));
}

function detectLatencyAnomalies(db) {
  const { recent, baselineRows } = db.getLatencyAnomalyData();
  if (recent.length === 0 || baselineRows.length === 0) return [];

  // Build baseline stats per route+method
  const baselineMap = new Map();
  for (const row of baselineRows) {
    const key = `${row.method}|${row.route}`;
    if (!baselineMap.has(key)) baselineMap.set(key, []);
    baselineMap.get(key).push(row.lat_p99);
  }

  const insights = [];
  for (const r of recent) {
    const key = `${r.method}|${r.route}`;
    const samples = baselineMap.get(key);
    if (!samples || samples.length < 5) continue; // not enough baseline data

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const stdev = Math.sqrt(variance);

    if (stdev === 0) continue;
    const z = (r.avg_p99 - mean) / stdev;

    if (z >= ANOMALY_Z_THRESHOLD) {
      insights.push({
        type: 'ANOMALY',
        severity: 'warning',
        route: r.route,
        method: r.method,
        message: `La latence P99 de \`${r.method} ${r.route}\` est anormalement élevée cette heure (${fmt(r.avg_p99)} vs moyenne ${fmt(mean)} — Z-score ${z.toFixed(1)}).`,
        data: { current_p99: r.avg_p99, baseline_p99: mean, z_score: z },
      });
    }
  }

  return insights;
}

function detectDeadEndpoints(db) {
  const candidates = db.getDeadCandidates(DEAD_ENDPOINT_DAYS);
  return candidates.map((row) => {
    const daysSince = Math.floor((Date.now() / 1000 - row.last_seen) / 86_400);
    return {
      type: 'DEAD',
      severity: 'info',
      route: row.route,
      method: row.method,
      message: `\`${row.method} ${row.route}\` n'a reçu aucune requête depuis ${daysSince} jours. Candidat à la déprécation.`,
      data: { last_seen_ts: row.last_seen, inactive_days: daysSince },
    };
  });
}

function detectReleaseRegressions(db) {
  const comparison = db.getReleaseComparison();
  if (!comparison) return [];

  const { release_tag, before, after } = comparison;

  const beforeMap = new Map(before.map((r) => [`${r.method}|${r.route}`, r]));
  const insights = [];

  for (const a of after) {
    const key = `${a.method}|${a.route}`;
    const b = beforeMap.get(key);
    if (!b || b.avg_p90 === null || a.avg_p90 === null || b.avg_p90 === 0) continue;

    const delta = (a.avg_p90 - b.avg_p90) / b.avg_p90;

    if (delta >= REGRESSION_THRESHOLD) {
      insights.push({
        type: 'PERF',
        severity: 'error',
        route: a.route,
        method: a.method,
        message: `La latence P90 de \`${a.method} ${a.route}\` a augmenté de ${pct(delta)} depuis le déploiement ${release_tag}. Avant : ${fmt(b.avg_p90)} — Après : ${fmt(a.avg_p90)}.`,
        data: {
          release: release_tag,
          before_p90: b.avg_p90,
          after_p90: a.avg_p90,
          delta_pct: delta * 100,
        },
      });
    } else if (delta <= -REGRESSION_THRESHOLD) {
      insights.push({
        type: 'OK',
        severity: 'success',
        route: a.route,
        method: a.method,
        message: `Le déploiement ${release_tag} a amélioré \`${a.method} ${a.route}\` de ${pct(-delta)}. Avant : ${fmt(b.avg_p90)} — Après : ${fmt(a.avg_p90)}.`,
        data: {
          release: release_tag,
          before_p90: b.avg_p90,
          after_p90: a.avg_p90,
          delta_pct: delta * 100,
        },
      });
    }
  }

  return insights;
}

function computeHealthScore(db) {
  try {
    const { recent, baseline, activeRoutes, totalRoutes } = db.getSummary();

    const total = recent?.calls_total || 0;
    if (total === 0) return null;

    // Availability: 2xx rate (weight 30%)
    const availability = Math.min(100, ((recent.calls_2xx || 0) / total) * 100);

    // Performance: P90 vs 7d baseline (weight 30%)
    let performance = 100;
    if (baseline?.baseline_p90 && recent?.avg_p90 && baseline.baseline_p90 > 0) {
      const ratio = recent.avg_p90 / baseline.baseline_p90;
      performance = Math.max(0, Math.min(100, 100 - (ratio - 1) * 100));
    }

    // Stability: 100 by default at MVP (no complex drift detection)
    const stability = 100;

    // Quality: active routes vs total ever seen (weight 15%)
    const quality = totalRoutes > 0 ? Math.min(100, (activeRoutes / totalRoutes) * 100) : 100;

    const score = availability * 0.30 + performance * 0.30 + stability * 0.25 + quality * 0.15;
    return Math.round(score);
  } catch (_) {
    return null;
  }
}

function fmt(ms) {
  if (ms == null) return 'N/A';
  return `${Math.round(ms)}ms`;
}

function pct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

module.exports = { getInsights, computeHealthScore };
