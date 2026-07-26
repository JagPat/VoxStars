const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, tmpDataDir } = require('./helpers');

async function withCoach(run) {
  const srv = await startServer(); const req = api(srv.base);
  try {
    const coachSession = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    await run({ req, coachSession });
  } finally { await srv.stop(); }
}

async function applyLegalSplit(req, coachSession) {
  const evaluation = (await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession })).body;
  const applied = await req('POST', '/api/teams', { body: {
    assignments: evaluation.recommended.assignments, evaluationVersion: evaluation.evaluationVersion
  }, coachSession });
  assert.equal(applied.status, 200);
  return applied.body.assignmentVersion;
}

test('submitted assignments reject every team mutation until audited unlock', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const assignmentVersion = await applyLegalSplit(req, coachSession);
    const submitted = await req('POST', '/api/teams/submit', { body: { assignmentVersion }, coachSession });
    assert.equal(submitted.status, 200);
    assert.equal((await req('POST', '/api/teams', { body: { assignments: { 149: 'A' } }, coachSession })).status, 423);
    assert.equal((await req('PUT', '/api/players/99', { body: { team: 'B' }, coachSession })).status, 423);
    const unlocked = await req('POST', '/api/teams/unlock', {
      body: { reason: 'Organizer approved correction' }, coachSession
    });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.audit.at(-1).reason, 'Organizer approved correction');
    assert.equal((await req('POST', '/api/teams', { body: { assignments: { 149: 'A' } }, coachSession })).status, 200);
  });
});

test('submission requires complete legal teams and current assignment version', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const initial = (await req('GET', '/api/state', { coachSession })).body;
    assert.equal((await req('POST', '/api/teams/submit', {
      body: { assignmentVersion: initial.updatedAt }, coachSession
    })).status, 400);
    const version = await applyLegalSplit(req, coachSession);
    assert.equal((await req('POST', '/api/games', { body: { no: 99, score: 111 }, coachSession })).status, 200);
    assert.equal((await req('POST', '/api/teams/submit', {
      body: { assignmentVersion: version }, coachSession
    })).status, 409);
  });
});

test('submission and audit survive backup restore while player state hides audit reasons', async () => {
  await withCoach(async ({ req, coachSession }) => {
    const version = await applyLegalSplit(req, coachSession);
    await req('POST', '/api/teams/submit', { body: { assignmentVersion: version }, coachSession });
    await req('POST', '/api/teams/unlock', { body: { reason: 'Organizer approved correction' }, coachSession });
    const backup = (await req('GET', '/api/backup', { coachSession })).body;
    assert.equal(backup.teamSubmissionAudit.length, 1);
    await req('POST', '/api/reset', { coachSession });
    assert.equal((await req('POST', '/api/restore', { body: backup, coachSession })).status, 200);
    const coachState = (await req('GET', '/api/state', { coachSession })).body;
    assert.equal(coachState.teamSubmissionAudit[0].reason, 'Organizer approved correction');
    const invite = (await req('GET', '/api/invites', { coachSession })).body.players.find(p => p.no === 99).token;
    const playerSession = (await req('POST', '/api/claim', { body: { token: invite, pin: '1234' } })).body.session;
    const playerState = (await req('GET', '/api/state', { session: playerSession })).body;
    assert.equal('teamSubmissionAudit' in playerState, false);
    assert.equal(JSON.stringify(playerState).includes('Organizer approved correction'), false);
  });
});

test('applied and submitted optimizer decision survives a server restart', async () => {
  const dataDir = tmpDataDir();
  const first = await startServer({ dataDir, keepDataDir: true });
  try {
    const req = api(first.base);
    const coachSession = (await req('POST', '/api/coach/verify', { body: { pin: first.coachPin } })).body.session;
    const version = await applyLegalSplit(req, coachSession);
    assert.equal((await req('POST', '/api/teams/submit', { body: { assignmentVersion: version }, coachSession })).status, 200);
  } finally { await first.stop(); }

  const second = await startServer({ dataDir });
  try {
    const req = api(second.base);
    const coachSession = (await req('POST', '/api/coach/verify', { body: { pin: second.coachPin } })).body.session;
    const state = (await req('GET', '/api/state', { coachSession })).body;
    assert.equal(state.teamSubmission.locked, true);
    assert.equal(state.players.filter(p => p.team).length, 15);
    const unlocked = await req('POST', '/api/teams/unlock', {
      body: { reason: 'Organizer approved after restart' }, coachSession
    });
    assert.equal(unlocked.status, 200);
    assert.match(unlocked.body.audit.at(-1).reason, /Organizer approved/);
  } finally { await second.stop(); }
});
