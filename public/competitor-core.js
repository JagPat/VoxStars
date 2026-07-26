(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoxCompetitors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function compareTeamToField(teamStats, observations) {
    const scores = (observations || []).map(x => Number(x.score)).filter(Number.isFinite).sort((a, b) => b - a);
    const fieldSize = scores.length + 1;
    if (!scores.length) return { expectedRank: null, bestRank: null, worstRank: null, fieldSize,
      leaderGap: null, medianGap: null };
    const rank = score => 1 + scores.filter(x => x >= Number(score)).length;
    const middle = Math.floor(scores.length / 2);
    const median = scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2;
    return {
      expectedRank: rank(teamStats.expected),
      bestRank: rank(teamStats.p80),
      worstRank: rank(teamStats.p20),
      fieldSize,
      leaderGap: Math.round(Number(teamStats.expected) - scores[0]),
      medianGap: Math.round(Number(teamStats.expected) - median),
    };
  }

  return { compareTeamToField };
});
