const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER, LEADS } = require('../public/roster');
const { teamSplitError } = require('../public/app-core');
const { generateLegalPartitions, assignmentsOf } = require('../lib/optimizer/legal-teams');

test('every generated partition obeys official constraints', () => {
  const { partitions, conflict } = generateLegalPartitions({
    roster: ROSTER, capCr: 25, leads: LEADS, pins: {}, availability: {}
  });
  assert.equal(conflict, null);
  assert.ok(partitions.length > 0);
  for (const split of partitions) {
    assert.equal(new Set([...split.A, ...split.B, ...split.C]).size, 15);
    assert.equal(teamSplitError(ROSTER, assignmentsOf(split), 25, LEADS), null);
  }
});

test('impossible leadership pins return a specific conflict', () => {
  const r = generateLegalPartitions({ roster: ROSTER, capCr: 25, leads: LEADS,
    pins: { 149: 'A' }, availability: {} });
  assert.deepEqual(r.partitions, []);
  assert.match(r.conflict, /Captain 149.*B/);
});

test('unavailable roster member prevents a complete submitted split', () => {
  const r = generateLegalPartitions({ roster: ROSTER, capCr: 25, leads: LEADS,
    pins: {}, availability: { 82: false } });
  assert.deepEqual(r.partitions, []);
  assert.match(r.conflict, /Karnav Patel.*unavailable/);
});

test('pins are respected and results are stable', () => {
  const args = { roster: ROSTER, capCr: 25, leads: LEADS, pins: { 31: 'C', 43: 'A' }, availability: {} };
  const a = generateLegalPartitions(args);
  const b = generateLegalPartitions(args);
  assert.deepEqual(a, b);
  assert.ok(a.partitions.length > 0);
  assert.ok(a.partitions.every(p => p.C.includes(31) && p.A.includes(43)));
});

test('synthetic unconstrained roster enumerates every labelled partition', () => {
  const roster = [
    { no: 1, name: 'Lead A', g: 'M', pt: 0 }, { no: 2, name: 'Lead B', g: 'M', pt: 0 }, { no: 3, name: 'Lead C', g: 'M', pt: 0 },
    ...Array.from({ length: 9 }, (_, i) => ({ no: 10 + i, name: `M${i}`, g: 'M', pt: 0 })),
    ...Array.from({ length: 3 }, (_, i) => ({ no: 30 + i, name: `F${i}`, g: 'F', pt: 0 })),
  ];
  const r = generateLegalPartitions({ roster, capCr: 25, leads: { A: 1, B: 2, C: 3 }, pins: {}, availability: {} });
  assert.equal(r.partitions.length, 10080);
});
