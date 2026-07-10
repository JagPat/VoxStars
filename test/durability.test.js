/* Startup, durability and lockout suites — each case gets its own
   dedicated server, temporary DATA_DIR and test-only configuration. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, expectStartupFailure, api, sleep, tmpDataDir, legacyPinHash } = require('./helpers');

test('production startup fails without an explicitly configured coach credential', async () => {
  const r = await expectStartupFailure({ NODE_ENV: 'production' });
  assert.notEqual(r.code, 0, 'process must exit non-zero');
  assert.match(r.stderr, /COACH_PIN/, 'failure names the missing credential');
});

test('production startup fails with the known insecure development fallback', async () => {
  const r = await expectStartupFailure({ NODE_ENV: 'production', COACH_PIN: '2626' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /COACH_PIN/);
});

test('production startup succeeds with a strong credential', async () => {
  const srv = await startServer({ env: { NODE_ENV: 'production' } });
  try {
    const r = await api(srv.base)('GET', '/api/health');
    assert.equal(r.status, 200);
  } finally { await srv.stop(); }
});

test('corrupt state file is preserved, server reports degraded health', async () => {
  const dataDir = tmpDataDir();
  const garbage = '{"players": [truncated-mid-write';
  fs.writeFileSync(path.join(dataDir, 'state.json'), garbage);
  const srv = await startServer({ dataDir });
  try {
    const req = api(srv.base);
    let r = await req('GET', '/api/health');
    assert.equal(r.status, 503, 'health reports failure');
    assert.equal(r.body.degraded, true);
    assert.ok(r.body.recovery, 'health points at the recovery procedure');
    r = await req('GET', '/api/state');
    assert.equal(r.status, 503, 'API refuses to serve from a corrupt store');
    r = await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } });
    assert.equal(r.status, 503, 'no writes accepted in degraded mode');
    assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), garbage,
      'corrupt state file is never overwritten');
    assert.ok(!fs.existsSync(path.join(dataDir, 'backups')) ||
      fs.readdirSync(path.join(dataDir, 'backups')).length === 0,
      'no backup is taken of a corrupt file');
  } finally { await srv.stop(); }
});

test('valid-JSON-but-wrong-shape state file is treated as corrupt, not blanked', async () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
  const srv = await startServer({ dataDir });
  try {
    const r = await api(srv.base)('GET', '/api/health');
    assert.equal(r.status, 503);
    assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), '{}');
  } finally { await srv.stop(); }
});

test('persistence failure returns an error and does not acknowledge the mutation', async () => {
  const srv = await startServer();
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const tok = (await req('GET', '/api/invites', { coachSession: cs })).body.players.find(p => p.no === 99).token;
    const s99 = (await req('POST', '/api/claim', { body: { token: tok, pin: '1234' } })).body.session;

    // Make the atomic write fail: a directory where the temp file goes.
    fs.mkdirSync(path.join(srv.dataDir, 'state.json.tmp'));
    let r = await req('POST', '/api/games', { body: { no: 99, score: 222 }, session: s99 });
    assert.equal(r.status, 503, 'failed persistence is a server error, not a success');
    r = await req('GET', '/api/state');
    assert.equal(r.status, 200, 'reads still work — state reverted to last durable copy');
    assert.equal(r.body.players.find(p => p.no === 99).games.length, 0,
      'unacknowledged mutation is discarded from memory');

    // Writes recover once the disk problem is fixed.
    fs.rmdirSync(path.join(srv.dataDir, 'state.json.tmp'));
    r = await req('POST', '/api/games', { body: { no: 99, score: 222 }, session: s99 });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'state.json'), 'utf8'));
    assert.equal(onDisk.players.find(p => p.no === 99).games.length, 1, 'acknowledged game is on disk');
  } finally { await srv.stop(); }
});

test('two games created at the same mocked time keep independent identities', async () => {
  const srv = await startServer({ env: { VOX_TEST_FROZEN_NOW: '1700000000000' } });
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const g1 = (await req('POST', '/api/games', { body: { no: 99, score: 100 }, coachSession: cs })).body.game;
    const g2 = (await req('POST', '/api/games', { body: { no: 99, score: 200 }, coachSession: cs })).body.game;
    assert.equal(g1.ts, 1700000000000);
    assert.equal(g1.ts, g2.ts, 'same mocked timestamp');
    assert.notEqual(g1.id, g2.id, 'ids stay distinct');
    const del = await req('DELETE', '/api/games/99/' + g1.id, { coachSession: cs });
    assert.equal(del.body.removed, 1, 'delete removes exactly the addressed game');
    const st = await req('GET', '/api/state');
    const games = st.body.players.find(p => p.no === 99).games;
    assert.equal(games.length, 1);
    assert.equal(games[0].id, g2.id, 'the other same-timestamp game survives');
  } finally { await srv.stop(); }
});

test('sessions expire and are rejected afterwards', async () => {
  const srv = await startServer({ env: { VOX_TEST_SESSION_TTL_MS: '120' } });
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const tok = (await req('GET', '/api/invites', { coachSession: cs })).body.players.find(p => p.no === 99).token;
    const s99 = (await req('POST', '/api/claim', { body: { token: tok, pin: '1234' } })).body.session;
    let r = await req('POST', '/api/session', { body: { session: s99 } });
    assert.equal(r.status, 200, 'fresh session valid');
    await sleep(250);
    r = await req('POST', '/api/session', { body: { session: s99 } });
    assert.equal(r.status, 401, 'expired session rejected on validation');
    r = await req('POST', '/api/games', { body: { no: 99, score: 100 }, session: s99 });
    assert.equal(r.status, 401, 'expired session cannot write');
    r = await req('GET', '/api/invites', { coachSession: cs });
    assert.equal(r.status, 401, 'expired coach session rejected');
  } finally { await srv.stop(); }
});

test('login throttling locks brute force but leaves the coach-reset recovery open', async () => {
  const srv = await startServer();
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const tok = (await req('GET', '/api/invites', { coachSession: cs })).body.players.find(p => p.no === 38).token;
    await req('POST', '/api/claim', { body: { token: tok, pin: '5555' } });
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', '/api/login', { body: { no: 38, pin: '0001' } });
      assert.equal(r.status, 401);
    }
    let r = await req('POST', '/api/login', { body: { no: 38, pin: '5555' } });
    assert.equal(r.status, 429, 'locked out even with the right PIN');
    assert.match(String(r.body.error), /try again/i);
    // recovery: a coach invite reset clears the lock and the new invite claims fine
    r = await req('POST', '/api/invites/reset', { body: { no: 38 }, coachSession: cs });
    assert.equal(r.status, 200);
    r = await req('POST', '/api/claim', { body: { token: r.body.token, pin: '7788' } });
    assert.equal(r.status, 200, 'reset invite claim not blocked by the lockout');
    r = await req('POST', '/api/login', { body: { no: 38, pin: '7788' } });
    assert.equal(r.status, 200, 'login works again after recovery');
  } finally { await srv.stop(); }
});

test('coach PIN verification is rate limited', async () => {
  const srv = await startServer();
  try {
    const req = api(srv.base);
    for (let i = 0; i < 10; i++) await req('POST', '/api/coach/verify', { body: { pin: 'bad-guess' } });
    const r = await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } });
    assert.equal(r.status, 429, 'coach verify locked after repeated failures');
  } finally { await srv.stop(); }
});

test('legacy sha256 PIN hashes still verify and are upgraded to scrypt on login', async () => {
  const dataDir = tmpDataDir();
  const salt = 'test-salt-' + Date.now();
  const seeded = {
    players: [{ no: 99, claimed: true, inviteToken: null, authPin: legacyPinHash('4321', salt),
      games: [{ score: 150, strikes: 1, spares: 2, date: '2026-01-05', ts: 1767571200000 }] }],
    settings: {}, sessions: {}, matchday: { A: {}, B: {}, C: {} }, installId: 'seeded-install', updatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(seeded));
  const srv = await startServer({ dataDir, env: { AUTH_SALT: salt } });
  try {
    const req = api(srv.base);
    let r = await req('POST', '/api/login', { body: { no: 99, pin: '9999' } });
    assert.equal(r.status, 401, 'wrong PIN still rejected against legacy hash');
    r = await req('POST', '/api/login', { body: { no: 99, pin: '4321' } });
    assert.equal(r.status, 200, 'legacy PIN verifies');
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    const p99 = disk.players.find(p => p.no === 99);
    assert.match(p99.authPin, /^scrypt:/, 'hash upgraded to scrypt after successful login');
    assert.ok(p99.games[0].id, 'legacy game was assigned an immutable id on migration');
    r = await req('POST', '/api/login', { body: { no: 99, pin: '4321' } });
    assert.equal(r.status, 200, 'login still works after the upgrade');
  } finally { await srv.stop(); }
});

test('state survives a server restart on the same data dir', async () => {
  const dataDir = tmpDataDir();
  const pin = 'restart-pin-test-1';
  let srv = await startServer({ dataDir, coachPin: pin, keepDataDir: true });
  const req1 = api(srv.base);
  const cs = (await req1('POST', '/api/coach/verify', { body: { pin } })).body.session;
  const game = (await req1('POST', '/api/games', { body: { no: 22, score: 167 }, coachSession: cs })).body.game;
  await srv.stop();

  srv = await startServer({ dataDir, coachPin: pin });
  try {
    const req2 = api(srv.base);
    const st = await req2('GET', '/api/state');
    const games = st.body.players.find(p => p.no === 22).games;
    assert.equal(games.length, 1);
    assert.equal(games[0].id, game.id, 'game id is stable across restarts');
    const chk = await req2('POST', '/api/coach/verify', { body: { pin } });
    assert.equal(chk.status, 200);
  } finally { await srv.stop(); }
});
