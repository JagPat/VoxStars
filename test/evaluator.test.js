const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePartitions, selectScenarios } = require('../lib/optimizer/evaluator');

function forecasts() {
  return new Map(Array.from({ length: 15 }, (_, i) => [i + 1, {
    no: i + 1, mean: 100 + i, sd: i === 14 ? 40 : 15, p20: 80 + i, p80: 120 + i,
    confidence: 0.7, confidenceLabel: 'Reliable', tieBreak: { coverage: 0.8 }, warnings: []
  }]));
}
const partitions = [
  { A: [1, 4, 7, 10, 13], B: [2, 5, 8, 11, 14], C: [3, 6, 9, 12, 15] },
  { A: [1, 4, 7, 10, 15], B: [2, 5, 8, 11, 13], C: [3, 6, 9, 12, 14] },
];

test('same seed returns identical scenario metrics', () => {
  const one = evaluatePartitions(partitions, forecasts(), { seed: 'state-123', iterations: 200 });
  const two = evaluatePartitions(partitions, forecasts(), { seed: 'state-123', iterations: 200 });
  assert.deepEqual(one, two);
});

test('scenario selectors choose endpoints and normalized Pareto knee', () => {
  const selected = selectScenarios([
    { key: 'fragile', championshipPotential: 100, downsideProtection: 20, expectedTotal: 100, tieBreakCoverage: 1, confidence: 1 },
    { key: 'knee', championshipPotential: 85, downsideProtection: 80, expectedTotal: 100, tieBreakCoverage: 1, confidence: 1 },
    { key: 'flat', championshipPotential: 60, downsideProtection: 100, expectedTotal: 100, tieBreakCoverage: 1, confidence: 1 },
    { key: 'dominated', championshipPotential: 50, downsideProtection: 10, expectedTotal: 100, tieBreakCoverage: 1, confidence: 1 }
  ]);
  assert.equal(selected.aggressive.key, 'fragile');
  assert.equal(selected.franchiseBalanced.key, 'flat');
  assert.equal(selected.championshipSafe.key, 'knee');
  assert.equal(selected.frontierSize, 3);
});

test('two-game stage is less volatile per game than a one-game round', () => {
  const evaluated = evaluatePartitions([partitions[0]], forecasts(), { seed: 'variance', iterations: 1000 })[0];
  for (const team of Object.values(evaluated.teams)) {
    const stageSpread = (team.stageOne.p80 - team.stageOne.p20) / 10;
    const laterSpread = (team.later.p80 - team.later.p20) / 5;
    assert.ok(stageSpread < laterSpread);
  }
});

test('benchmark probabilities appear only with provenance', () => {
  const plain = evaluatePartitions([partitions[0]], forecasts(), { seed: 'plain', iterations: 100 })[0];
  assert.equal('qualificationProbability' in plain.teams.A.stageOne, false);
  const benchmark = { stage: 'stageOne', cutoff: 1000, source: 'Organizer results', observedAt: '2026-07-20' };
  const compared = evaluatePartitions([partitions[0]], forecasts(), { seed: 'bench', iterations: 100, benchmark })[0];
  assert.ok(compared.teams.A.stageOne.qualificationProbability >= 0);
  assert.equal(compared.teams.A.stageOne.benchmark.source, benchmark.source);
});
