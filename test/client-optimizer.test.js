const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scenarioViewModel, forecastWarningLabel, submissionLocked } = require('../public/app-core');

test('scenario view model keeps recommendation and alternatives distinct', () => {
  const vm = scenarioViewModel({
    recommended: { key: 'safe', mode: 'championship-safe', label: 'Championship Safe' },
    alternatives: [{ key: 'attack', mode: 'aggressive', label: 'Aggressive' },
      { key: 'floor', mode: 'franchise-balanced', label: 'Franchise Balanced' }]
  }, 'aggressive');
  assert.equal(vm.cards.length, 3);
  assert.equal(vm.selected.key, 'attack');
  assert.equal(vm.recommended.key, 'safe');
});

test('submission is locked only before an audited unlock', () => {
  assert.equal(submissionLocked({ submittedAt: 10 }), true);
  assert.equal(submissionLocked({ submittedAt: 10, unlockedAt: 11 }), false);
  assert.equal(submissionLocked(null), false);
});

test('forecast warning label does not invent certainty', () => {
  assert.match(forecastWarningLabel({ warnings: ['No personal score evidence.'], confidenceLabel: 'Low' }), /No personal/);
  assert.match(forecastWarningLabel({ warnings: [], confidenceLabel: 'Developing' }), /Developing/);
});

test('coach optimizer exposes sourced competitor comparison controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const phrase of ['Competitors & benchmarks', 'Observed rank range', 'Source / scoreboard',
    'confirmed', 'provisional', 'These are score comparisons, not win probabilities']) {
    assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /\/api\/competitors/);
  assert.match(html, /compareTeamToField/);
});
