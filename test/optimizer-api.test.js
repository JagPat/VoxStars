const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api } = require('./helpers');

async function withCoach(run) {
  const srv = await startServer();
  const req = api(srv.base);
  try {
    const login = await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } });
    await run({ req, coachSession: login.body.session });
  } finally { await srv.stop(); }
}

test('new score records explicit strike and spare coverage', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const r = await req('POST', '/api/games', {
      body: { no: 99, score: 150, strikes: 0, spares: 0,
        strikesRecorded: true, sparesRecorded: true }, coachSession
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.game.strikesRecorded, true);
    assert.equal(r.body.game.sparesRecorded, true);
    assert.equal(r.body.game.optimizerIncluded, true);
  });
});

test('only a coach can exclude a game and the score remains stored', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const game = (await req('POST', '/api/games', {
      body: { no: 99, score: 10 }, coachSession
    })).body.game;
    assert.equal((await req('PUT', `/api/games/99/${game.id}/optimizer-status`, {
      body: { included: false, reason: 'possible entry error' }
    })).status, 401);
    const changed = await req('PUT', `/api/games/99/${game.id}/optimizer-status`, {
      body: { included: false, reason: 'possible entry error' }, coachSession
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.game.optimizerIncluded, false);
    const state = await req('GET', '/api/state', { coachSession });
    const stored = state.body.players.find(p => p.no === 99).games.find(g => g.id === game.id);
    assert.equal(stored.score, 10);
    assert.equal(stored.optimizerExclusionReason, 'possible entry error');
  });
});

test('optimizer evaluation is coach-only, deterministic, and strips private state', async () => {
  await withCoach(async ({ req, coachSession }) => {
    assert.equal((await req('POST', '/api/optimizer/evaluate', { body: {} })).status, 401);
    const one = await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession });
    const two = await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, two.body);
    assert.equal(one.body.recommended.label, 'Championship Safe');
    assert.equal(one.body.alternatives.length, 2);
    assert.equal(one.body.forecasts.length, 15);
    const text = JSON.stringify(one.body);
    for (const secret of ['authPin', 'inviteToken', 'sessions']) assert.ok(!text.includes(secret));
    assert.equal('qualificationProbability' in one.body.recommended.teams.A.stageOne, false);
  });
});

test('optimizer rejects impossible constraints and accepts sourced benchmarks', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const impossible = await req('POST', '/api/optimizer/evaluate', {
      body: { pins: { 149: 'A' } }, coachSession
    });
    assert.equal(impossible.status, 422);
    assert.match(impossible.body.error, /Captain 149/);
    const benchmark = await req('POST', '/api/optimizer/evaluate', {
      body: { benchmark: { stage: 'stageOne', cutoff: 1000,
        source: 'Organizer results', observedAt: '2026-07-20' } }, coachSession
    });
    assert.equal(benchmark.status, 200);
    assert.ok('qualificationProbability' in benchmark.body.recommended.teams.A.stageOne);
  });
});

test('an optimizer assignment cannot apply after state changes', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const result = (await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession })).body;
    await req('POST', '/api/games', { body: { no: 99, score: 120 }, coachSession });
    const apply = await req('POST', '/api/teams', {
      body: { assignments: result.recommended.assignments,
        evaluationVersion: result.evaluationVersion }, coachSession
    });
    assert.equal(apply.status, 409);
  });
});
