'use strict';

const { assignmentsOf, partitionKey } = require('./legal-teams');

const DEFAULT_RULES = Object.freeze({ stageOneGamesPerPlayer: 2, laterGamesPerPlayer: 1, downsideQuantile: 0.20 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;

function seedNumber(text) {
  let h = 2166136261;
  for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rngFor(seed) {
  let a = seedNumber(seed) || 1;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  const u = Math.max(Number.EPSILON, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summary(values) {
  return {
    expected: round2(values.reduce((s, v) => s + v, 0) / values.length),
    p20: round2(quantile(values, 0.20)),
    p80: round2(quantile(values, 0.80)),
  };
}

function evaluatePartitions(partitions, forecasts, options = {}) {
  const iterations = Math.max(50, Math.min(5000, Number(options.iterations) || 750));
  const rng = rngFor(options.seed || 'voxstars');
  const draws = new Map();
  for (const [no, f] of forecasts) {
    const stageOne = [], later = [];
    for (let i = 0; i < iterations; i++) {
      let two = 0;
      for (let g = 0; g < DEFAULT_RULES.stageOneGamesPerPlayer; g++) two += clamp(f.mean + f.sd * normal(rng), 0, 300);
      stageOne.push(two);
      later.push(clamp(f.mean + f.sd * normal(rng), 0, 300));
    }
    draws.set(Number(no), { stageOne, later });
  }
  const teamCache = new Map();
  function teamMetrics(nos) {
    const key = [...nos].sort((a, b) => a - b).join(',');
    if (teamCache.has(key)) return teamCache.get(key);
    const stageValues = Array(iterations).fill(0), laterValues = Array(iterations).fill(0);
    for (const no of nos) {
      const d = draws.get(Number(no));
      if (!d) throw new Error(`missing forecast for player ${no}`);
      for (let i = 0; i < iterations; i++) { stageValues[i] += d.stageOne[i]; laterValues[i] += d.later[i]; }
    }
    const stageOne = summary(stageValues), later = summary(laterValues);
    if (options.benchmark && options.benchmark.stage === 'stageOne') {
      stageOne.qualificationProbability = round2(stageValues.filter(v => v >= options.benchmark.cutoff).length / iterations);
      stageOne.benchmark = { source: options.benchmark.source, observedAt: options.benchmark.observedAt, cutoff: options.benchmark.cutoff };
    }
    if (options.benchmark && options.benchmark.stage === 'later') {
      later.qualificationProbability = round2(laterValues.filter(v => v >= options.benchmark.cutoff).length / iterations);
      later.benchmark = { source: options.benchmark.source, observedAt: options.benchmark.observedAt, cutoff: options.benchmark.cutoff };
    }
    const fs = nos.map(no => forecasts.get(Number(no)));
    const metrics = {
      playerNos: [...nos], stageOne, later,
      confidence: round2(fs.reduce((s, f) => s + f.confidence, 0) / fs.length),
      tieBreakCoverage: round2(fs.reduce((s, f) => s + (f.tieBreak.coverage || 0), 0) / fs.length),
      warnings: [...new Set(fs.flatMap(f => f.warnings || []))],
    };
    teamCache.set(key, metrics);
    return metrics;
  }
  return partitions.map(partition => {
    const teams = Object.fromEntries(['A', 'B', 'C'].map(team => [team, teamMetrics(partition[team])]));
    const strongest = ['A', 'B', 'C'].sort((a, b) => teams[b].later.p20 - teams[a].later.p20)[0];
    const weakest = ['A', 'B', 'C'].sort((a, b) =>
      Math.min(teams[a].stageOne.p20 / 10, teams[a].later.p20 / 5) -
      Math.min(teams[b].stageOne.p20 / 10, teams[b].later.p20 / 5))[0];
    return {
      key: partitionKey(partition), assignments: assignmentsOf(partition), teams,
      championshipPotential: teams[strongest].later.p20,
      downsideProtection: round2(Math.min(...Object.values(teams).map(t => Math.min(t.stageOne.p20 / 10, t.later.p20 / 5)))),
      expectedTotal: Math.max(...Object.values(teams).map(t => t.later.expected)),
      tieBreakCoverage: round2(Object.values(teams).reduce((s, t) => s + t.tieBreakCoverage, 0) / 3),
      confidence: round2(Object.values(teams).reduce((s, t) => s + t.confidence, 0) / 3),
      warnings: [...new Set(Object.values(teams).flatMap(t => t.warnings))],
      explanations: [`Sub-team ${strongest} has the strongest conservative later-round total.`,
        `Sub-team ${weakest} sets this split's downside floor.`],
    };
  });
}

function betterTie(a, b) {
  return (b.expectedTotal - a.expectedTotal) || (b.tieBreakCoverage - a.tieBreakCoverage) ||
    (b.confidence - a.confidence) || String(a.key).localeCompare(String(b.key));
}

function selectScenarios(evaluations) {
  if (!evaluations.length) throw new Error('no evaluations');
  const frontier = evaluations.filter(a => !evaluations.some(b => b !== a &&
    b.championshipPotential >= a.championshipPotential && b.downsideProtection >= a.downsideProtection &&
    (b.championshipPotential > a.championshipPotential || b.downsideProtection > a.downsideProtection)));
  const aggressive = [...frontier].sort((a, b) => b.championshipPotential - a.championshipPotential || betterTie(a, b))[0];
  const franchiseBalanced = [...frontier].sort((a, b) => b.downsideProtection - a.downsideProtection || betterTie(a, b))[0];
  const xs = frontier.map(x => x.championshipPotential), ys = frontier.map(x => x.downsideProtection);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const distance = item => {
    const x = xmax === xmin ? 1 : (item.championshipPotential - xmin) / (xmax - xmin);
    const y = ymax === ymin ? 1 : (item.downsideProtection - ymin) / (ymax - ymin);
    return Math.hypot(1 - x, 1 - y);
  };
  const championshipSafe = [...frontier].sort((a, b) => distance(a) - distance(b) || betterTie(a, b))[0];
  return { championshipSafe, aggressive, franchiseBalanced, frontierSize: frontier.length };
}

module.exports = { DEFAULT_RULES, evaluatePartitions, selectScenarios, quantile };
