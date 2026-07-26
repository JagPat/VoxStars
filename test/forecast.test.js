const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastPlayer, buildForecasts } = require('../lib/optimizer/forecast');

test('recent evidence outweighs stale evidence and exclusions are ignored', () => {
  const meta = { no: 1, g: 'M', lgAvg: 100, lgM: 4 };
  const player = { no: 1, games: [
    { id: 'old', score: 80, date: '2026-05-01', optimizerIncluded: true },
    { id: 'new', score: 160, date: '2026-07-25', optimizerIncluded: true },
    { id: 'excluded', score: 300, date: '2026-07-25', optimizerIncluded: false }
  ] };
  const f = forecastPlayer(meta, player, { evaluationDate: '2026-07-26', squadBaseline: 110, squadSd: 25 });
  assert.ok(f.mean > 110 && f.mean < 160);
  assert.ok(f.p20 < f.mean && f.mean < f.p80);
  assert.ok(!f.evidence.includedScores.includes(300));
});

test('missing tie-break metadata stays unknown', () => {
  const f = forecastPlayer({ no: 1, g: 'F', lgAvg: null, lgM: 0 }, {
    no: 1, games: [{ id: 'g1', score: 100, date: '2026-07-25', strikes: 0, spares: 0 }]
  }, { evaluationDate: '2026-07-26', squadBaseline: 100, squadSd: 25 });
  assert.equal(f.tieBreak.strikeRate, null);
  assert.equal(f.tieBreak.spareRate, null);
  assert.equal(f.tieBreak.coverage, 0);
});

test('no-data forecasts are bounded, wide, and low confidence', () => {
  const f = forecastPlayer({ no: 7, g: 'M', lgAvg: null, lgM: 0 }, { no: 7, games: [] },
    { evaluationDate: '2026-07-26', squadBaseline: 105, squadSd: 25 });
  assert.equal(f.mean, 105);
  assert.ok(f.sd >= 40);
  assert.equal(f.confidenceLabel, 'Low');
  assert.ok(f.p20 >= 0 && f.p80 <= 300);
});

test('consistent evidence narrows uncertainty and raises confidence', () => {
  const meta = { no: 1, g: 'M', lgAvg: null, lgM: 0 };
  const few = forecastPlayer(meta, { no: 1, games: [{ id: 'a', score: 120, date: '2026-07-25' }] },
    { evaluationDate: '2026-07-26', squadBaseline: 100, squadSd: 30 });
  const many = forecastPlayer(meta, { no: 1, games: Array.from({ length: 12 }, (_, i) =>
    ({ id: `g${i}`, score: 120 + (i % 2), date: '2026-07-25' })) },
    { evaluationDate: '2026-07-26', squadBaseline: 100, squadSd: 30 });
  assert.ok(many.sd < few.sd);
  assert.ok(many.confidence > few.confidence);
});

test('buildForecasts is deterministic and flags influential games', () => {
  const roster = [{ no: 1, g: 'M', lgAvg: 100, lgM: 3 }];
  const players = [{ no: 1, games: [100, 101, 99, 200].map((score, i) =>
    ({ id: `g${i}`, score, date: '2026-07-25', optimizerIncluded: true })) }];
  const a = buildForecasts(roster, players, { evaluationDate: '2026-07-26' });
  const b = buildForecasts(roster, players, { evaluationDate: '2026-07-26' });
  assert.deepEqual([...a.values()], [...b.values()]);
  assert.ok(a.get(1).warnings.some(w => /influential/i.test(w)));
});
