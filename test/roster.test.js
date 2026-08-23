const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER, LEADS } = require('../public/roster');

test('official roster can form exactly three legal five-player teams', () => {
  assert.equal(ROSTER.length, 15);
  assert.equal(ROSTER.filter(p => p.g === 'M').length, 12);
  assert.equal(ROSTER.filter(p => p.g === 'F').length, 3);
  assert.deepEqual(LEADS, { A: 171, B: 149, C: 175 });
  assert.equal(new Set(ROSTER.map(p => p.no)).size, 15);
  assert.ok(ROSTER.every(p => Number.isFinite(p.pt) && p.pt >= 0));
});
