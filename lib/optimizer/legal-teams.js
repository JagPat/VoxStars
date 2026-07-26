'use strict';

const TEAMS = ['A', 'B', 'C'];

function assignmentsOf(partition) {
  return Object.fromEntries(TEAMS.flatMap(team => partition[team].map(no => [no, team])));
}

function partitionKey(partition) {
  return TEAMS.map(team => [...partition[team]].sort((a, b) => a - b).join(',')).join('|');
}

function permutations(items) {
  if (items.length < 2) return [items.slice()];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)])
    .map(rest => [item, ...rest]));
}

function combinations(items, count) {
  const out = [];
  function take(start, chosen) {
    if (chosen.length === count) { out.push(chosen.slice()); return; }
    for (let i = start; i <= items.length - (count - chosen.length); i++) {
      chosen.push(items[i]); take(i + 1, chosen); chosen.pop();
    }
  }
  take(0, []);
  return out;
}

function generateLegalPartitions({ roster, capCr, leads, pins = {}, availability = {} }) {
  const byNo = new Map(roster.map(p => [Number(p.no), p]));
  for (const team of TEAMS) {
    const lead = Number(leads[team]);
    if (!byNo.has(lead)) return { partitions: [], conflict: `Sub-team ${team} lead is not in the roster.` };
    if (pins[lead] && pins[lead] !== team) return { partitions: [], conflict: `Captain ${lead} must remain in Sub-team ${team}.` };
  }
  const unavailable = roster.filter(p => availability[p.no] === false);
  if (unavailable.length) return { partitions: [], conflict: `${unavailable.map(p => p.name || p.no).join(', ')} marked unavailable; a complete 15-player split cannot be formed.` };
  for (const [rawNo, team] of Object.entries(pins)) {
    if (!byNo.has(Number(rawNo))) return { partitions: [], conflict: `Pinned player ${rawNo} is not in the roster.` };
    if (!TEAMS.includes(team)) return { partitions: [], conflict: `Pinned player ${rawNo} has an invalid team.` };
  }
  const leadNos = new Set(Object.values(leads).map(Number));
  const women = roster.filter(p => p.g === 'F');
  const men = roster.filter(p => p.g === 'M' && !leadNos.has(p.no));
  if (women.length !== 3 || men.length !== 9) return { partitions: [], conflict: 'Roster must contain three women and nine non-lead men.' };
  const cap = Number(capCr);
  const legalTeam = (team, nos) => {
    if (nos.some(no => pins[no] && pins[no] !== team)) return false;
    return nos.reduce((sum, no) => sum + Number(byNo.get(no).pt || 0), 0) <= cap;
  };
  const results = [];
  for (const womenOrder of permutations(women.map(p => p.no))) {
    const bases = Object.fromEntries(TEAMS.map((team, i) => [team, [Number(leads[team]), womenOrder[i]]]));
    if (TEAMS.some(team => !legalTeam(team, bases[team]))) continue;
    for (const aMen of combinations(men.map(p => p.no), 3)) {
      const remaining = men.map(p => p.no).filter(no => !aMen.includes(no));
      const A = [...bases.A, ...aMen];
      if (!legalTeam('A', A)) continue;
      for (const bMen of combinations(remaining, 3)) {
        const B = [...bases.B, ...bMen];
        const C = [...bases.C, ...remaining.filter(no => !bMen.includes(no))];
        if (!legalTeam('B', B) || !legalTeam('C', C)) continue;
        results.push({ A: A.sort((a, b) => a - b), B: B.sort((a, b) => a - b), C: C.sort((a, b) => a - b) });
      }
    }
  }
  results.sort((a, b) => partitionKey(a).localeCompare(partitionKey(b)));
  return results.length ? { partitions: results, conflict: null }
    : { partitions: [], conflict: 'No legal split satisfies the 25 Cr cap and current pins.' };
}

module.exports = { generateLegalPartitions, assignmentsOf, partitionKey };
