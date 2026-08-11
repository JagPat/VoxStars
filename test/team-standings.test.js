const test = require('node:test');
const assert = require('node:assert/strict');
const { groupByTeam, sortForBoard, rankWithinTeam, teamStandings, compareTeams } = require('../public/team-standings');

// A small legal-shaped squad: three teams, one woman each.
function squad() {
  return [
    { no: 1, name: 'A1', g: 'M', team: 'A', avg: 150, proj: 150, delta: 5, strikes: 3, spares: 2 },
    { no: 2, name: 'A2', g: 'M', team: 'A', avg: 120, proj: 120, delta: 2, strikes: 1, spares: 4 },
    { no: 3, name: 'A3', g: 'F', team: 'A', avg: 110, proj: 110, delta: null, strikes: 0, spares: 1 },
    { no: 4, name: 'B1', g: 'M', team: 'B', avg: 140, proj: 140, delta: 8, strikes: 4, spares: 3 },
    { no: 5, name: 'B2', g: 'M', team: 'B', avg: 130, proj: 130, delta: -1, strikes: 2, spares: 2 },
    { no: 6, name: 'B3', g: 'F', team: 'B', avg: 100, proj: 100, delta: 3, strikes: 1, spares: 0 },
    { no: 7, name: 'C1', g: 'M', team: 'C', avg: 90, proj: 90, delta: null, strikes: 0, spares: 0 },
    // unlogged: no display average, but projected at the squad default (100)
    { no: 8, name: 'C2', g: 'F', team: 'C', avg: null, proj: 100, delta: null, strikes: 0, spares: 0 },
    { no: 9, name: 'U1', g: 'M', team: null, avg: 200, proj: 200, delta: 9, strikes: 5, spares: 5 },
  ];
}

test('groupByTeam keeps only assigned players', () => {
  const g = groupByTeam(squad());
  assert.deepEqual(g.A.map(p => p.no), [1, 2, 3]);
  assert.deepEqual(g.B.map(p => p.no), [4, 5, 6]);
  assert.deepEqual(g.C.map(p => p.no), [7, 8]);
  // player 9 (unassigned) appears in no group
  assert.ok(!g.A.concat(g.B, g.C).some(p => p.no === 9));
});

test('sortForBoard orders by average or by most-improved delta', () => {
  const A = groupByTeam(squad()).A;
  assert.deepEqual(sortForBoard(A, 'avg').map(p => p.no), [1, 2, 3]);
  // delta desc: A1(5), A2(2), A3(null -> last)
  assert.deepEqual(sortForBoard(A, 'imp').map(p => p.no), [1, 2, 3]);
});

test('rankWithinTeam ranks by average within the player\'s own team', () => {
  assert.deepEqual(rankWithinTeam(squad(), 1), { rank: 1, size: 3 });
  assert.deepEqual(rankWithinTeam(squad(), 2), { rank: 2, size: 3 });
  assert.deepEqual(rankWithinTeam(squad(), 3), { rank: 3, size: 3 });
});

test('rankWithinTeam sends a null average to the bottom and is null when unassigned', () => {
  // C2 has no average -> ranks behind C1
  assert.deepEqual(rankWithinTeam(squad(), 8), { rank: 2, size: 2 });
  assert.deepEqual(rankWithinTeam(squad(), 7), { rank: 1, size: 2 });
  // unassigned / unknown players are unranked
  assert.equal(rankWithinTeam(squad(), 9), null);
  assert.equal(rankWithinTeam(squad(), 999), null);
});

test('rankWithinTeam gives tied averages the same rank', () => {
  const tied = [
    { no: 1, g: 'M', team: 'A', avg: 130 },
    { no: 2, g: 'M', team: 'A', avg: 130 },
    { no: 3, g: 'F', team: 'A', avg: 100 },
  ];
  assert.equal(rankWithinTeam(tied, 1).rank, 1);
  assert.equal(rankWithinTeam(tied, 2).rank, 1); // no teammate strictly ahead
  assert.equal(rankWithinTeam(tied, 3).rank, 3);
});

test('teamStandings sums series, strikes, spares and female score per team', () => {
  const st = teamStandings(squad(), { coverage: { A: 0.4, B: 0.6, C: 0 } });
  assert.equal(st.A.series, 380);       // 150+120+110
  assert.equal(st.A.avg, 127);          // round(380/3)
  assert.equal(st.A.strikes, 4);        // 3+1+0
  assert.equal(st.A.spares, 7);         // 2+4+1
  assert.equal(st.A.female, 110);       // A3 only
  assert.equal(st.A.coverage, 0.4);
  assert.equal(st.C.series, 190);       // 90 + 100 (C2 projected at default)
  assert.equal(st.C.avg, 95);           // round(190/2)
  assert.equal(st.C.female, 100);       // C2 projected at default
});

test('compareTeams orders by series then the official tie-breakers', () => {
  const ranked = compareTeams(squad());
  assert.deepEqual(ranked.map(r => r.team), ['A', 'B', 'C']); // 380 > 370 > 190
  assert.deepEqual(ranked.map(r => r.position), [1, 2, 3]);
});

test('compareTeams breaks a series tie on strikes, then spares, then female', () => {
  const tie = [
    // Team A and B both project 200 series; A has more strikes
    { no: 1, g: 'M', team: 'A', avg: 100, strikes: 5, spares: 1 },
    { no: 2, g: 'F', team: 'A', avg: 100, strikes: 0, spares: 0 },
    { no: 3, g: 'M', team: 'B', avg: 100, strikes: 2, spares: 9 },
    { no: 4, g: 'F', team: 'B', avg: 100, strikes: 0, spares: 0 },
  ];
  const ranked = compareTeams(tie);
  assert.deepEqual(ranked.map(r => r.team), ['A', 'B']); // strikes 5 > 2 wins the tie
});
