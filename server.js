/* ============================================================
   VOX STARS Cockpit — shared team backend (IncrediBowl S2)
   - Serves the app (public/index.html)
   - Stores shared team data as JSON on a persistent volume (/data)
   - Per-player auth: invite link -> claim + PIN, or name + PIN.
     Players may only write their OWN games. Captain + 2 VCs and the
     coach PIN carry full (coach) access.
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const COACH_PIN = String(process.env.COACH_PIN || '2626');       // OVERRIDE in Coolify env vars!
const SALT      = String(process.env.AUTH_SALT || 'vox-stars-dib-s2');

fs.mkdirSync(DATA_DIR, { recursive: true });

const ROSTER_NOS = [149, 171, 175, 99, 31, 22, 114, 38, 137, 8, 128, 41, 49, 43, 82];
const COACH_NOS  = [149, 171, 175]; // Captain (149) + Vice-Captains (171, 175) — full access by identity

const hashPin  = pin => crypto.createHash('sha256').update(String(pin) + ':' + SALT).digest('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
const isCoachNo = no => COACH_NOS.includes(Number(no));

function blankPlayer(no) {
  return { no, games: [], available: true, lockIn: false, lockOut: false, estAvg: null,
    team: null, pin: false, target: null, authPin: null, inviteToken: newToken(), claimed: false };
}
function defaultState() {
  return { players: ROSTER_NOS.map(blankPlayer),
    settings: { defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A', teamSize: 5, teamsCount: 3 },
    sessions: {}, updatedAt: Date.now() };
}

let state = loadState();
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const byNo = new Map((s.players || []).map(p => [p.no, p]));
    s.players = ROSTER_NOS.map(no => {
      const p = byNo.get(no) || {};
      return { no, games: p.games || [], available: p.available !== false, lockIn: !!p.lockIn, lockOut: !!p.lockOut,
        estAvg: (p.estAvg ?? null), team: (p.team ?? null), pin: !!p.pin, target: (p.target ?? null),
        authPin: (p.authPin ?? null), inviteToken: p.inviteToken || newToken(), claimed: !!p.claimed };
    });
    s.settings = Object.assign({ defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A', teamSize: 5, teamsCount: 3 }, s.settings || {});
    s.sessions = s.sessions || {};
    return s;
  } catch (e) {
    const s = defaultState();
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(s)); } catch (_) {}
    return s;
  }
}

let writeChain = Promise.resolve();
function persist() {
  state.updatedAt = Date.now();
  const snapshot = JSON.stringify(state);
  const tmp = DATA_FILE + '.tmp';
  writeChain = writeChain.then(() => fs.promises.writeFile(tmp, snapshot)).then(() => fs.promises.rename(tmp, DATA_FILE))
    .catch(err => console.error('persist error:', err.message));
  return writeChain;
}

const P = no => state.players.find(p => p.no === Number(no));
function mkSession(no, isCoach) { const t = newToken(); state.sessions[t] = { no: no == null ? null : Number(no), isCoach: !!isCoach, ts: Date.now() }; persist(); return t; }
// who is making this request? returns { no, isCoach } or null
function authOf(req) {
  const t = req.get('x-session');
  const s = t && state.sessions[t];
  const coachPinOk = String(req.get('x-coach-pin') || '') === COACH_PIN;
  if (!s && !coachPinOk) return null;
  const no = s ? s.no : null;
  const isCoach = (s && (s.isCoach || isCoachNo(s.no))) || coachPinOk;
  return { no, isCoach };
}
const isCoachReq = req => { const a = authOf(req); return !!a && a.isCoach; };
function gateCoach(req, res) { if (!isCoachReq(req)) { res.status(401).json({ error: 'coach access required' }); return false; } return true; }
// public identity (safe fields only)
const pub = p => ({ no: p.no, team: p.team, claimed: !!p.claimed, hasPin: !!p.authPin });

/* ---------------- AUTH ---------------- */
// Open an invite link -> who is this? (no secrets returned)
app.get('/api/join', (req, res) => {
  const p = state.players.find(x => x.inviteToken === String(req.query.t || ''));
  if (!p) return res.status(404).json({ error: 'invalid or expired invite' });
  res.json({ ok: true, player: pub(p) });
});
// Claim an identity from an invite link, optionally setting a PIN -> issues a session
app.post('/api/claim', (req, res) => {
  const { token, pin } = req.body || {};
  const p = state.players.find(x => x.inviteToken === String(token || ''));
  if (!p) return res.status(404).json({ error: 'invalid invite' });
  if (pin != null && String(pin) !== '') {
    if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4 digits' });
    p.authPin = hashPin(pin);
  }
  p.claimed = true;
  const s = mkSession(p.no, isCoachNo(p.no));
  res.json({ ok: true, session: s, no: p.no, isCoach: isCoachNo(p.no) });
});
// Sign in on a new device with name (no) + PIN
app.post('/api/login', (req, res) => {
  const { no, pin } = req.body || {};
  const p = P(no);
  if (!p || !p.authPin) return res.status(401).json({ error: 'no PIN yet — open your invite link first' });
  if (hashPin(pin) !== p.authPin) return res.status(401).json({ error: 'wrong PIN' });
  const s = mkSession(p.no, isCoachNo(p.no));
  res.json({ ok: true, session: s, no: p.no, isCoach: isCoachNo(p.no) });
});
// Validate a stored session on boot
app.post('/api/session', (req, res) => {
  const s = state.sessions[(req.body || {}).session];
  if (!s) return res.status(401).json({ error: 'expired' });
  res.json({ ok: true, no: s.no, isCoach: s.isCoach || isCoachNo(s.no) });
});
// Coach PIN -> issues a coach session (also usable as a backup unlock)
app.post('/api/coach/verify', (req, res) => {
  if (String((req.body || {}).pin || '') !== COACH_PIN) return res.json({ ok: false });
  res.json({ ok: true, session: mkSession(null, true) });
});
// Coach: per-player invite tokens (frontend builds the shareable link)
app.get('/api/invites', (req, res) => {
  if (!gateCoach(req, res)) return;
  res.json({ ok: true, players: state.players.map(p => ({ no: p.no, token: p.inviteToken, claimed: !!p.claimed, hasPin: !!p.authPin })) });
});
app.post('/api/invites/regen', (req, res) => {
  if (!gateCoach(req, res)) return;
  const p = P((req.body || {}).no); if (!p) return res.status(404).end();
  p.inviteToken = newToken(); p.claimed = false; p.authPin = null; persist();
  res.json({ ok: true, token: p.inviteToken });
});

/* ---------------- API ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, updatedAt: state.updatedAt }));
app.get('/api/state', (req, res) => {
  // read-only: viewing team-mates & rivals is allowed. Strip secrets.
  res.json({ players: state.players.map(({ authPin, inviteToken, ...rest }) => rest), settings: state.settings, updatedAt: state.updatedAt });
});

// Log a game — must be signed in; a player may only log their OWN games; coach may log for anyone
app.post('/api/games', (req, res) => {
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, score, strikes, spares, date } = req.body || {};
  const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only log your own games' });
  const sc = Number(score);
  if (!(sc >= 0 && sc <= 300)) return res.status(400).json({ error: 'score must be 0–300' });
  const game = { score: sc, strikes: Math.max(0, Math.min(12, Number(strikes) || 0)), spares: Math.max(0, Math.min(10, Number(spares) || 0)),
    date: (String(date || '').slice(0, 10)) || new Date().toISOString().slice(0, 10), ts: Date.now(), verified: !!a.isCoach, by: a.isCoach ? 'coach' : 'self' };
  p.games.push(game); persist();
  res.json({ ok: true, game });
});
app.post('/api/games/:no/:ts/verify', (req, res) => { if (!gateCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).end();
  const g = p.games.find(x => String(x.ts) === String(req.params.ts)); if (!g) return res.status(404).end();
  g.verified = !g.verified; persist(); res.json({ ok: true, verified: g.verified }); });
app.delete('/api/games/:no/:ts', (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const no = req.params.no;
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only delete your own games' });
  const p = P(no); if (!p) return res.status(404).end();
  const before = p.games.length; p.games = p.games.filter(x => String(x.ts) !== String(req.params.ts));
  persist(); res.json({ ok: true, removed: before - p.games.length }); });

app.put('/api/players/:no', (req, res) => { if (!gateCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).end(); const b = req.body || {};
  if (b.available !== undefined) p.available = !!b.available;
  if (b.lockIn   !== undefined) p.lockIn   = !!b.lockIn;
  if (b.lockOut  !== undefined) p.lockOut  = !!b.lockOut;
  if (b.estAvg   !== undefined) p.estAvg   = (b.estAvg === null || b.estAvg === '') ? null : Number(b.estAvg);
  if (b.team     !== undefined) p.team     = (['A','B','C'].includes(b.team)) ? b.team : null;
  if (b.pin      !== undefined) p.pin      = !!b.pin;
  if (b.target   !== undefined) p.target   = (b.target === null || b.target === '') ? null : Number(b.target);
  persist(); res.json({ ok: true, player: pub(p) }); });

// A player sets their OWN target (or a coach for anyone)
app.post('/api/mytarget', (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, target } = req.body || {}; const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'not your target' });
  p.target = (target === null || target === '') ? null : Number(target); persist();
  res.json({ ok: true, target: p.target });
});

app.post('/api/teams', (req, res) => { if (!gateCoach(req, res)) return;
  const a = (req.body && req.body.assignments) || {};
  Object.keys(a).forEach(no => { const p = P(no); if (p) p.team = ['A','B','C'].includes(a[no]) ? a[no] : null; });
  persist(); res.json({ ok: true }); });
app.put('/api/settings', (req, res) => { if (!gateCoach(req, res)) return; const b = req.body || {};
  ['defaultAvg', 'capCr', 'teamSize', 'teamsCount'].forEach(k => { if (b[k] !== undefined) state.settings[k] = Number(b[k]); });
  if (['powerhouse','balanced','tiered'].includes(b.splitStrategy)) state.settings.splitStrategy = b.splitStrategy;
  if (['A','B','C'].includes(b.powerTeam)) state.settings.powerTeam = b.powerTeam;
  persist(); res.json({ ok: true, settings: state.settings }); });
app.post('/api/import', (req, res) => { if (!gateCoach(req, res)) return;
  const incoming = (req.body && req.body.players) || []; let added = 0;
  incoming.forEach(ip => { const p = P(ip.no); if (!p) return; (ip.games || []).forEach(g => {
    const dup = p.games.some(x => x.ts === g.ts || (x.date === g.date && x.score === g.score && x.strikes === g.strikes));
    if (!dup) { p.games.push(g); added++; } }); });
  persist(); res.json({ ok: true, added }); });
app.post('/api/reset', (req, res) => { if (!gateCoach(req, res)) return; state = defaultState(); persist(); res.json({ ok: true }); });

/* ---------------- static app ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`VOX STARS Cockpit running on :${PORT}  (data: ${DATA_FILE})`);
  if (COACH_PIN === '2626') console.warn('⚠︎  Using default COACH_PIN — set COACH_PIN in Coolify env vars.');
});
