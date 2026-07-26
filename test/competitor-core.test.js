const test = require('node:test');
const assert = require('node:assert/strict');
const { compareTeamToField } = require('../public/competitor-core');

test('compares expected, downside, and upside scores to an observed field', () => {
  const field = [{ score: 1100 }, { score: 1000 }, { score: 900 }];
  assert.deepEqual(compareTeamToField({ p20: 920, expected: 1020, p80: 1120 }, field), {
    expectedRank: 2, bestRank: 1, worstRank: 3, fieldSize: 4,
    leaderGap: -80, medianGap: 20,
  });
});

test('places a VOX score after equal observed scores', () => {
  const result = compareTeamToField({ p20: 1000, expected: 1000, p80: 1000 }, [{ score: 1000 }]);
  assert.equal(result.expectedRank, 2);
});

test('returns no rank when no observations exist', () => {
  assert.deepEqual(compareTeamToField({ p20: 900, expected: 1000, p80: 1100 }, []), {
    expectedRank: null, bestRank: null, worstRank: null, fieldSize: 1,
    leaderGap: null, medianGap: null,
  });
});
