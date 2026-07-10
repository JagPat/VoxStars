/* ============================================================
   VOX STARS Cockpit — shared team backend (IncrediBowl S2)
   - Serves the app (public/index.html)
   - Stores shared team data as JSON on a persistent volume (/data)
   - Per-player auth: single-use invite link -> claim + PIN, or
     name + PIN. Players may only write their OWN games. Captain +
     2 VCs and a server-issued coach session carry full access.
   - Sessions expire, are revocable, and are stored hashed.
   - Writes are atomic and acknowledged only after they hit disk.
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';

const PORT      = Number(process.env.PORT ?? 3000);
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const TMP_FILE  = DATA_FILE + '.tmp';
const LEGACY_SALT = String(process.env.AUTH_SALT || 'vox-stars-dib-s2'); // only for verifying pre-migration PIN hashes

// The coach credential must be explicitly configured in production. The old
// development fallback is well known, so it is refused there too.
const INSECURE_COACH_PINS = new Set(['', '2626', '0000', '1111', '1234']);
const COACH_PIN = process.env.COACH_PIN != null ? String(process.env.COACH_PIN) : (IS_PROD ? '' : '2626');
if (IS_PROD && INSECURE_COACH_PINS.has(COACH_PIN)) {
  console.error('FATAL: COACH_PIN is missing or still a known development default.');
  console.error('Set a strong COACH_PIN environment variable before starting in production.');
  process.exit(1);
}
const USING_DEV_PIN_FALLBACK = !IS_PROD && process.env.COACH_PIN == null;

// Session lifetimes. Tests may shrink them; frozen time is test-only too.
const TEST_TTL   = IS_TEST && process.env.VOX_TEST_SESSION_TTL_MS ? Number(process.env.VOX_TEST_SESSION_TTL_MS) : null;
const PLAYER_SESSION_TTL = TEST_TTL ?? 30 * 24 * 60 * 60 * 1000; // 30 days
const COACH_SESSION_TTL  = TEST_TTL ?? 12 * 60 * 60 * 1000;      // 12 hours
const FROZEN_NOW = IS_TEST && process.env.VOX_TEST_FROZEN_NOW ? Number(process.env.VOX_TEST_FROZEN_NOW) : null;
const gameNow = () => FROZEN_NOW ?? Date.now();

const app = express();
app.set('trust proxy', true); // deployed behind the Coolify proxy
app.use(express.json({ limit: '1mb' }));
// Never let a proxy/CDN (e.g. Cloudflare) or browser cache API responses — always serve live data.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

fs.mkdirSync(DATA_DIR, { recursive: true });

const ROSTER_NOS = [149, 171, 175, 99, 31, 22, 114, 38, 137, 8, 128, 41, 49, 43, 82];
const COACH_NOS  = [149, 171, 175]; // Captain (149) + Vice-Captains (171, 175) — full access by identity

/* ---------------- crypto helpers ---------------- */
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken  = () => crypto.randomBytes(32).toString('hex');
const isCoachNo = no => COACH_NOS.includes(Number(no));
// Constant-time string compare (hash both sides to a fixed length first).
function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
// PIN storage: scrypt with a per-player random salt. Legacy sha256 hashes
// (64 hex chars) are still verified and upgraded on the next successful login.
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), SCRYPT.len, SCRYPT).toString('hex');
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt}:${h}`;
}
const LEGACY_PIN_RE = /^[0-9a-f]{64}$/;
const legacyPinHash = pin => crypto.createHash('sha256').update(String(pin) + ':' + LEGACY_SALT).digest('hex');
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return { ok: false };
  if (LEGACY_PIN_RE.test(stored)) {
    const ok = safeEq(legacyPinHash(pin), stored);
    return { ok, upgrade: ok }; // re-hash with scrypt after a successful login
  }
  const parts = stored.split(':');
  if (parts[0] === 'scrypt' && parts.length === 6) {
    const [, N, r, p, salt, h] = parts;
    let calc;
    try {
      calc = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), h.length / 2,
        { N: +N, r: +r, p: +p, maxmem: 256 * 1024 * 1024 }).toString('hex');
    } catch (e) { return { ok: false }; }
    return { ok: safeEq(calc, h) };
  }
  return { ok: false };
}

/* ---------------- rate limiting / lockouts ---------------- */
const limiter = new Map(); // key -> { count, first, lockedUntil }
function lockedFor(key) {
  const e = limiter.get(key);
  if (!e || !e.lockedUntil) return 0;
  return Math.max(0, e.lockedUntil - Date.now());
}
function recordFailure(key, max, windowMs, lockMs) {
  const t = Date.now();
  let e = limiter.get(key);
  if (!e || t - e.first > windowMs) e = { count: 0, first: t, lockedUntil: 0 };
  e.count++;
  if (e.count >= max) { e.lockedUntil = t + lockMs; e.count = 0; e.first = t; }
  limiter.set(key, e);
}
const clearFailures = key => limiter.delete(key);
function rejectLocked(res, ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  res.status(429).json({ error: `too many attempts — try again in ${mins} min` });
}
const MIN15 = 15 * 60 * 1000;
const LIMITS = {
  loginPlayer: { max: 5,  window: MIN15,     lock: MIN15 },
  loginIp:     { max: 50, window: MIN15,     lock: MIN15 },
  coachIp:     { max: 10, window: MIN15,     lock: MIN15 },
  claimIp:     { max: 20, window: 60 * 60 * 1000, lock: MIN15 },
};
setInterval(() => {
  const t = Date.now();
  for (const [k, e] of limiter) if ((e.lockedUntil || 0) < t && t - e.first > 2 * 60 * 60 * 1000) limiter.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------------- state ---------------- */
let degraded = null; // { reason, since } — set when the state file can't be trusted
function enterDegraded(reason) {
  if (degraded) return;
  degraded = { reason, since: Date.now() };
  console.error('DEGRADED MODE: ' + reason);
  console.error('The existing state file is preserved untouched. Validate a backup from ' +
    path.join(DATA_DIR, 'backups') + ' and restore it (see README "Recovering from a corrupt state file").');
}

function blankPlayer(no) {
  return { no, games: [], available: true, lockIn: false, lockOut: false, estAvg: null,
    team: null, pin: false, target: null, authPin: null, inviteToken: newToken(), claimed: false };
}
function defaultState() {
  return { players: ROSTER_NOS.map(blankPlayer),
    settings: { defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A', teamSize: 5, teamsCount: 3 },
    sessions: {}, matchday: { A: {}, B: {}, C: {} }, installId: newToken(), updatedAt: Date.now() };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// Normalise a parsed state file into the current shape. Never invents data:
// it only fills defaults, clamps ranges and assigns missing immutable game ids.
function normalize(s) {
  let changed = false;
  const byNo = new Map((s.players || []).map(p => [p.no, p]));
  const players = ROSTER_NOS.map(no => {
    const p = byNo.get(no) || {};
    const games = (Array.isArray(p.games) ? p.games : []).map(g => {
      const out = {
        id: (typeof g.id === 'string' && g.id) ? g.id : null,
        clientId: (typeof g.clientId === 'string' && g.clientId) ? g.clientId.slice(0, 64) : undefined,
        score: Math.max(0, Math.min(300, Math.round(Number(g.score) || 0))),
        strikes: Math.max(0, Math.min(12, Math.round(Number(g.strikes) || 0))),
        spares: Math.max(0, Math.min(10, Math.round(Number(g.spares) || 0))),
        date: g.date, ts: Number(g.ts) || 0,
        verified: !!g.verified, by: g.by === 'coach' ? 'coach' : 'self',
      };
      if (!out.id) { out.id = crypto.randomUUID(); changed = true; } // legacy games: mint a stable id once
      if (!validDate(out.date)) {
        out.date = out.ts ? new Date(out.ts).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        changed = true;
      }
      if (!out.ts) { out.ts = Date.parse(out.date + 'T00:00:00Z') || Date.now(); changed = true; }
      if (out.clientId === undefined) delete out.clientId;
      return out;
    });
    return { no, games, available: p.available !== false, lockIn: !!p.lockIn, lockOut: !!p.lockOut,
      estAvg: (p.estAvg ?? null), team: (['A', 'B', 'C'].includes(p.team) ? p.team : null), pin: !!p.pin,
      target: (p.target ?? null), authPin: (typeof p.authPin === 'string' ? p.authPin : null),
      inviteToken: (typeof p.inviteToken === 'string' && p.inviteToken) ? p.inviteToken
        : (p.claimed ? null : (changed = true, newToken())),
      claimed: !!p.claimed };
  });
  if ((s.players || []).length !== players.length) changed = true;
  const sessions = {};
  Object.entries(s.sessions || {}).forEach(([k, v]) => {
    // keep only current-format sessions (hashed key + expiry); legacy raw-token
    // sessions are dropped — those users sign in again with name + PIN
    if (v && typeof v.expiresAt === 'number' && /^[0-9a-f]{64}$/.test(k)) sessions[k] = v;
    else changed = true;
  });
  const matchday = s.matchday || { A: {}, B: {}, C: {} };
  ['A', 'B', 'C'].forEach(k => { matchday[k] = matchday[k] || {}; });
  return {
    changed,
    state: {
      players,
      settings: Object.assign({ defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A', teamSize: 5, teamsCount: 3 }, s.settings || {}),
      sessions, matchday,
      installId: s.installId || newToken(),
      updatedAt: Number(s.updatedAt) || Date.now(),
    },
  };
}
// First run: no file -> create a fresh state (atomically).
// Unreadable or corrupt file -> DEGRADED mode; never overwrite it.
function loadState() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      const s = defaultState();
      try { fs.writeFileSync(TMP_FILE, JSON.stringify(s)); fs.renameSync(TMP_FILE, DATA_FILE); }
      catch (err) { enterDegraded('data dir is not writable (' + err.code + ')'); return null; }
      return s;
    }
    enterDegraded('state file unreadable (' + (e.code || e.message) + ')');
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.players)) throw new Error('unexpected shape');
  } catch (e) {
    enterDegraded('state file is corrupt or has an unexpected shape — refusing to overwrite it');
    return null;
  }
  const { state: s, changed } = normalize(parsed);
  if (changed) persistState(s).catch(err => console.error('migration persist failed:', err.message));
  return s;
}

let writeChain = Promise.resolve();
function persistState(s) {
  s.updatedAt = Date.now();
  const snapshot = JSON.stringify(s);
  const run = writeChain.then(async () => {
    await fs.promises.writeFile(TMP_FILE, snapshot);
    await fs.promises.rename(TMP_FILE, DATA_FILE);
  });
  writeChain = run.catch(() => {}); // keep the chain alive; the caller sees the failure
  return run;
}
function persist() {
  if (degraded) return Promise.reject(new Error('server is in protected (degraded) mode'));
  return persistState(state);
}
// A failed write means the in-memory mutation was never acknowledged; reload the
// last durably-written state so the mutation can't be flushed later by accident.
function revertToDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.players)) throw new Error('unexpected shape');
    state = normalize(parsed).state;
  } catch (e) {
    enterDegraded('a save failed and the state file could not be re-read (' + e.message + ')');
  }
}
// Acknowledge a mutation only after the atomic write completed.
async function saveAndReply(res, payload) {
  try { await persist(); }
  catch (e) {
    console.error('persist failed:', e.message);
    revertToDisk();
    return res.status(503).json({ error: 'could not save — the change was NOT applied, try again' });
  }
  res.json(typeof payload === 'function' ? payload() : payload);
}

let state = loadState();

// Daily rotating safety backup on the persistent volume (keeps last 14).
// Skipped in degraded mode so a corrupt file can never overwrite a good backup.
function autoBackup() {
  if (degraded || !state) return;
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(DATA_FILE, path.join(dir, 'state-' + day + '.json'));
    const files = fs.readdirSync(dir).filter(f => /^state-.*\.json$/.test(f)).sort();
    while (files.length > 14) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch (_) {} }
  } catch (e) { console.error('autoBackup error:', e.message); }
}
try { autoBackup(); } catch (_) {}
setInterval(autoBackup, 24 * 60 * 60 * 1000);

/* ---------------- sessions ---------------- */
const P = no => state.players.find(p => p.no === Number(no));
// Tokens are returned to the client once and stored hashed, so a leaked
// state file or backup never contains a usable session token.
function mkSession(no, isCoach) {
  pruneSessions();
  const token = newToken();
  const ttl = (no == null && isCoach) ? COACH_SESSION_TTL : PLAYER_SESSION_TTL;
  const t = Date.now();
  state.sessions[sha256hex(token)] = { no: no == null ? null : Number(no), isCoach: !!isCoach, createdAt: t, expiresAt: t + ttl };
  return token;
}
function sessionOf(token) {
  if (!token || typeof token !== 'string') return null;
  const key = sha256hex(token);
  const s = state.sessions[key];
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { delete state.sessions[key]; return null; }
  return s;
}
function pruneSessions() {
  const t = Date.now();
  let n = 0;
  for (const k of Object.keys(state.sessions)) if (state.sessions[k].expiresAt <= t) { delete state.sessions[k]; n++; }
  return n;
}
function revokePlayerSessions(no) {
  for (const k of Object.keys(state.sessions)) if (state.sessions[k].no === Number(no)) delete state.sessions[k];
}
function revokeAllPlayerBoundSessions() {
  for (const k of Object.keys(state.sessions)) if (state.sessions[k].no != null) delete state.sessions[k];
}
setInterval(() => {
  if (degraded || !state) return;
  if (pruneSessions() > 0) persist().catch(() => {});
}, 60 * 60 * 1000).unref();

// who is making this request? returns { no, isCoach } or null
function authOf(req) {
  const s = sessionOf(req.get('x-session'));
  const cs = sessionOf(req.get('x-coach-session'));
  if (!s && !cs) return null;
  const no = s ? s.no : null;
  const isCoach = !!((s && (s.isCoach || isCoachNo(s.no))) || (cs && cs.isCoach));
  return { no, isCoach };
}
const isCoachReq = req => { const a = authOf(req); return !!a && a.isCoach; };
function gateCoach(req, res) { if (!isCoachReq(req)) { res.status(401).json({ error: 'coach access required' }); return false; } return true; }
// public identity (safe fields only)
const pub = p => ({ no: p.no, team: p.team, claimed: !!p.claimed, hasPin: !!p.authPin });

/* ---------------- degraded-mode gate ---------------- */
app.use('/api', (req, res, next) => {
  if (degraded && req.path !== '/health') {
    return res.status(503).json({ error: 'server is in protected mode: ' + degraded.reason, degraded: true });
  }
  next();
});

/* ---------------- AUTH ---------------- */
// Open an invite link -> who is this? (no secrets returned)
app.get('/api/join', (req, res) => {
  const t = String(req.query.t || '');
  const p = t && state.players.find(x => x.inviteToken && x.inviteToken === t);
  if (!p) return res.status(404).json({ error: 'invalid or already-used invite' });
  res.json({ ok: true, player: pub(p) });
});
// Claim an identity from an invite link, setting a PIN -> issues a session.
// The invite is single-use: it is consumed here and can never be replayed.
app.post('/api/claim', async (req, res) => {
  const ipKey = 'claim:' + req.ip;
  const lockMs = lockedFor(ipKey);
  if (lockMs) return rejectLocked(res, lockMs);
  const { token, pin } = req.body || {};
  const t = String(token || '');
  const p = t && state.players.find(x => x.inviteToken && x.inviteToken === t);
  if (!p) {
    recordFailure(ipKey, LIMITS.claimIp.max, LIMITS.claimIp.window, LIMITS.claimIp.lock);
    return res.status(404).json({ error: 'invalid or already-used invite' });
  }
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
  p.authPin = hashPin(pin);
  p.claimed = true;
  p.inviteToken = null;              // consume the invite — single use
  revokePlayerSessions(p.no);        // identity (re)claimed: older sessions die
  clearFailures('login:' + p.no);    // a fresh claim is the recovery path from a lockout
  const session = mkSession(p.no, isCoachNo(p.no));
  await saveAndReply(res, { ok: true, session, no: p.no, isCoach: isCoachNo(p.no) });
});
// Sign in on a new device with name (no) + PIN
app.post('/api/login', async (req, res) => {
  const { no, pin } = req.body || {};
  const pKey = 'login:' + Number(no), ipKey = 'loginip:' + req.ip;
  const lockMs = Math.max(lockedFor(pKey), lockedFor(ipKey));
  if (lockMs) return rejectLocked(res, lockMs);
  const p = P(no);
  const fail = (msg) => {
    recordFailure(pKey, LIMITS.loginPlayer.max, LIMITS.loginPlayer.window, LIMITS.loginPlayer.lock);
    recordFailure(ipKey, LIMITS.loginIp.max, LIMITS.loginIp.window, LIMITS.loginIp.lock);
    res.status(401).json({ error: msg });
  };
  if (!p || !p.authPin) return fail('no PIN yet — open your invite link first');
  const v = verifyPin(pin, p.authPin);
  if (!v.ok) return fail('wrong PIN');
  clearFailures(pKey);
  if (v.upgrade) p.authPin = hashPin(pin); // migrate legacy hash to scrypt on successful login
  const session = mkSession(p.no, isCoachNo(p.no));
  await saveAndReply(res, { ok: true, session, no: p.no, isCoach: isCoachNo(p.no) });
});
// Validate a stored session on boot
app.post('/api/session', (req, res) => {
  const s = sessionOf((req.body || {}).session);
  if (!s) return res.status(401).json({ error: 'expired' });
  res.json({ ok: true, no: s.no, isCoach: !!(s.isCoach || isCoachNo(s.no)), expiresAt: s.expiresAt });
});
// Revoke the sessions presented on this request (sign out)
app.post('/api/logout', async (req, res) => {
  [req.get('x-session'), req.get('x-coach-session'), (req.body || {}).session].forEach(t => {
    if (t && typeof t === 'string') delete state.sessions[sha256hex(t)];
  });
  await saveAndReply(res, { ok: true });
});
// Coach PIN -> issues an expiring coach session (backup unlock; rate limited).
// The raw PIN is verified once here and never stored or echoed back.
app.post('/api/coach/verify', async (req, res) => {
  const ipKey = 'coach:' + req.ip;
  const lockMs = lockedFor(ipKey);
  if (lockMs) return rejectLocked(res, lockMs);
  if (!COACH_PIN || !safeEq(String((req.body || {}).pin || ''), COACH_PIN)) {
    recordFailure(ipKey, LIMITS.coachIp.max, LIMITS.coachIp.window, LIMITS.coachIp.lock);
    return res.status(401).json({ ok: false, error: 'wrong coach PIN' });
  }
  const session = mkSession(null, true);
  await saveAndReply(res, { ok: true, session });
});
// Coach: per-player invite tokens (frontend builds the shareable link).
// token is null once the invite has been claimed (single-use).
app.get('/api/invites', (req, res) => {
  if (!gateCoach(req, res)) return;
  res.json({ ok: true, players: state.players.map(p => ({ no: p.no, token: p.inviteToken, claimed: !!p.claimed, hasPin: !!p.authPin })) });
});
// Coach-authorized invite/PIN reset: issues a fresh single-use invite, clears
// the PIN, revokes every session for that player, and clears any login lockout.
app.post('/api/invites/reset', async (req, res) => {
  if (!gateCoach(req, res)) return;
  const p = P((req.body || {}).no); if (!p) return res.status(404).json({ error: 'unknown player' });
  p.inviteToken = newToken(); p.claimed = false; p.authPin = null;
  revokePlayerSessions(p.no);
  clearFailures('login:' + p.no);
  await saveAndReply(res, () => ({ ok: true, token: p.inviteToken }));
});

/* ---------------- API ---------------- */
app.get('/api/health', (req, res) => {
  if (degraded) {
    return res.status(503).json({ ok: false, degraded: true, reason: degraded.reason,
      recovery: 'validate a backup from DATA_DIR/backups and restore it — see README' });
  }
  res.json({ ok: true, updatedAt: state.updatedAt, installId: state.installId, dataDir: DATA_DIR, onDataVolume: DATA_DIR === '/data' });
});
app.get('/api/state', (req, res) => {
  // read-only: viewing team-mates & rivals is allowed (documented policy). Strip secrets.
  res.json({ players: state.players.map(({ authPin, inviteToken, ...rest }) => rest), settings: state.settings, matchday: state.matchday, updatedAt: state.updatedAt, installId: state.installId });
});

// Coach: download a full backup snapshot (players + games + settings)
app.get('/api/backup', (req, res) => { if (!gateCoach(req, res)) return;
  res.json({ voxstars: 1, exportedAt: Date.now(), players: state.players, settings: state.settings, matchday: state.matchday }); });
// Coach: restore from a backup snapshot (brings back games, PINs, teams, targets)
app.post('/api/restore', async (req, res) => { if (!gateCoach(req, res)) return;
  const b = req.body || {};
  const err = validateBackup(b);
  if (err) return res.status(400).json({ error: 'not a valid backup: ' + err });
  const byNo = new Map(b.players.map(p => [Number(p.no), p]));
  state.players = ROSTER_NOS.map(no => {
    const bk = byNo.get(no); const cur = P(no);
    if (!bk) return cur || blankPlayer(no);
    return { no, games: (bk.games || []).map(cleanGame), available: bk.available !== false, lockIn: !!bk.lockIn, lockOut: !!bk.lockOut,
      estAvg: bk.estAvg ?? null, team: bk.team ?? null, pin: !!bk.pin, target: bk.target ?? null,
      authPin: bk.authPin ?? (cur && cur.authPin) ?? null,
      inviteToken: bk.inviteToken !== undefined ? bk.inviteToken : ((cur && cur.inviteToken) || newToken()),
      claimed: !!bk.claimed };
  });
  if (b.settings) applySettings(b.settings);
  if (b.matchday) state.matchday = cleanMatchday(b.matchday);
  // restored PINs/identities replace the live ones: player-bound sessions die
  revokeAllPlayerBoundSessions();
  await saveAndReply(res, { ok: true, restored: b.players.length });
});

// Log a game — must be signed in; a player may only log their OWN games; coach may log for anyone.
// Games get a collision-resistant immutable id; a clientId (from the offline
// outbox) makes retries idempotent: the same clientId can only create one game.
app.post('/api/games', async (req, res) => {
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, score, strikes, spares, date, clientId } = req.body || {};
  const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only log your own games' });
  const sc = Number(score);
  if (!(Number.isInteger(sc) && sc >= 0 && sc <= 300)) return res.status(400).json({ error: 'score must be a whole number 0–300' });
  if (date !== undefined && date !== null && date !== '' && !validDate(String(date))) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (clientId !== undefined && clientId !== null && !ID_RE.test(String(clientId))) return res.status(400).json({ error: 'bad clientId' });
  if (clientId) {
    const existing = p.games.find(g => g.clientId === String(clientId));
    if (existing) return res.json({ ok: true, game: existing, duplicate: true });
  }
  const game = { id: crypto.randomUUID(),
    score: sc, strikes: Math.max(0, Math.min(12, Math.round(Number(strikes) || 0))), spares: Math.max(0, Math.min(10, Math.round(Number(spares) || 0))),
    date: (date && validDate(String(date))) ? String(date) : new Date().toISOString().slice(0, 10),
    ts: gameNow(), verified: !!a.isCoach, by: a.isCoach ? 'coach' : 'self' };
  if (clientId) game.clientId = String(clientId);
  p.games.push(game);
  await saveAndReply(res, { ok: true, game });
});
app.post('/api/games/:no/:id/verify', async (req, res) => { if (!gateCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).json({ error: 'unknown player' });
  const g = p.games.find(x => String(x.id) === String(req.params.id)); if (!g) return res.status(404).json({ error: 'unknown game' });
  g.verified = !g.verified;
  await saveAndReply(res, () => ({ ok: true, verified: g.verified })); });
app.delete('/api/games/:no/:id', async (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const no = req.params.no;
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only delete your own games' });
  const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  const before = p.games.length;
  p.games = p.games.filter(x => String(x.id) !== String(req.params.id));
  await saveAndReply(res, { ok: true, removed: before - p.games.length }); });

app.put('/api/players/:no', async (req, res) => { if (!gateCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).json({ error: 'unknown player' }); const b = req.body || {};
  if (b.available !== undefined) p.available = !!b.available;
  if (b.lockIn   !== undefined) p.lockIn   = !!b.lockIn;
  if (b.lockOut  !== undefined) p.lockOut  = !!b.lockOut;
  if (b.estAvg   !== undefined) p.estAvg   = (b.estAvg === null || b.estAvg === '') ? null : Number(b.estAvg);
  if (b.team     !== undefined) p.team     = (['A', 'B', 'C'].includes(b.team)) ? b.team : null;
  if (b.pin      !== undefined) p.pin      = !!b.pin;
  if (b.target   !== undefined) p.target   = (b.target === null || b.target === '') ? null : Number(b.target);
  await saveAndReply(res, () => ({ ok: true, player: pub(p) })); });

// A player sets their OWN target (or a coach for anyone)
app.post('/api/mytarget', async (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, target } = req.body || {}; const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'not your target' });
  p.target = (target === null || target === '') ? null : Number(target);
  await saveAndReply(res, () => ({ ok: true, target: p.target }));
});

app.post('/api/teams', async (req, res) => { if (!gateCoach(req, res)) return;
  const a = (req.body && req.body.assignments) || {};
  Object.keys(a).forEach(no => { const p = P(no); if (p) p.team = ['A', 'B', 'C'].includes(a[no]) ? a[no] : null; });
  await saveAndReply(res, { ok: true }); });
function applySettings(b) {
  ['defaultAvg', 'capCr', 'teamSize', 'teamsCount'].forEach(k => {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) state.settings[k] = Number(b[k]);
  });
  if (['powerhouse', 'balanced', 'tiered'].includes(b.splitStrategy)) state.settings.splitStrategy = b.splitStrategy;
  if (['A', 'B', 'C'].includes(b.powerTeam)) state.settings.powerTeam = b.powerTeam;
}
app.put('/api/settings', async (req, res) => { if (!gateCoach(req, res)) return;
  applySettings(req.body || {});
  await saveAndReply(res, () => ({ ok: true, settings: state.settings })); });
app.post('/api/import', async (req, res) => { if (!gateCoach(req, res)) return;
  const incoming = (req.body && req.body.players) || [];
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'players must be an array' });
  for (const ip of incoming) {
    const err = validateImportPlayer(ip);
    if (err) return res.status(400).json({ error: 'not a valid import: ' + err });
  }
  let added = 0;
  incoming.forEach(ip => { const p = P(ip.no); if (!p) return; (ip.games || []).forEach(g => {
    const dup = p.games.some(x => (g.id && x.id === g.id) || (g.clientId && x.clientId === g.clientId) ||
      (x.date === g.date && x.score === g.score && x.strikes === g.strikes));
    if (!dup) { p.games.push(cleanGame(g)); added++; } }); });
  await saveAndReply(res, { ok: true, added }); });
app.post('/api/reset', async (req, res) => { if (!gateCoach(req, res)) return;
  const keepId = state.installId;
  const coachSessions = {};
  Object.entries(state.sessions).forEach(([k, s]) => { if (s.no == null && s.isCoach) coachSessions[k] = s; });
  state = defaultState(); state.installId = keepId; state.sessions = coachSessions;
  await saveAndReply(res, { ok: true }); });
// Match day: coach records each sub-team's tournament games (2 per player), kept separate from practice.
app.post('/api/matchday', async (req, res) => { if (!gateCoach(req, res)) return;
  const b = req.body || {}, team = b.team;
  if (!['A', 'B', 'C'].includes(team)) return res.status(400).json({ error: 'team must be A/B/C' });
  state.matchday[team] = state.matchday[team] || {};
  if (b.clear) { state.matchday[team] = {}; return saveAndReply(res, () => ({ ok: true, matchday: state.matchday })); }
  const no = Number(b.no), game = Number(b.game);
  if (!ROSTER_NOS.includes(no) || ![1, 2].includes(game)) return res.status(400).json({ error: 'bad no/game' });
  const score = Math.max(0, Math.min(300, parseInt(b.score, 10) || 0));
  const strikes = Math.max(0, Math.min(12, parseInt(b.strikes, 10) || 0));
  const spares = Math.max(0, Math.min(10, parseInt(b.spares, 10) || 0));
  state.matchday[team][no + '-' + game] = { score, strikes, spares };
  await saveAndReply(res, () => ({ ok: true, matchday: state.matchday }));
});

/* ---------------- backup / import validation ----------------
   Backups and imports are treated as untrusted input even though the
   endpoints are coach-only: every game must be well-formed before it is
   accepted, and only known-safe fields are copied. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE_RE = /^[0-9a-f]{16,64}$/;
const PIN_HASH_RE = /^([0-9a-f]{64}|scrypt:\d{1,8}:\d{1,3}:\d{1,3}:[0-9a-f]{16,64}:[0-9a-f]{32,128})$/;
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function gameError(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'game is not an object';
  if (!intIn(g.score, 0, 300)) return 'game score must be an integer 0–300';
  if (g.strikes !== undefined && !intIn(g.strikes, 0, 12)) return 'strikes must be an integer 0–12';
  if (g.spares !== undefined && !intIn(g.spares, 0, 10)) return 'spares must be an integer 0–10';
  if (!validDate(g.date)) return 'game date must be a valid YYYY-MM-DD';
  if (g.id !== undefined && g.id !== null && !ID_RE.test(String(g.id))) return 'bad game id';
  if (g.clientId !== undefined && g.clientId !== null && !ID_RE.test(String(g.clientId))) return 'bad game clientId';
  if (g.ts !== undefined && !(Number.isFinite(g.ts) && g.ts >= 0)) return 'bad game ts';
  if (g.verified !== undefined && typeof g.verified !== 'boolean') return 'bad verified flag';
  if (g.by !== undefined && !['coach', 'self'].includes(g.by)) return 'bad "by" field';
  return null;
}
// copy only known-safe fields; assign an immutable id when missing (legacy backups)
function cleanGame(g) {
  const out = {
    id: (g.id && ID_RE.test(String(g.id))) ? String(g.id) : crypto.randomUUID(),
    score: g.score,
    strikes: intIn(g.strikes, 0, 12) ? g.strikes : 0,
    spares: intIn(g.spares, 0, 10) ? g.spares : 0,
    date: g.date,
    ts: (Number.isFinite(g.ts) && g.ts >= 0) ? g.ts : (Date.parse(g.date + 'T00:00:00Z') || Date.now()),
    verified: g.verified === true, by: g.by === 'coach' ? 'coach' : 'self',
  };
  if (g.clientId && ID_RE.test(String(g.clientId))) out.clientId = String(g.clientId);
  return out;
}
const numOrNull = (v, min, max) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
function playerEntryError(bk, seenIds) {
  if (!bk || typeof bk !== 'object' || Array.isArray(bk)) return 'player entry is not an object';
  if (!ROSTER_NOS.includes(Number(bk.no))) return 'unknown player no ' + JSON.stringify(bk.no);
  if (bk.games !== undefined && !Array.isArray(bk.games)) return 'player ' + bk.no + ': games must be an array';
  for (const g of (bk.games || [])) {
    const err = gameError(g);
    if (err) return 'player ' + bk.no + ': ' + err;
    if (g.id != null) {
      if (seenIds.has(g.id)) return 'player ' + bk.no + ': duplicate game id ' + g.id;
      seenIds.add(g.id);
    }
  }
  if (!numOrNull(bk.estAvg, 0, 300)) return 'player ' + bk.no + ': bad estAvg';
  if (!numOrNull(bk.target, 0, 300)) return 'player ' + bk.no + ': bad target';
  if (bk.team !== undefined && bk.team !== null && !['A', 'B', 'C'].includes(bk.team)) return 'player ' + bk.no + ': bad team';
  if (bk.authPin !== undefined && bk.authPin !== null && !(typeof bk.authPin === 'string' && PIN_HASH_RE.test(bk.authPin))) return 'player ' + bk.no + ': unrecognised authPin format';
  if (bk.inviteToken !== undefined && bk.inviteToken !== null && !(typeof bk.inviteToken === 'string' && INVITE_RE.test(bk.inviteToken))) return 'player ' + bk.no + ': bad inviteToken';
  return null;
}
function validateBackup(b) {
  if (!b || typeof b !== 'object') return 'not an object';
  if (!Array.isArray(b.players)) return 'players must be an array';
  if (b.players.length > 100) return 'too many player entries';
  const seenIds = new Set();
  for (const bk of b.players) {
    const err = playerEntryError(bk, seenIds);
    if (err) return err;
  }
  if (b.matchday !== undefined) {
    const err = matchdayError(b.matchday);
    if (err) return err;
  }
  if (b.settings !== undefined && (typeof b.settings !== 'object' || b.settings === null || Array.isArray(b.settings))) return 'settings must be an object';
  return null;
}
function validateImportPlayer(ip) {
  return playerEntryError(ip, new Set());
}
function matchdayError(md) {
  if (!md || typeof md !== 'object' || Array.isArray(md)) return 'matchday must be an object';
  for (const team of Object.keys(md)) {
    if (!['A', 'B', 'C'].includes(team)) return 'matchday: bad team ' + team;
    const entries = md[team];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return 'matchday ' + team + ': must be an object';
    for (const key of Object.keys(entries)) {
      const m = /^(\d+)-(1|2)$/.exec(key);
      if (!m || !ROSTER_NOS.includes(Number(m[1]))) return 'matchday ' + team + ': bad entry key ' + key;
      const e = entries[key];
      if (!e || typeof e !== 'object' || !intIn(e.score, 0, 300) ||
          (e.strikes !== undefined && !intIn(e.strikes, 0, 12)) || (e.spares !== undefined && !intIn(e.spares, 0, 10))) {
        return 'matchday ' + team + ': bad entry ' + key;
      }
    }
  }
  return null;
}
function cleanMatchday(md) {
  const out = { A: {}, B: {}, C: {} };
  ['A', 'B', 'C'].forEach(team => {
    Object.keys(md[team] || {}).forEach(key => {
      const e = md[team][key];
      out[team][key] = { score: e.score, strikes: intIn(e.strikes, 0, 12) ? e.strikes : 0, spares: intIn(e.spares, 0, 10) ? e.spares : 0 };
    });
  });
  return out;
}

/* ---------------- static app ---------------- */
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.set('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// malformed JSON bodies -> clean 400 instead of an HTML error page
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400 || err.status === 413)) {
    return res.status(err.status || 400).json({ error: 'invalid request body' });
  }
  console.error('unhandled error:', err && err.message);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  const addr = server.address();
  console.log(`VOX STARS Cockpit running on :${addr.port}  (data: ${DATA_FILE})${degraded ? '  [DEGRADED: ' + degraded.reason + ']' : ''}`);
  if (USING_DEV_PIN_FALLBACK) console.warn('⚠︎  Using the development COACH_PIN fallback — set COACH_PIN for any shared deployment.');
});
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}));
