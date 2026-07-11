/* Startup, durability and lockout suites — each case gets its own
   dedicated server, temporary DATA_DIR and test-only configuration. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, expectStartupFailure, api, sleep, tmpDataDir, legacyPinHash } = require('./helpers');
const SHIM = path.join(__dirname, 'fail-write-once.js');

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

test('production startup fails with a too-weak coach credential', async () => {
  const r = await expectStartupFailure({ NODE_ENV: 'production', COACH_PIN: 'abc12' });
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

test('valid-JSON-but-structurally-broken state (players:[null]) degrades, not crash', async () => {
  const dataDir = tmpDataDir();
  const content = '{"players":[null,{"no":99,"games":[null]}]}';
  fs.writeFileSync(path.join(dataDir, 'state.json'), content);
  const srv = await startServer({ dataDir });
  try {
    const r = await api(srv.base)('GET', '/api/health');
    assert.equal(r.status, 503, 'broken shape -> degraded, server still up');
    assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), content, 'file preserved');
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
    r = await req('GET', '/api/state', { coachSession: cs });
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

test('concurrent writes with a mid-flight failure: no ack lost, no rejected write persisted', async () => {
  const sentinel = path.join(tmpDataDir(), 'FAILNOW');
  const srv = await startServer({ preload: SHIM, env: { VOX_TEST_FAIL_SENTINEL: sentinel } });
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    fs.writeFileSync(sentinel, '1'); // arm: the next atomic write fails once
    // two concurrent coach writes; whichever grabs the write first fails transiently
    const [a, b] = await Promise.all([
      req('POST', '/api/games', { body: { no: 99, score: 111 }, coachSession: cs }),
      sleep(30).then(() => req('POST', '/api/games', { body: { no: 99, score: 222 }, coachSession: cs })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 503], 'exactly one failed, one succeeded');
    const ackScore = a.status === 200 ? 111 : 222;
    const rejScore = a.status === 200 ? 222 : 111;
    await sleep(150);
    const disk = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'state.json'), 'utf8')).players.find(p => p.no === 99).games.map(g => g.score);
    const mem = (await req('GET', '/api/state', { coachSession: cs })).body.players.find(p => p.no === 99).games.map(g => g.score);
    assert.ok(disk.includes(ackScore), 'acknowledged (200) write is durably on disk');
    assert.ok(!disk.includes(rejScore), 'rejected (503) write is NOT persisted');
    assert.deepEqual([...mem].sort(), [...disk].sort(), 'in-memory state matches disk');
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
    const st = await req('GET', '/api/state', { coachSession: cs });
    const games = st.body.players.find(p => p.no === 99).games;
    assert.equal(games.length, 1);
    assert.equal(games[0].id, g2.id, 'the other same-timestamp game survives');
  } finally { await srv.stop(); }
});

test('sessions expire and are rejected afterwards', async () => {
  // TTL must comfortably exceed setup latency (even on a loaded CI runner) so
  // the setup sessions stay valid while we arrange the test; the sleep then
  // pushes real time past the TTL so expiry is observed deterministically.
  const TTL = 2000;
  const srv = await startServer({ env: { VOX_TEST_SESSION_TTL_MS: String(TTL) } });
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const inv = await req('GET', '/api/invites', { coachSession: cs });
    assert.equal(inv.status, 200, 'setup coach session still valid (raise TTL if this flakes on CI)');
    const tok = inv.body.players.find(p => p.no === 99).token;
    const s99 = (await req('POST', '/api/claim', { body: { token: tok, pin: '1234' } })).body.session;
    let r = await req('POST', '/api/session', { body: { session: s99 } });
    assert.equal(r.status, 200, 'fresh session valid');
    await sleep(TTL + 400);
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

test('coach brute force cannot be spoofed past the trusted proxy hop count', async () => {
  // Forged X-Forwarded-For is ignored beyond the trusted hop, so a rotating
  // client IP cannot evade the per-IP lockout.
  const srv = await startServer({ env: { TRUST_PROXY: '1' } });
  try {
    const req = api(srv.base);
    let locked = false;
    for (let i = 0; i < 15; i++) {
      // one real proxy hop appends the true client IP; attacker prepends junk
      const r = await req('POST', '/api/coach/verify', { body: { pin: 'guess' + i }, headers: { 'X-Forwarded-For': '9.9.9.' + i + ', 203.0.113.9' } });
      if (r.status === 429) { locked = true; break; }
    }
    assert.ok(locked, 'rotating forged XFF still hits the per-IP lockout (spoof ignored past 1 hop)');
  } finally { await srv.stop(); }
});

test('coach global backstop locks distributed guessing even across many IPs', async () => {
  const srv = await startServer(); // test mode trusts XFF from loopback -> distinct req.ip per request
  try {
    const req = api(srv.base);
    let locked = false;
    for (let i = 0; i < 35; i++) {
      const r = await req('POST', '/api/coach/verify', { body: { pin: 'g' + i }, headers: { 'X-Forwarded-For': '198.51.100.' + i } });
      if (r.status === 429) { locked = true; break; }
    }
    assert.ok(locked, 'global backstop caps total coach-PIN guesses regardless of source IP');
  } finally { await srv.stop(); }
});

test('login lockout is per (account+IP): one IP cannot lock the owner on another IP', async () => {
  const srv = await startServer(); // XFF from loopback is trusted in test mode
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const tok = (await req('GET', '/api/invites', { coachSession: cs })).body.players.find(p => p.no === 82).token;
    await req('POST', '/api/claim', { body: { token: tok, pin: '2020' } });
    // attacker IP burns through the limit against player 82
    for (let i = 0; i < 6; i++) {
      await req('POST', '/api/login', { body: { no: 82, pin: '0000' }, headers: { 'X-Forwarded-For': '10.0.0.1' } });
    }
    let r = await req('POST', '/api/login', { body: { no: 82, pin: '2020' }, headers: { 'X-Forwarded-For': '10.0.0.1' } });
    assert.equal(r.status, 429, 'attacker IP is locked for this account');
    // the real owner on a different IP is unaffected
    r = await req('POST', '/api/login', { body: { no: 82, pin: '2020' }, headers: { 'X-Forwarded-For': '77.77.77.77' } });
    assert.equal(r.status, 200, 'owner on a different IP can still log in');
  } finally { await srv.stop(); }
});

test('legacy sha256 PIN hashes still verify and are upgraded to scrypt on login', async () => {
  const dataDir = tmpDataDir();
  const salt = 'test-salt-' + Date.now();
  const legacyTok = 'aaaabbbbccccdddd0000111122223333'; // legacy model kept tokens after claim
  const seeded = {
    players: [{ no: 99, claimed: true, inviteToken: legacyTok, authPin: legacyPinHash('4321', salt),
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
    assert.equal(p99.inviteToken, null, 'legacy still-live invite token consumed on migration');
    const joined = await req('GET', '/api/join?t=' + legacyTok);
    assert.equal(joined.status, 404, 'legacy claimed invite link no longer works');
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
    const st = await req2('GET', '/api/state', { coachSession: cs });
    const games = st.body.players.find(p => p.no === 22).games;
    assert.equal(games.length, 1);
    assert.equal(games[0].id, game.id, 'game id is stable across restarts');
    const chk = await req2('POST', '/api/coach/verify', { body: { pin } });
    assert.equal(chk.status, 200);
  } finally { await srv.stop(); }
});
