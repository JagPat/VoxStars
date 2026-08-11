/* VOX STARS "winning line" — pure helpers that turn a team goal into each
   player's target. Loaded by public/index.html and unit-tested in Node
   (test/winning-line.test.js).

   Model: Stage I is a 10-game total per sub-team (5 players x 2 games), so a
   team's projected total = 2 x sum(per-game projected averages), and to reach a
   target team total T the five per-game averages must sum to T/2. The gap is
   spread across the players (equal lift) unless the coach pins some. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoxWinningLine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clampScore = v => Math.max(0, Math.min(300, Math.round(Number(v) || 0)));

  // Each rival franchise's strongest legal-size sub-team as a projected 10-game
  // total: its top five player averages x 2 games. `rivalAvgs` is
  // { franchise: [avg, ...] }. Returned sorted strongest-first. This is an
  // estimate from embedded averages, not an observed result.
  function fieldTotalsFromRivals(rivalAvgs) {
    return Object.keys(rivalAvgs || {}).map(name => {
      const top5 = (rivalAvgs[name] || []).map(Number).filter(Number.isFinite).sort((a, b) => b - a).slice(0, 5);
      return { name, total: Math.round(top5.reduce((s, v) => s + v, 0) * 2) };
    }).sort((a, b) => b.total - a.total);
  }

  // The line to top the field: the highest total among the supplied field totals
  // (rival estimates and/or observed scoreboard totals). Null when empty.
  function winningLine(fieldTotals) {
    const totals = (fieldTotals || []).map(x => (typeof x === 'number' ? x : x.total)).filter(Number.isFinite);
    return totals.length ? Math.max(...totals) : null;
  }

  // Back-solve per-player targets for one sub-team.
  //   players : [{ no, name, g, avg:Number|null, proj:Number }]  (proj = projected per-game avg, default-filled)
  //   lineTotal : target 10-game team total
  //   overrides : { no: targetAvg } — pinned players keep their value; the rest
  //               split the remaining gap by equal lift.
  // Returns per-player targets plus the team roll-up.
  function equalLiftTargets(players, lineTotal, overrides) {
    players = players || [];
    overrides = overrides || {};
    const proj = p => Number(p.proj) || 0;
    const need = Number(lineTotal) / 2;                 // sum of per-game averages required
    const pinned = new Set(players.filter(p => overrides[p.no] != null).map(p => p.no));
    const pinnedSum = players.filter(p => pinned.has(p.no)).reduce((s, p) => s + clampScore(overrides[p.no]), 0);
    const flex = players.filter(p => !pinned.has(p.no));
    const flexProjSum = flex.reduce((s, p) => s + proj(p), 0);
    const delta = flex.length ? (need - pinnedSum - flexProjSum) / flex.length : 0;
    let capped = false;
    const targets = players.map(p => {
      const isPinned = pinned.has(p.no);
      const raw = isPinned ? Number(overrides[p.no]) : proj(p) + delta;
      const target = clampScore(raw);
      if (!isPinned && Math.round(raw) !== target && raw > 300) capped = true;
      const current = p.avg == null ? null : Number(p.avg);
      const projRound = Math.round(proj(p));
      return { no: p.no, name: p.name, g: p.g, current, proj: projRound,
        target, lift: target - projRound, pinned: isPinned,
        onTrack: current != null && current >= target };
    });
    const sumTarget = targets.reduce((s, t) => s + t.target, 0);
    const projectedTotal = Math.round(2 * players.reduce((s, p) => s + proj(p), 0));
    const lineRound = Math.round(need * 2);
    return {
      targets,
      projectedTotal,
      lineTotal: lineRound,
      gap: lineRound - projectedTotal,
      targetTotal: sumTarget * 2,          // projected total if everyone hits target
      capped,                              // equal lift hit the 300 ceiling — line may be unreachable this way
    };
  }

  return { fieldTotalsFromRivals, winningLine, equalLiftTargets };
});
