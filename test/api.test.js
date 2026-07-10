/* End-to-end API + AUTH suite against a self-contained server:
   temporary DATA_DIR, OS-assigned port, random test-only coach PIN. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, api } = require('./helpers');

let srv, req, coachSession;

before(async () => {
  srv = await startServer();
  req = api(srv.base);
  const r = await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } });
  assert.equal(r.status, 200);
  coachSession = r.body.session;
});
after(async () => { if (srv) await srv.stop(); });

async function inviteFor(no) {
  const r = await req('GET', '/api/invites', { coachSession });
  assert.equal(r.status, 200);
  return r.body.players.find(p => p.no === no).token;
}

test('basics: health, state shape, secrets stripped', async () => {
  let r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  r = await req('GET', '/api/state');
  assert.equal(r.body.players.length, 15);
  assert.ok(r.body.players.every(p => !('authPin' in p) && !('inviteToken' in p)), 'state strips authPin/inviteToken');
  assert.ok(!('sessions' in r.body), 'state does not expose sessions');
});

test('coach auth: session issued, wrong PIN rejected, raw PIN header no longer accepted', async () => {
  let r = await req('POST', '/api/coach/verify', { body: { pin: 'wrong-pin' } });
  assert.equal(r.status, 401);
  r = await req('GET', '/api/invites');
  assert.equal(r.status, 401, 'invites blocked without coach');
  r = await req('GET', '/api/invites', { headers: { 'x-coach-pin': srv.coachPin } });
  assert.equal(r.status, 401, 'legacy x-coach-pin header must not grant access');
  r = await req('GET', '/api/invites', { coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 15);
});

test('invite claim is single-use and cannot be replayed', async () => {
  const tok = await inviteFor(99);
  let r = await req('GET', '/api/join?t=' + tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.player.no, 99);
  r = await req('POST', '/api/claim', { body: { token: tok, pin: '1234' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.no, 99);
  assert.equal(r.body.isCoach, false);
  // replay: the claimed invite must not set another PIN or issue another session
  r = await req('POST', '/api/claim', { body: { token: tok, pin: '9999' } });
  assert.equal(r.status, 404, 'claimed invite cannot be replayed');
  r = await req('GET', '/api/join?t=' + tok);
  assert.equal(r.status, 404, 'used invite link no longer resolves');
  const invites = await req('GET', '/api/invites', { coachSession });
  assert.equal(invites.body.players.find(p => p.no === 99).token, null, 'consumed invite has no token');
});

test('claim requires a 4-digit PIN', async () => {
  const tok = await inviteFor(31);
  let r = await req('POST', '/api/claim', { body: { token: tok, pin: 'abc' } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/claim', { body: { token: tok } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/claim', { body: { token: tok, pin: '2468' } });
  assert.equal(r.status, 200, 'invite still valid after bad-PIN attempts');
});

test('player enforcement: own games only, validation, immutable ids', async () => {
  let r = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  assert.equal(r.status, 200);
  const s99 = r.body.session;
  r = await req('POST', '/api/games', { body: { no: 99, score: 150, strikes: 3, spares: 2 }, session: s99 });
  assert.equal(r.status, 200);
  const g = r.body.game;
  assert.ok(typeof g.id === 'string' && g.id.length >= 16, 'game gets a collision-resistant id');
  r = await req('POST', '/api/games', { body: { no: 38, score: 150 }, session: s99 });
  assert.equal(r.status, 403, 'player cannot log another player');
  r = await req('POST', '/api/games', { body: { no: 99, score: 150 } });
  assert.equal(r.status, 401, 'no session -> 401');
  r = await req('POST', '/api/games', { body: { no: 99, score: 999 }, session: s99 });
  assert.equal(r.status, 400, 'score > 300 rejected');
  r = await req('POST', '/api/games', { body: { no: 99, score: 150.5 }, session: s99 });
  assert.equal(r.status, 400, 'non-integer score rejected');
  r = await req('POST', '/api/games', { body: { no: 99, score: 100, date: '<script>x' }, session: s99 });
  assert.equal(r.status, 400, 'garbage date rejected');
  // delete/verify by id
  r = await req('DELETE', '/api/games/99/' + g.id, { session: s99 });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 1);
  r = await req('DELETE', '/api/games/99/' + g.id, { session: s99 });
  assert.equal(r.body.removed, 0, 'second delete is a no-op');
});

test('undo path: server-side delete really removes the game (survives refresh)', async () => {
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const s99 = login.body.session;
  const created = await req('POST', '/api/games', { body: { no: 99, score: 180 }, session: s99 });
  const id = created.body.game.id;
  const del = await req('DELETE', '/api/games/99/' + id, { session: s99 });
  assert.equal(del.status, 200);
  const st = await req('GET', '/api/state');
  const games = st.body.players.find(p => p.no === 99).games;
  assert.ok(!games.some(x => x.id === id), 'deleted game does not come back on refresh');
});

test('retried submission with the same clientId creates exactly one game', async () => {
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const s99 = login.body.session;
  const body = { no: 99, score: 201, strikes: 5, spares: 1, date: '2026-07-01', clientId: 'outbox-retry-1' };
  const r1 = await req('POST', '/api/games', { body, session: s99 });
  assert.equal(r1.status, 200);
  const r2 = await req('POST', '/api/games', { body, session: s99 });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.game.id, r1.body.game.id, 'retry returns the same game');
  const st = await req('GET', '/api/state');
  const matches = st.body.players.find(p => p.no === 99).games.filter(g => g.clientId === 'outbox-retry-1');
  assert.equal(matches.length, 1, 'exactly one game for the clientId');
  await req('DELETE', '/api/games/99/' + r1.body.game.id, { session: s99 });
});

test('captain gets coach powers from their own login', async () => {
  const tok = await inviteFor(149);
  let r = await req('POST', '/api/claim', { body: { token: tok, pin: '9999' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.isCoach, true);
  const s149 = r.body.session;
  r = await req('POST', '/api/games', { body: { no: 38, score: 120 }, session: s149 });
  assert.equal(r.status, 200, 'captain can log for any player');
  const ts38 = r.body.game.id;
  r = await req('POST', '/api/games/38/' + ts38 + '/verify', { session: s149 });
  assert.equal(r.status, 200);
  assert.equal(r.body.verified, false, 'coach-logged game starts verified; toggle flips it');
  r = await req('PUT', '/api/players/38', { body: { team: 'A' }, session: s149 });
  assert.equal(r.status, 200);
  const login99 = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  r = await req('DELETE', '/api/games/38/' + ts38, { session: login99.body.session });
  assert.equal(r.status, 403, 'player cannot delete another player game');
  r = await req('DELETE', '/api/games/38/' + ts38, { session: s149 });
  assert.equal(r.status, 200, 'captain can delete any game');
});

test('coach-only endpoints reject player sessions', async () => {
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const s99 = login.body.session;
  let r = await req('PUT', '/api/players/38', { body: { available: false }, session: s99 });
  assert.equal(r.status, 401);
  r = await req('PUT', '/api/players/38', { body: { available: false }, coachSession });
  assert.equal(r.status, 200);
  r = await req('POST', '/api/teams', { body: { assignments: { 149: 'A' } }, coachSession });
  assert.equal(r.status, 200);
  r = await req('PUT', '/api/settings', { body: { capCr: 24 }, coachSession });
  assert.equal(r.body.settings.capCr, 24);
  r = await req('POST', '/api/mytarget', { body: { no: 99, target: 150 }, session: s99 });
  assert.equal(r.status, 200);
  r = await req('POST', '/api/mytarget', { body: { no: 38, target: 150 }, session: s99 });
  assert.equal(r.status, 403);
});

test('invite reset revokes existing sessions and old invite links', async () => {
  const tok = await inviteFor(43);
  let r = await req('POST', '/api/claim', { body: { token: tok, pin: '1212' } });
  const oldSession = r.body.session;
  r = await req('POST', '/api/invites/reset', { body: { no: 43 }, coachSession });
  assert.equal(r.status, 200);
  const newTok = r.body.token;
  assert.ok(newTok && newTok !== tok);
  r = await req('POST', '/api/session', { body: { session: oldSession } });
  assert.equal(r.status, 401, 'old session revoked by reset');
  r = await req('POST', '/api/games', { body: { no: 43, score: 100 }, session: oldSession });
  assert.equal(r.status, 401, 'revoked session cannot write');
  r = await req('POST', '/api/login', { body: { no: 43, pin: '1212' } });
  assert.equal(r.status, 401, 'old PIN cleared by reset');
  r = await req('POST', '/api/claim', { body: { token: newTok, pin: '3434' } });
  assert.equal(r.status, 200, 'new invite works after reset');
});

test('logout revokes the presented session', async () => {
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const s = login.body.session;
  let r = await req('POST', '/api/logout', { session: s });
  assert.equal(r.status, 200);
  r = await req('POST', '/api/session', { body: { session: s } });
  assert.equal(r.status, 401, 'logged-out session rejected');
});

test('backup + restore: strict validation, secrets survive round trip', async () => {
  let r = await req('POST', '/api/games', { body: { no: 99, score: 175 }, coachSession });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/backup');
  assert.equal(r.status, 401, 'backup blocked without coach');
  r = await req('GET', '/api/backup', { coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 15);
  assert.ok(r.body.players.some(p => (p.games || []).length > 0), 'backup includes logged games');
  const snapshot = JSON.parse(JSON.stringify(r.body));

  r = await req('POST', '/api/restore', { body: { players: 'nope' }, coachSession });
  assert.equal(r.status, 400, 'non-array players rejected');
  r = await req('POST', '/api/restore', { body: snapshot });
  assert.equal(r.status, 401, 'restore blocked without coach');
  const bad = g => ({ players: [{ no: 99, games: [g] }] });
  for (const g of [
    { score: 999, date: '2026-01-01' },
    { score: 150.5, date: '2026-01-01' },
    { score: 150, date: 'not-a-date' },
    { score: 150, date: '2026-13-45' },
    { score: 150, date: '2026-01-01', strikes: 99 },
    { score: 150, date: '2026-01-01', id: '<img src=x onerror=alert(1)>' },
    { score: 150, date: '2026-01-01', by: 'hacker' },
  ]) {
    r = await req('POST', '/api/restore', { body: bad(g), coachSession });
    assert.equal(r.status, 400, 'malformed game rejected: ' + JSON.stringify(g));
  }
  r = await req('POST', '/api/restore', { body: { players: [{ no: 12345, games: [] }] }, coachSession });
  assert.equal(r.status, 400, 'unknown player rejected');

  r = await req('POST', '/api/restore', { body: snapshot, coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 15);
  r = await req('GET', '/api/backup', { coachSession });
  assert.ok(r.body.players.some(p => (p.games || []).length > 0), 'games survive the restore');
  // restore replaces identities -> player sessions are revoked, PINs still work
  r = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  assert.equal(r.status, 200, 'restored PIN hash still works');
});

test('restore revokes player-bound sessions', async () => {
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const s99 = login.body.session;
  const backup = (await req('GET', '/api/backup', { coachSession })).body;
  const r = await req('POST', '/api/restore', { body: JSON.parse(JSON.stringify(backup)), coachSession });
  assert.equal(r.status, 200);
  const chk = await req('POST', '/api/session', { body: { session: s99 } });
  assert.equal(chk.status, 401, 'player session invalid after restore');
});

test('import validates strictly and dedupes', async () => {
  const g = { score: 142, strikes: 2, spares: 3, date: '2026-06-30', id: 'imported-game-1' };
  let r = await req('POST', '/api/import', { body: { players: [{ no: 82, games: [g] }] }, coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 1);
  r = await req('POST', '/api/import', { body: { players: [{ no: 82, games: [g] }] }, coachSession });
  assert.equal(r.body.added, 0, 'same id not imported twice');
  r = await req('POST', '/api/import', { body: { players: [{ no: 82, games: [{ score: -5, date: '2026-06-30' }] }] }, coachSession });
  assert.equal(r.status, 400, 'malformed import rejected');
});

test('match day flow', async () => {
  let r = await req('POST', '/api/matchday', { body: { team: 'A', no: 149, game: 1, score: 185, strikes: 5, spares: 2 }, coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.matchday.A['149-1'].score, 185);
  r = await req('POST', '/api/matchday', { body: { team: 'A', no: 149, game: 1, score: 185 } });
  assert.equal(r.status, 401);
  r = await req('POST', '/api/matchday', { body: { team: 'X', no: 149, game: 1, score: 100 }, coachSession });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/matchday', { body: { team: 'A', no: 149, game: 3, score: 100 }, coachSession });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/matchday', { body: { team: 'A', clear: true }, coachSession });
  assert.equal(Object.keys(r.body.matchday.A).length, 0);
});

test('reset keeps installId and pure coach sessions, revokes player sessions', async () => {
  const before = await req('GET', '/api/state');
  const iid = before.body.installId;
  const login = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } });
  const r = await req('POST', '/api/reset', { coachSession });
  assert.equal(r.status, 200);
  const after = await req('GET', '/api/state');
  assert.equal(after.body.installId, iid, 'installId stable across deliberate reset');
  const chkPlayer = await req('POST', '/api/session', { body: { session: login.body.session } });
  assert.equal(chkPlayer.status, 401, 'player session revoked by reset');
  const chkCoach = await req('GET', '/api/invites', { coachSession });
  assert.equal(chkCoach.status, 200, 'pure coach session survives reset');
});

test('static app served and wired to auth API', async () => {
  const r = await fetch(srv.base + '/');
  const html = await r.text();
  assert.ok(/VOX STARS/.test(html));
  assert.ok(/api\/claim/.test(html));
});
