/* Data-integrity regressions run against fresh isolated servers so a failing
   restore or mutation can never contaminate another test. */
const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, api } = require('./helpers');

async function withServer(run) {
  const srv = await startServer();
  const req = api(srv.base);
  try {
    const verified = await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } });
    assert.equal(verified.status, 200);
    await run({ req, coachSession: verified.body.session });
  } finally {
    await srv.stop();
  }
}

test('targets and estimated averages stay within bowling bounds', async () => {
  await withServer(async ({ req, coachSession }) => {
    let r = await req('POST', '/api/mytarget', { body: { no: 149, target: 150 }, coachSession });
    assert.equal(r.status, 200);
    for (const target of [-25, 301, 150.5, '150']) {
      r = await req('POST', '/api/mytarget', { body: { no: 149, target }, coachSession });
      assert.equal(r.status, 400, 'reject target ' + JSON.stringify(target));
    }
    r = await req('POST', '/api/mytarget', { body: { no: 149 }, coachSession });
    assert.equal(r.status, 400, 'missing target is rejected');

    r = await req('PUT', '/api/players/149', { body: { estAvg: 120.5 }, coachSession });
    assert.equal(r.status, 200);
    for (const estAvg of [-1, 301, '120']) {
      r = await req('PUT', '/api/players/149', { body: { estAvg }, coachSession });
      assert.equal(r.status, 400, 'reject estimate ' + JSON.stringify(estAvg));
    }

    const state = await req('GET', '/api/state', { coachSession });
    const player = state.body.players.find(p => p.no === 149);
    assert.equal(player.target, 150, 'invalid target requests leave the target unchanged');
    assert.equal(player.estAvg, 120.5, 'invalid estimate requests leave the estimate unchanged');
  });
});

test('restore rejects duplicate roster numbers without changing state', async () => {
  await withServer(async ({ req, coachSession }) => {
    const before = await req('GET', '/api/state', { coachSession });
    const r = await req('POST', '/api/restore', {
      body: {
        players: [
          { no: 149, games: [], target: 100 },
          { no: 149, games: [], target: 200 },
        ],
      },
      coachSession,
    });
    assert.equal(r.status, 400);
    const after = await req('GET', '/api/state', { coachSession });
    assert.equal(after.body.updatedAt, before.body.updatedAt, 'rejected restore does not commit');
    assert.equal(after.body.players.find(p => p.no === 149).target, null);
  });
});

test('match-day entry must belong to the submitted sub-team', async () => {
  await withServer(async ({ req, coachSession }) => {
    let r = await req('POST', '/api/teams', {
      body: { assignments: { 149: 'A', 171: 'B' } },
      coachSession,
    });
    assert.equal(r.status, 200);
    r = await req('POST', '/api/matchday', {
      body: { team: 'B', no: 149, game: 1, score: 180, strikes: 3, spares: 2 },
      coachSession,
    });
    assert.equal(r.status, 400, 'player 149 is not on team B');
    r = await req('POST', '/api/matchday', {
      body: { team: 'A', no: 149, game: 1, score: 180, strikes: 3, spares: 2 },
      coachSession,
    });
    assert.equal(r.status, 200, 'assigned team remains valid');
  });
});
