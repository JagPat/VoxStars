const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api } = require('./helpers');

test('competitor observations are validated, private, persisted, and removable by coaches', async () => {
  const srv = await startServer({ keepDataDir: true });
  const req = api(srv.base);
  try {
    const coachSession = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    assert.equal((await req('POST', '/api/competitors', { body: {} })).status, 401);
    assert.equal((await req('POST', '/api/competitors', {
      body: { franchise: 'ICA', stage: 'stageOne', score: 4000, source: 'Organizer', observedAt: '2026-07-20' }, coachSession
    })).status, 400);

    const created = await req('POST', '/api/competitors', { coachSession, body: {
      franchise: 'ICA Invincibles', team: 'A', stage: 'stageOne', score: 1124,
      source: 'Organizer scoreboard', observedAt: '2026-07-20'
    }});
    assert.equal(created.status, 200);
    assert.equal(created.body.observation.confidence, 'confirmed');
    assert.match(created.body.observation.id, /^c-/);

    const coachState = await req('GET', '/api/state', { coachSession });
    assert.equal(coachState.body.competitorObservations.length, 1);
    const invite = coachState.body.players.find(p => p.no === 99).inviteToken;
    const playerSession = (await req('POST', '/api/claim', { body: { token: invite, pin: '1234' } })).body.session;
    const playerState = await req('GET', '/api/state', { session: playerSession });
    assert.equal('competitorObservations' in playerState.body, false);

    assert.equal((await req('DELETE', '/api/competitors/' + created.body.observation.id, { session: playerSession })).status, 401);
    const removed = await req('DELETE', '/api/competitors/' + created.body.observation.id, { coachSession });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 1);
  } finally { await srv.stop(); }
});
