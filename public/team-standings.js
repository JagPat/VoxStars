/* VOX STARS team standings — pure helpers shared by the grouped leaderboard,
   the team-vs-team comparison card, and the individual card's team context.
   Loaded by public/index.html and unit-tested directly in Node
   (test/team-standings.test.js).

   Every function takes plain per-player view-models the caller assembles from
   the existing app helpers (disp, teamAvg, srate/sprate, seasonStats):
     { no, name, g:'M'|'F', team:'A'|'B'|'C'|null,
       avg:Number|null, delta:Number|null, strikes:Number, spares:Number }
   `strikes`/`spares` are each player's already-fallback-adjusted per-game
   contribution (the value teamStrikes/teamSpares sum), so this module never
   invents strike/spare data — it only groups, ranks, and orders. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoxStandings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = ['A', 'B', 'C'];
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const teamOf = p => (p && KEYS.indexOf(p.team) >= 0 ? p.team : null);

  // { A:[...], B:[...], C:[...] } of the players assigned to each sub-team;
  // unassigned players are dropped.
  function groupByTeam(players) {
    const out = { A: [], B: [], C: [] };
    (players || []).forEach(p => { const t = teamOf(p); if (t) out[t].push(p); });
    return out;
  }

  // Order a group for the leaderboard: 'avg' = by average desc, anything else
  // = 'most improved' by season delta desc. A missing value sorts last. Stable,
  // returns a new array.
  function sortForBoard(list, sort) {
    const byAvg = sort === 'avg';
    return (list || []).slice().sort((a, b) => {
      if (byAvg) return (b.avg == null ? -1 : b.avg) - (a.avg == null ? -1 : a.avg);
      return (b.delta == null ? -999 : b.delta) - (a.delta == null ? -999 : a.delta);
    });
  }

  // A player's rank within their own sub-team by average (1 = highest). Returns
  // null when the player is unknown or unassigned. Standard competition ranking:
  // players with a strictly higher average count ahead; a null average sorts to
  // the bottom.
  function rankWithinTeam(players, no) {
    const me = (players || []).find(p => Number(p.no) === Number(no));
    const t = teamOf(me);
    if (!t) return null;
    const group = groupByTeam(players)[t];
    const val = p => (p.avg == null ? -Infinity : Number(p.avg));
    const mine = val(me);
    const ahead = group.filter(p => Number(p.no) !== Number(no) && val(p) > mine).length;
    return { rank: ahead + 1, size: group.length };
  }

  // Per-team aggregates for the comparison card, ordered A/B/C. `coverage` maps
  // team -> optimizer tieBreakCoverage (0..1) and is passed straight through.
  function teamStandings(players, opts) {
    const groups = groupByTeam(players);
    const coverage = (opts && opts.coverage) || {};
    const out = {};
    KEYS.forEach(k => {
      const L = groups[k];
      const avgs = L.map(p => p.avg).filter(v => v != null).map(Number);
      const combinedAvg = avgs.length ? Math.round(avgs.reduce((s, v) => s + v, 0) / avgs.length) : null;
      const series = Math.round(L.reduce((s, p) => s + (p.avg == null ? 0 : Number(p.avg)), 0));
      out[k] = {
        team: k,
        count: L.length,
        avg: combinedAvg,
        series,
        strikes: L.reduce((s, p) => s + num(p.strikes), 0),
        spares: L.reduce((s, p) => s + num(p.spares), 0),
        female: Math.round(L.filter(p => p.g === 'F').reduce((s, p) => s + (p.avg == null ? 0 : Number(p.avg)), 0)),
        coverage: coverage[k] == null ? null : Number(coverage[k]),
      };
    });
    return out;
  }

  // The three teams ordered by the official tie-breakers: projected series, then
  // total strikes, then spares, then female score. Returns [{ team, position,
  // standing }] best-first; `position` is 1..n. Only teams with at least one
  // assigned player are ranked.
  function compareTeams(players, opts) {
    const st = teamStandings(players, opts);
    const ranked = KEYS.map(k => st[k]).filter(s => s.count > 0)
      .sort((a, b) => (b.series - a.series) || (b.strikes - a.strikes)
        || (b.spares - a.spares) || (b.female - a.female));
    return ranked.map((standing, i) => ({ team: standing.team, position: i + 1, standing }));
  }

  return { groupByTeam, sortForBoard, rankWithinTeam, teamStandings, compareTeams };
});
