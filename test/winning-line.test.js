const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldTotalsFromRivals, winningLine, equalLiftTargets } = require('../public/winning-line');

test('fieldTotalsFromRivals takes each rival\'s top five averages x2 games', () => {
  const f = fieldTotalsFromRivals({
    Strong: [150, 140, 130, 120, 110, 90],   // top5 = 650 -> 1300
    Weak: [100, 100, 100, 100, 100],         // 500 -> 1000
  });
  assert.deepEqual(f, [{ name: 'Strong', total: 1300 }, { name: 'Weak', total: 1000 }]);
});

test('winningLine is the highest field total, null when empty', () => {
  assert.equal(winningLine([{ total: 1200 }, { total: 1300 }, 1250]), 1300);
  assert.equal(winningLine([]), null);
});

const team = () => ([
  { no: 1, name: 'P1', g: 'M', avg: 130, proj: 130 },
  { no: 2, name: 'P2', g: 'M', avg: 120, proj: 120 },
  { no: 3, name: 'P3', g: 'M', avg: 110, proj: 110 },
  { no: 4, name: 'P4', g: 'M', avg: null, proj: 100 },  // unlogged, projected at default
  { no: 5, name: 'P5', g: 'F', avg: 100, proj: 100 },
]);

test('equalLiftTargets spreads the gap evenly across all five players', () => {
  // projected total = 2*(130+120+110+100+100) = 2*560 = 1120
  // line 1220 -> need per-game sum = 610 -> gap 50 over 5 players -> +10 each per game
  const r = equalLiftTargets(team(), 1220);
  assert.equal(r.projectedTotal, 1120);
  assert.equal(r.lineTotal, 1220);
  assert.equal(r.gap, 100);
  assert.deepEqual(r.targets.map(t => t.target), [140, 130, 120, 110, 110]);
  assert.deepEqual(r.targets.map(t => t.lift), [10, 10, 10, 10, 10]);
  assert.equal(r.targetTotal, 1220);      // everyone at target hits the line
});

test('equalLiftTargets marks who is already on track', () => {
  const r = equalLiftTargets(team(), 1120);   // line == projection -> no lift needed
  assert.deepEqual(r.targets.map(t => t.target), [130, 120, 110, 100, 100]);
  // P1..P3,P5 have averages meeting their target; P4 has no logged average
  assert.deepEqual(r.targets.map(t => t.onTrack), [true, true, true, false, true]);
});

test('equalLiftTargets pins overridden players and redistributes the rest', () => {
  // pin P1 at 160; remaining four must cover need - 160.
  // line 1220 -> need 610; remaining proj = 120+110+100+100 = 430; (610-160-430)/4 = 5
  const r = equalLiftTargets(team(), 1220, { 1: 160 });
  const byNo = Object.fromEntries(r.targets.map(t => [t.no, t]));
  assert.equal(byNo[1].target, 160);
  assert.equal(byNo[1].pinned, true);
  assert.deepEqual([byNo[2].target, byNo[3].target, byNo[4].target, byNo[5].target], [125, 115, 105, 105]);
  assert.equal(r.targetTotal, 1220);      // 2*(160+125+115+105+105)=1220
});

test('equalLiftTargets flags when equal lift hits the 300 ceiling', () => {
  const r = equalLiftTargets(team(), 3000);  // absurd line -> targets clamp at 300
  assert.ok(r.targets.every(t => t.target <= 300));
  assert.equal(r.capped, true);
});
