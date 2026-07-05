/* End-to-end API + AUTH test. Assumes the server is running at BASE with coach PIN PIN. */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PIN  = process.env.PIN  || '2626';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  x FAIL ' + m)); };
const J = r => r.json();
async function req(method, path, { body, session, coach } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (session) h['x-session'] = session;
  if (coach) h['x-coach-pin'] = coach;
  return fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

(async () => {
  let r, d;
  console.log('BASICS');
  r = await req('GET', '/api/health'); ok(r.status === 200, 'health ok');
  r = await req('GET', '/api/state'); d = await J(r);
  ok(d.players.length === 15, 'state returns 15 players');
  ok(d.players.every(p => !('authPin' in p) && !('inviteToken' in p)), 'state strips secrets (no authPin/inviteToken)');

  console.log('COACH SESSION + INVITES');
  r = await req('POST', '/api/coach/verify', { body: { pin: PIN } }); d = await J(r);
  const coachSession = d.session; ok(d.ok && !!coachSession, 'coach/verify issues a coach session');
  r = await req('POST', '/api/coach/verify', { body: { pin: 'nope' } }); d = await J(r); ok(d.ok === false, 'wrong coach PIN rejected');
  r = await req('GET', '/api/invites'); ok(r.status === 401, 'invites blocked without coach');
  r = await req('GET', '/api/invites', { coach: PIN }); d = await J(r);
  ok(r.status === 200 && d.players.length === 15, 'invites list with coach');
  const tok99 = d.players.find(p => p.no === 99).token, tok149 = d.players.find(p => p.no === 149).token;

  console.log('JOIN + CLAIM + PLAYER ENFORCEMENT');
  r = await req('GET', '/api/join?t=' + tok99); d = await J(r); ok(d.ok && d.player.no === 99, 'join link resolves identity');
  r = await req('POST', '/api/claim', { body: { token: tok99, pin: '1234' } }); d = await J(r);
  const s99 = d.session; ok(d.ok && d.no === 99 && d.isCoach === false, 'claim -> player session (99, not coach)');
  r = await req('POST', '/api/games', { body: { no: 99, score: 150 }, session: s99 }); ok(r.status === 200, 'player logs their OWN game');
  r = await req('POST', '/api/games', { body: { no: 38, score: 150 }, session: s99 }); ok(r.status === 403, 'player CANNOT log another player (403)');
  r = await req('POST', '/api/games', { body: { no: 99, score: 150 } }); ok(r.status === 401, 'no session -> 401');
  r = await req('POST', '/api/games', { body: { no: 99, score: 999 }, session: s99 }); ok(r.status === 400, 'score > 300 rejected');

  console.log('LOGIN (name + PIN) + SESSION');
  r = await req('POST', '/api/login', { body: { no: 99, pin: '1234' } }); d = await J(r); ok(d.ok && d.session, 'name + PIN login works');
  r = await req('POST', '/api/login', { body: { no: 99, pin: '0000' } }); ok(r.status === 401, 'wrong PIN rejected');
  r = await req('POST', '/api/login', { body: { no: 82, pin: '1234' } }); ok(r.status === 401, 'login before claim (no PIN set) rejected');
  r = await req('POST', '/api/session', { body: { session: s99 } }); d = await J(r); ok(d.ok && d.no === 99, 'session verify');

  console.log('CAPTAIN = COACH BY IDENTITY');
  r = await req('POST', '/api/claim', { body: { token: tok149, pin: '9999' } }); d = await J(r);
  const s149 = d.session; ok(d.ok && d.isCoach === true, 'captain (149) claim -> isCoach true');
  r = await req('POST', '/api/games', { body: { no: 38, score: 120 }, session: s149 }); ok(r.status === 200, 'captain can log for ANY player');
  r = await req('PUT', '/api/players/38', { body: { team: 'A' }, session: s149 }); ok(r.status === 200, 'captain session can do coach actions');

  console.log('COACH-ONLY ENDPOINTS');
  r = await req('PUT', '/api/players/38', { body: { available: false }, session: s99 }); ok(r.status === 401, 'player session blocked from coach action');
  r = await req('PUT', '/api/players/38', { body: { available: false }, coach: PIN }); ok(r.status === 200, 'coach PIN can update a player');
  r = await req('POST', '/api/teams', { body: { assignments: { 149: 'A' } }, coach: PIN }); ok(r.status === 200, 'coach can assign teams');
  r = await req('PUT', '/api/settings', { body: { capCr: 24 }, coach: PIN }); d = await J(r); ok(d.settings.capCr === 24, 'coach can update settings');
  r = await req('POST', '/api/mytarget', { body: { no: 99, target: 150 }, session: s99 }); ok(r.status === 200, 'player sets own target');
  r = await req('POST', '/api/mytarget', { body: { no: 38, target: 150 }, session: s99 }); ok(r.status === 403, 'player cannot set ANOTHER target');
  r = await req('POST', '/api/reset', { coach: PIN }); ok(r.status === 200, 'coach reset');

  console.log('STATIC');
  r = await req('GET', '/'); const html = await r.text();
  ok(/VOX STARS/.test(html) && /api\/claim/.test(html), 'index.html served & wired to auth API');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
