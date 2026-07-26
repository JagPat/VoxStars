'use strict';

const MODEL_VERSION = 'forecast-v1';
const DEFAULT_MODEL = Object.freeze({ halfLifeDays: 21, baselineGames: 3, minSd: 8, maxSd: 55 });
const DAY = 86400000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;

function weightedMoments(values, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!values.length || total <= 0) return { mean: null, variance: null, weight: 0 };
  const mean = values.reduce((s, v, i) => s + v * weights[i], 0) / total;
  const variance = values.reduce((s, v, i) => s + weights[i] * (v - mean) ** 2, 0) / total;
  return { mean, variance, weight: total };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function robustOutlierIds(games) {
  if (games.length < 4) return [];
  const med = median(games.map(g => g.score));
  const mad = median(games.map(g => Math.abs(g.score - med)));
  return games.filter(g => mad === 0 ? Math.abs(g.score - med) >= 50
    : (0.6745 * Math.abs(g.score - med) / mad) > 3.5).map(g => g.id).filter(Boolean);
}

function forecastPlayer(meta, player, options = {}) {
  const cfg = { ...DEFAULT_MODEL, ...(options.model || {}) };
  const evaluationMs = Date.parse((options.evaluationDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const games = (player.games || []).filter(g => g.optimizerIncluded !== false && Number.isFinite(Number(g.score)));
  const weights = games.map(g => {
    const when = Date.parse(String(g.date || '') + 'T00:00:00Z');
    const age = Number.isFinite(when) ? Math.max(0, (evaluationMs - when) / DAY) : cfg.halfLifeDays;
    return Math.exp(-Math.LN2 * age / cfg.halfLifeDays);
  });
  const scores = games.map(g => Number(g.score));
  const current = weightedMoments(scores, weights);
  const baseline = Number.isFinite(options.squadBaseline) ? options.squadBaseline : 100;
  const squadSd = clamp(Number(options.squadSd) || 25, cfg.minSd, cfg.maxSd);
  const priorWeight = Number.isFinite(meta.lgAvg) && Number(meta.lgM) > 0 ? Math.min(Number(meta.lgM), 6) * 0.75 : 0;
  const estimateWeight = !priorWeight && Number.isFinite(player.estAvg) ? 2 : 0;
  const numerator = baseline * cfg.baselineGames +
    (priorWeight ? Number(meta.lgAvg) * priorWeight : 0) +
    (estimateWeight ? Number(player.estAvg) * estimateWeight : 0) +
    scores.reduce((s, v, i) => s + v * weights[i], 0);
  const evidenceWeight = priorWeight + estimateWeight + current.weight;
  const denominator = cfg.baselineGames + evidenceWeight;
  const mean = clamp(numerator / denominator, 0, 300);
  let sd;
  if (!evidenceWeight) sd = cfg.maxSd;
  else {
    const varianceWeight = current.weight / (current.weight + 5);
    const observed = current.variance == null ? squadSd ** 2 : current.variance;
    sd = clamp(Math.sqrt(varianceWeight * observed + (1 - varianceWeight) * squadSd ** 2), cfg.minSd, cfg.maxSd);
  }
  const latest = games.reduce((max, g) => Math.max(max, Date.parse(String(g.date || '') + 'T00:00:00Z') || 0), 0);
  const recencyDays = latest ? Math.max(0, Math.round((evaluationMs - latest) / DAY)) : null;
  const recencyFactor = recencyDays == null ? (priorWeight ? 0.65 : estimateWeight ? 0.5 : 0)
    : Math.min(1, Math.exp(-Math.LN2 * Math.max(0, recencyDays - cfg.halfLifeDays) / cfg.halfLifeDays));
  const confidence = clamp((evidenceWeight / 12) * recencyFactor, 0, 1);
  const confidenceLabel = confidence < 0.35 ? 'Low' : confidence < 0.7 ? 'Developing' : 'Reliable';
  const strikes = games.filter(g => g.strikesRecorded === true);
  const spares = games.filter(g => g.sparesRecorded === true);
  const avg = (list, key) => list.length ? list.reduce((s, g) => s + Number(g[key] || 0), 0) / list.length : null;
  const coverage = games.length ? Math.min(strikes.length, spares.length) / games.length : 0;
  const influentialIds = robustOutlierIds(games);
  const warnings = [];
  if (!evidenceWeight) warnings.push('No personal score evidence; forecast range is wide.');
  else if (current.weight < 3) warnings.push('Limited recent practice evidence.');
  if (recencyDays != null && recencyDays > 42) warnings.push('Practice data is stale.');
  if (influentialIds.length) warnings.push(`${influentialIds.length} unusually influential score${influentialIds.length > 1 ? 's' : ''} should be reviewed.`);
  if (coverage < 0.6) warnings.push('Strike/spare coverage is incomplete.');
  return {
    no: meta.no, mean: round2(mean), sd: round2(sd),
    p20: round2(clamp(mean - 0.8416 * sd, 0, 300)), p80: round2(clamp(mean + 0.8416 * sd, 0, 300)),
    effectiveN: round2(evidenceWeight), confidence: round2(confidence), confidenceLabel, recencyDays,
    tieBreak: { strikeRate: strikes.length ? round2(avg(strikes, 'strikes')) : null,
      spareRate: spares.length ? round2(avg(spares, 'spares')) : null, coverage: round2(coverage) },
    warnings,
    evidence: { includedGameIds: games.map(g => g.id).filter(Boolean), includedScores: scores,
      excludedGameIds: (player.games || []).filter(g => g.optimizerIncluded === false).map(g => g.id).filter(Boolean), influentialIds },
  };
}

function buildForecasts(roster, players, options = {}) {
  const byNo = new Map(players.map(p => [Number(p.no), p]));
  const evidenceByGender = { M: [], F: [] };
  for (const meta of roster) {
    if (Number.isFinite(meta.lgAvg)) evidenceByGender[meta.g].push(Number(meta.lgAvg));
    const p = byNo.get(meta.no) || { games: [] };
    for (const g of p.games || []) if (g.optimizerIncluded !== false && Number.isFinite(Number(g.score))) evidenceByGender[meta.g].push(Number(g.score));
  }
  const all = [...evidenceByGender.M, ...evidenceByGender.F];
  const mean = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : 100;
  const allMean = mean(all);
  const variance = all.length ? all.reduce((s, v) => s + (v - allMean) ** 2, 0) / all.length : 625;
  const squadSd = clamp(Math.sqrt(variance), 20, DEFAULT_MODEL.maxSd);
  return new Map(roster.map(meta => {
    const player = byNo.get(meta.no) || { no: meta.no, games: [] };
    const genderValues = evidenceByGender[meta.g];
    return [meta.no, forecastPlayer(meta, player, { ...options,
      squadBaseline: genderValues.length ? mean(genderValues) : allMean, squadSd })];
  }));
}

module.exports = { MODEL_VERSION, DEFAULT_MODEL, weightedMoments, robustOutlierIds, forecastPlayer, buildForecasts };
