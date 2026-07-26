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
