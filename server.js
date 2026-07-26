/* ============================================================
   VOX STARS Cockpit — shared team backend (IncrediBowl S2)
   - Serves the app (public/index.html)
   - Stores shared team data as JSON on a persistent volume (/data)
   - Per-player auth: single-use invite link -> claim + PIN, or
     name + PIN. Players may only write their OWN games. Captain +
     2 VCs and a server-issued coach session carry full access.
   - Sessions expire, are revocable, and are stored hashed.
   - Every mutation runs through a single serialized commit() that
     writes atomically (with fsync) and is acknowledged only after it
     hits disk; a failed write reverts the in-memory mutation.
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { teamSplitError } = require('./public/app-core');
const { ROSTER, LEADS: TEAM_LEADS } = require('./public/roster');
const { OPTIMIZER_VERSION, evaluateRoster } = require('./lib/optimizer');

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';

const PORT      = Number(process.env.PORT ?? 3000);
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const TMP_FILE  = DATA_FILE + '.tmp';
const LEGACY_SALT = String(process.env.AUTH_SALT || 'vox-stars-dib-s2'); // only for verifying pre-migration PIN hashes

// The coach credential must be explicitly configured in production. The old
// development fallback is well known, so it is refused there too, and a
// production credential must have some minimum strength.
const INSECURE_COACH_PINS = new Set(['', '2626', '0000', '1111', '1234', '123456', '000000']);
const MIN_PROD_COACH_PIN = 6;
const COACH_PIN = process.env.COACH_PIN != null ? String(process.env.COACH_PIN) : (IS_PROD ? '' : '2626');
if (IS_PROD) {
  if (INSECURE_COACH_PINS.has(COACH_PIN)) {
    console.error('FATAL: COACH_PIN is missing or still a known development default.');
    console.error('Set a strong COACH_PIN environment variable before starting in production.');
    process.exit(1);
  }
  if (COACH_PIN.length < MIN_PROD_COACH_PIN) {
    console.error(`FATAL: COACH_PIN is too weak — use at least ${MIN_PROD_COACH_PIN} characters in production.`);
    process.exit(1);
  }
}
const USING_DEV_PIN_FALLBACK = !IS_PROD && process.env.COACH_PIN == null;

// Session lifetimes. Tests may shrink them; frozen time is test-only too.
const TEST_TTL   = IS_TEST && process.env.VOX_TEST_SESSION_TTL_MS ? Number(process.env.VOX_TEST_SESSION_TTL_MS) : null;
const PLAYER_SESSION_TTL = TEST_TTL ?? 30 * 24 * 60 * 60 * 1000; // 30 days
const COACH_SESSION_TTL  = TEST_TTL ?? 12 * 60 * 60 * 1000;      // 12 hours
const FROZEN_NOW = IS_TEST && process.env.VOX_TEST_FROZEN_NOW ? Number(process.env.VOX_TEST_FROZEN_NOW) : null;
const gameNow = () => FROZEN_NOW ?? Date.now();

const app = express();
// Trust only a bounded number of proxy hops so clients cannot forge req.ip via
// X-Forwarded-For and bypass the rate limiters. Coolify puts one proxy in front.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY)
  : (IS_PROD ? 1 : 'loopback');
app.set('trust proxy', TRUST_PROXY);
app.use(express.json({ limit: '1mb' }));
// Never let a proxy/CDN (e.g. Cloudflare) or browser cache API responses — always serve live data.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

fs.mkdirSync(DATA_DIR, { recursive: true });

const ROSTER_NOS = ROSTER.map(p => p.no);
const COACH_NOS  = [149, 171, 175]; // Captain (149) + Vice-Captains (171, 175) — full access by identity
const ROSTER_INFO = ROSTER.map(({ no, g, pt }) => ({ no, g, pt }));

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
// Clear every lockout for a player (per-IP keys included) — the recovery path.
function clearLoginFailures(no) {
  const pre = 'login:' + Number(no);
  for (const k of [...limiter.keys()]) if (k === pre || k.startsWith(pre + ':')) limiter.delete(k);
}
function rejectLocked(res, ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  res.status(429).json({ error: `too many attempts — try again in ${mins} min` });
}
const MIN15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LIMITS = {
  loginAcctIp: { max: 5,  window: MIN15, lock: MIN15 }, // wrong PINs from one IP for one account
  loginIp:     { max: 50, window: MIN15, lock: MIN15 }, // flood protection per IP
  coachIp:     { max: 10, window: MIN15, lock: MIN15 },
  coachGlobal: { max: 30, window: MIN15, lock: MIN15 }, // backstop against distributed coach-PIN guessing
  claimIp:     { max: 20, window: HOUR,  lock: MIN15 },
};
setInterval(() => {
  const t = Date.now();
  for (const [k, e] of limiter) if ((e.lockedUntil || 0) < t && t - e.first > 2 * HOUR) limiter.delete(k);
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
  return { no, games: [], available: true, estAvg: null,
    team: null, pin: false, target: null, authPin: null, inviteToken: newToken(), claimed: false };
}
function defaultState() {
  return { players: ROSTER_NOS.map(blankPlayer),
    settings: { defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A' },
    sessions: {}, matchday: { A: {}, B: {}, C: {} }, teamSubmission: null, teamSubmissionAudit: [],
    installId: newToken(), updatedAt: Date.now() };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const clearValue = v => v === null || v === '';
const validTarget = v => clearValue(v) || intIn(v, 0, 300);
const validEstimate = v => clearValue(v) ||
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 300);
function cleanSubmission(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.submittedAt) ||
      !Number.isFinite(value.assignmentVersion)) return null;
  const out = { submittedAt: value.submittedAt, submittedBy: value.submittedBy ?? 'coach',
    assignmentVersion: value.assignmentVersion };
  if (Number.isFinite(value.unlockedAt)) out.unlockedAt = value.unlockedAt;
  if (value.unlockedBy !== undefined) out.unlockedBy = value.unlockedBy;
  if (typeof value.unlockReason === 'string') out.unlockReason = value.unlockReason.slice(0, 160);
  return out;
}
function cleanAudit(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.submittedAt) ||
      !Number.isFinite(value.unlockedAt) || typeof value.reason !== 'string' ||
      value.reason.length < 5 || value.reason.length > 160 || !value.priorAssignments ||
      Object.values(value.priorAssignments).some(team => !['A', 'B', 'C'].includes(team))) return null;
  return { submittedAt: value.submittedAt, unlockedAt: value.unlockedAt,
    unlockedBy: value.unlockedBy ?? 'coach', reason: value.reason,
    priorAssignments: Object.fromEntries(Object.entries(value.priorAssignments).map(([no, team]) => [Number(no), team])) };
}
const isSubmissionLocked = submission => !!(submission && submission.submittedAt &&
  !(Number(submission.unlockedAt) > Number(submission.submittedAt)));
// Deterministic id for a legacy (pre-id) game so it stays stable across restarts
// even if the migration write hasn't landed yet.
function legacyGameId(no, g, idx) {
  return 'g-' + sha256hex(no + ':' + (g.ts || 0) + ':' + g.score + ':' + (g.date || '') + ':' + idx).slice(0, 24);
}
// Normalise a parsed state file into the current shape. Never invents data:
// it only fills defaults, clamps ranges and assigns missing immutable game ids.
// Throws on structurally-broken input (caller treats that as corrupt).
function normalize(s) {
  let changed = false;
  if (!s || typeof s !== 'object' || !Array.isArray(s.players)) throw new Error('missing players array');
  // structural anomalies (null/non-object entries) mean the file is not trustworthy —
  // throw so the caller preserves it and degrades rather than silently rewriting it
  for (const p of s.players) if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('player entry is not an object');
  const byNo = new Map(s.players.map(p => [p.no, p]));
  const players = ROSTER_NOS.map(no => {
    const p = byNo.get(no) || {};
    if (p.games !== undefined && !Array.isArray(p.games)) throw new Error('player ' + no + ' games is not an array');
    const rawGames = Array.isArray(p.games) ? p.games : [];
    for (const g of rawGames) if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('player ' + no + ' has a non-object game');
    const games = rawGames.map((g, idx) => {
      const out = {
        id: (typeof g.id === 'string' && g.id) ? g.id : null,
        clientId: (typeof g.clientId === 'string' && g.clientId) ? g.clientId.slice(0, 64) : undefined,
        score: Math.max(0, Math.min(300, Math.round(Number(g.score) || 0))),
        strikes: Math.max(0, Math.min(12, Math.round(Number(g.strikes) || 0))),
        spares: Math.max(0, Math.min(10, Math.round(Number(g.spares) || 0))),
        strikesRecorded: g.strikesRecorded === true,
        sparesRecorded: g.sparesRecorded === true,
        optimizerIncluded: g.optimizerIncluded !== false,
        optimizerExclusionReason: g.optimizerIncluded === false && typeof g.optimizerExclusionReason === 'string'
          ? g.optimizerExclusionReason.slice(0, 160) : null,
        date: g.date, ts: Number(g.ts) || 0,
        verified: !!g.verified, by: g.by === 'coach' ? 'coach' : 'self',
      };
      if (g.strikesRecorded === undefined || g.sparesRecorded === undefined || g.optimizerIncluded === undefined) changed = true;
      if (!out.id) { out.id = legacyGameId(no, out, idx); changed = true; } // legacy games: stable id
      if (!validDate(out.date)) {
        out.date = out.ts ? new Date(out.ts).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        changed = true;
      }
      if (!out.ts) { out.ts = Date.parse(out.date + 'T00:00:00Z') || Date.now(); changed = true; }
      if (out.clientId === undefined) delete out.clientId;
      return out;
    });
    // invites are single-use: a claimed player never keeps a live token
    let inviteToken;
    if (p.claimed) { if (p.inviteToken) changed = true; inviteToken = null; }
    else if (typeof p.inviteToken === 'string' && p.inviteToken) inviteToken = p.inviteToken;
    else { changed = true; inviteToken = newToken(); }
    return { no, games, available: p.available !== false,
      estAvg: (p.estAvg ?? null), team: (['A', 'B', 'C'].includes(p.team) ? p.team : null), pin: !!p.pin,
      target: (p.target ?? null), authPin: (typeof p.authPin === 'string' ? p.authPin : null),
      inviteToken, claimed: !!p.claimed };
  });
  if (s.players.length !== players.length) changed = true;
  const sessions = {};
  Object.entries(s.sessions || {}).forEach(([k, v]) => {
    // keep only current-format sessions (hashed key + expiry); legacy raw-token
    // sessions are dropped — those users sign in again with name + PIN
    if (v && typeof v.expiresAt === 'number' && /^[0-9a-f]{64}$/.test(k)) sessions[k] = v;
    else changed = true;
  });
  const matchday = (s.matchday && typeof s.matchday === 'object') ? s.matchday : { A: {}, B: {}, C: {} };
  ['A', 'B', 'C'].forEach(k => { if (!matchday[k] || typeof matchday[k] !== 'object') matchday[k] = {}; });
  const teamSubmission = s.teamSubmission == null ? null : cleanSubmission(s.teamSubmission);
  if (s.teamSubmission !== undefined && s.teamSubmission !== null && !teamSubmission) changed = true;
  const teamSubmissionAudit = Array.isArray(s.teamSubmissionAudit) ? s.teamSubmissionAudit.map(cleanAudit).filter(Boolean).slice(-100) : [];
  if (!Array.isArray(s.teamSubmissionAudit) || teamSubmissionAudit.length !== s.teamSubmissionAudit.length) changed = true;
  return {
    changed,
    state: {
      players,
      settings: Object.assign({ defaultAvg: 100, capCr: 25, splitStrategy: 'powerhouse', powerTeam: 'A' }, (s.settings && typeof s.settings === 'object') ? s.settings : {}),
      sessions, matchday, teamSubmission, teamSubmissionAudit,
      installId: (typeof s.installId === 'string' && s.installId) ? s.installId : newToken(),
      updatedAt: Number(s.updatedAt) || Date.now(),
    },
  };
}
// First run: no file -> create a fresh state (atomically).
// Unreadable, corrupt, or structurally-broken file -> DEGRADED; never overwrite it.
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
  try { parsed = JSON.parse(raw); }
  catch (e) { enterDegraded('state file is not valid JSON — refusing to overwrite it'); return null; }
  let normalized;
  try { normalized = normalize(parsed); }
  catch (e) { enterDegraded('state file has an unexpected/corrupt shape (' + e.message + ') — refusing to overwrite it'); return null; }
  if (normalized.changed) {
    // migrate on disk; deterministic ids mean a failed write still yields the
    // same ids next boot, so we never serve unstable identifiers.
    enqueueWrite(JSON.stringify(normalized.state))
      .catch(err => console.error('migration persist failed (will retry on next write):', err.message));
  }
  return normalized.state;
}

// Atomic durable write: tmp file -> fsync -> rename -> fsync(dir).
async function writeFileAtomic(snapshot) {
  const fh = await fs.promises.open(TMP_FILE, 'w');
  try { await fh.writeFile(snapshot); await fh.sync(); } finally { await fh.close(); }
  await fs.promises.rename(TMP_FILE, DATA_FILE);
  try { const dh = await fs.promises.open(DATA_DIR, 'r'); try { await dh.sync(); } finally { await dh.close(); } }
  catch (_) { /* some filesystems reject directory fsync; the rename is still atomic */ }
}
// All disk writes (the startup migration write and every commit) go through
// this one queue so they never overlap on the shared temp file.
let writeChain = Promise.resolve();
function enqueueWrite(snapshot) {
  const run = writeChain.then(() => writeFileAtomic(snapshot));
  writeChain = run.then(() => {}, () => {});
  return run;
}

let state = loadState();

// A failed write means the in-memory mutation was never acknowledged; reload the
// last durably-written state so it can't be flushed later by accident.
function revertToDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = normalize(parsed).state;
  } catch (e) {
    enterDegraded('a save failed and the state file could not be re-read (' + e.message + ')');
  }
}

// Single serialized mutation pipeline. `apply` mutates `state` and returns a
// value; it runs only after the previous mutation's write fully settled, so no
// two uncommitted mutations ever share state. On write failure the mutation is
// reverted out of memory before the next one runs.
// IMPORTANT: revertToDisk() replaces `state` with fresh objects, so `apply`
// closures must re-fetch players/games from the CURRENT state (via P()) rather
// than close over references captured before commit() ran.
let commitChain = Promise.resolve();
function commit(apply) {
  const run = commitChain.then(async () => {
    if (degraded) { const e = new Error('server is in protected (degraded) mode'); e.degraded = true; throw e; }
    const result = apply();
    state.updatedAt = Math.max(Date.now(), Number(state.updatedAt || 0) + 1);
    const snapshot = JSON.stringify(state);
    try { await enqueueWrite(snapshot); }
    catch (e) { revertToDisk(); const err = new Error('persist failed: ' + e.message); err.persistFailed = true; throw err; }
    return result;
  });
  commitChain = run.then(() => {}, () => {}); // keep the chain alive regardless of outcome
  return run;
}
// Run a mutation and reply only after it is durably on disk.
async function saveAndReply(res, apply, payload) {
  let result;
  try { result = await commit(apply); }
  catch (e) {
    if (e.degraded) return res.status(503).json({ error: 'server is in protected mode', degraded: true });
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message }); // apply chose to reject (no write happened)
    console.error('persist failed:', e.message);
    return res.status(503).json({ error: 'could not save — the change was NOT applied, try again' });
  }
  res.json(typeof payload === 'function' ? payload(result) : payload);
}

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
setInterval(autoBackup, 24 * HOUR);

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
  if (s.expiresAt <= Date.now()) return null; // expired: rejected (pruned lazily by the interval/commit)
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
function clearStaleMatchdayEntries(no, assignedTeam) {
  for (const team of ['A', 'B', 'C']) {
    if (team === assignedTeam) continue;
    delete state.matchday[team][no + '-1'];
    delete state.matchday[team][no + '-2'];
  }
}
setInterval(() => {
  if (degraded || !state) return;
  let any = false;
  for (const k of Object.keys(state.sessions)) if (state.sessions[k].expiresAt <= Date.now()) { any = true; break; }
  if (any) commit(() => pruneSessions()).catch(() => {});
}, HOUR).unref();

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
  const no = p.no;
  await saveAndReply(res, () => {
    const cur = state.players.find(x => x.inviteToken && x.inviteToken === t); // re-fetch after any revert
    if (!cur) { const e = new Error('invalid or already-used invite'); e.httpStatus = 404; throw e; } // raced claim
    cur.authPin = hashPin(pin);
    cur.claimed = true;
    cur.inviteToken = null;              // consume the invite — single use
    revokePlayerSessions(cur.no);        // identity (re)claimed: older sessions die
    clearLoginFailures(cur.no);          // a fresh claim is the recovery path from a lockout
    return { session: mkSession(cur.no, isCoachNo(cur.no)) };
  }, r => ({ ok: true, session: r.session, no, isCoach: isCoachNo(no) }));
});
// Sign in on a new device with name (no) + PIN.
// Throttling never denies the correct PIN — only repeated wrong guesses from an
// IP are locked, so no one can lock a player out by guessing.
app.post('/api/login', async (req, res) => {
  const { no, pin } = req.body || {};
  const acctIpKey = 'login:' + Number(no) + ':' + req.ip, ipKey = 'loginip:' + req.ip;
  const lockMs = Math.max(lockedFor(acctIpKey), lockedFor(ipKey));
  if (lockMs) return rejectLocked(res, lockMs);
  const p = P(no);
  const fail = (msg) => {
    recordFailure(acctIpKey, LIMITS.loginAcctIp.max, LIMITS.loginAcctIp.window, LIMITS.loginAcctIp.lock);
    recordFailure(ipKey, LIMITS.loginIp.max, LIMITS.loginIp.window, LIMITS.loginIp.lock);
    res.status(401).json({ error: msg });
  };
  if (!p || !p.authPin) return fail('no PIN yet — open your invite link first');
  const v = verifyPin(pin, p.authPin);
  if (!v.ok) return fail('wrong PIN');
  clearFailures(acctIpKey);
  const no2 = p.no;
  await saveAndReply(res, () => {
    const cur = P(no2); // re-fetch after any revert
    if (v.upgrade && cur) cur.authPin = hashPin(pin); // migrate legacy hash to scrypt on successful login
    return { session: mkSession(no2, isCoachNo(no2)) };
  }, r => ({ ok: true, session: r.session, no: no2, isCoach: isCoachNo(no2) }));
});
// Validate a stored session on boot
app.post('/api/session', (req, res) => {
  const s = sessionOf((req.body || {}).session);
  if (!s) return res.status(401).json({ error: 'expired' });
  res.json({ ok: true, no: s.no, isCoach: !!(s.isCoach || isCoachNo(s.no)), expiresAt: s.expiresAt });
});
// Revoke the sessions presented on this request (sign out)
app.post('/api/logout', async (req, res) => {
  const tokens = [req.get('x-session'), req.get('x-coach-session'), (req.body || {}).session];
  await saveAndReply(res, () => {
    tokens.forEach(t => { if (t && typeof t === 'string') delete state.sessions[sha256hex(t)]; });
  }, { ok: true });
});
// Coach PIN -> issues an expiring coach session (backup unlock; rate limited).
// The raw PIN is verified once here and never stored or echoed back.
app.post('/api/coach/verify', async (req, res) => {
  const ipKey = 'coach:' + req.ip;
  const lockMs = Math.max(lockedFor(ipKey), lockedFor('coachglobal'));
  if (lockMs) return rejectLocked(res, lockMs);
  if (!COACH_PIN || !safeEq(String((req.body || {}).pin || ''), COACH_PIN)) {
    recordFailure(ipKey, LIMITS.coachIp.max, LIMITS.coachIp.window, LIMITS.coachIp.lock);
    recordFailure('coachglobal', LIMITS.coachGlobal.max, LIMITS.coachGlobal.window, LIMITS.coachGlobal.lock);
    return res.status(401).json({ ok: false, error: 'wrong coach PIN' });
  }
  clearFailures(ipKey);
  await saveAndReply(res, () => ({ session: mkSession(null, true) }), r => ({ ok: true, session: r.session }));
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
  const no = Number((req.body || {}).no); if (!P(no)) return res.status(404).json({ error: 'unknown player' });
  await saveAndReply(res, () => {
    const cur = P(no); if (!cur) { const e = new Error('unknown player'); e.httpStatus = 404; throw e; }
    cur.inviteToken = newToken(); cur.claimed = false; cur.authPin = null;
    revokePlayerSessions(no);
    clearLoginFailures(no);
    return { token: cur.inviteToken };
  }, r => ({ ok: true, token: r.token }));
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
  // Requires any valid player or coach session: signed-in team-mates see the
  // whole squad; the public / logged-out cannot read scores. Secrets stripped.
  const auth = authOf(req);
  if (!auth) return res.status(401).json({ error: 'sign in to view team data' });
  const safePlayers = state.players.map(({ authPin, inviteToken, ...rest }) => {
    if (auth.isCoach) return rest;
    return { ...rest, games: rest.games.map(({ optimizerIncluded, optimizerExclusionReason, ...game }) => game) };
  });
  const submission = state.teamSubmission && { submittedAt: state.teamSubmission.submittedAt,
    assignmentVersion: state.teamSubmission.assignmentVersion, locked: isSubmissionLocked(state.teamSubmission) };
  const coachOnly = auth.isCoach ? { teamSubmissionAudit: state.teamSubmissionAudit } : {};
  res.json({ players: safePlayers, settings: state.settings, matchday: state.matchday,
    teamSubmission: submission, ...coachOnly, updatedAt: state.updatedAt, installId: state.installId });
});

// Coach: download a full backup snapshot (players + games + settings)
app.get('/api/backup', (req, res) => { if (!gateCoach(req, res)) return;
  res.json({ voxstars: 1, exportedAt: Date.now(), players: state.players, settings: state.settings,
    matchday: state.matchday, teamSubmission: state.teamSubmission, teamSubmissionAudit: state.teamSubmissionAudit }); });
// Coach: restore from a backup snapshot (brings back games, PINs, teams, targets)
app.post('/api/restore', async (req, res) => { if (!gateCoach(req, res)) return;
  const b = req.body || {};
  const err = validateBackup(b);
  if (err) return res.status(400).json({ error: 'not a valid backup: ' + err });
  await saveAndReply(res, () => {
    const byNo = new Map(b.players.map(p => [Number(p.no), p]));
    state.players = ROSTER_NOS.map(no => {
      const bk = byNo.get(no); const cur = P(no);
      if (!bk) return cur || blankPlayer(no);
      return { no, games: (bk.games || []).map((g, i) => cleanGame(g, no, i)), available: bk.available !== false,
        estAvg: bk.estAvg ?? null, team: bk.team ?? null, pin: !!bk.pin, target: bk.target ?? null,
        authPin: bk.authPin ?? (cur && cur.authPin) ?? null,
        // single-use invites: never resurrect a token for an already-claimed player
        inviteToken: bk.claimed ? null : (bk.inviteToken !== undefined ? bk.inviteToken : ((cur && cur.inviteToken) || newToken())),
        claimed: !!bk.claimed };
    });
    if (b.settings) applySettings(b.settings);
    if (b.matchday) state.matchday = cleanMatchday(b.matchday);
    state.teamSubmission = b.teamSubmission ? cleanSubmission(b.teamSubmission) : null;
    state.teamSubmissionAudit = Array.isArray(b.teamSubmissionAudit) ? b.teamSubmissionAudit.map(cleanAudit).filter(Boolean).slice(-100) : [];
    revokeAllPlayerBoundSessions(); // restored PINs/identities replace live ones
  }, { ok: true, restored: b.players.length });
});

// Log a game — must be signed in; a player may only log their OWN games; coach may log for anyone.
// Games get a collision-resistant immutable id; a clientId (from the offline
// outbox) makes retries idempotent: the same clientId can only create one game.
app.post('/api/games', async (req, res) => {
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, score, strikes, spares, strikesRecorded, sparesRecorded, date, clientId } = req.body || {};
  const p = P(no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only log your own games' });
  const sc = Number(score);
  if (!(Number.isInteger(sc) && sc >= 0 && sc <= 300)) return res.status(400).json({ error: 'score must be a whole number 0–300' });
  if (date !== undefined && date !== null && date !== '' && !validDate(String(date))) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (clientId !== undefined && clientId !== null && !ID_RE.test(String(clientId))) return res.status(400).json({ error: 'bad clientId' });
  if (strikesRecorded !== undefined && typeof strikesRecorded !== 'boolean') return res.status(400).json({ error: 'strikesRecorded must be boolean' });
  if (sparesRecorded !== undefined && typeof sparesRecorded !== 'boolean') return res.status(400).json({ error: 'sparesRecorded must be boolean' });
  const isCoachWrite = a.isCoach;
  await saveAndReply(res, () => {
    const cur = P(no); if (!cur) { const e = new Error('unknown player'); e.httpStatus = 404; throw e; } // re-fetch after any revert
    if (clientId) {
      const existing = cur.games.find(g => g.clientId === String(clientId));
      if (existing) return { game: existing, duplicate: true };
    }
    const game = { id: crypto.randomUUID(),
      score: sc, strikes: Math.max(0, Math.min(12, Math.round(Number(strikes) || 0))), spares: Math.max(0, Math.min(10, Math.round(Number(spares) || 0))),
      strikesRecorded: strikesRecorded === true, sparesRecorded: sparesRecorded === true,
      optimizerIncluded: true, optimizerExclusionReason: null,
      date: (date && validDate(String(date))) ? String(date) : new Date().toISOString().slice(0, 10),
      ts: gameNow(), verified: !!isCoachWrite, by: isCoachWrite ? 'coach' : 'self' };
    if (clientId) game.clientId = String(clientId);
    cur.games.push(game);
    return { game };
  }, r => (r.duplicate ? { ok: true, game: r.game, duplicate: true } : { ok: true, game: r.game }));
});
app.post('/api/games/:no/:id/verify', async (req, res) => { if (!gateCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!p.games.some(x => String(x.id) === String(req.params.id))) return res.status(404).json({ error: 'unknown game' });
  let flipped;
  await saveAndReply(res, () => {
    const cur = P(req.params.no); const g = cur && cur.games.find(x => String(x.id) === String(req.params.id));
    if (!g) { const e = new Error('unknown game'); e.httpStatus = 404; throw e; }
    g.verified = !g.verified; flipped = g.verified;
  }, () => ({ ok: true, verified: flipped })); });
app.put('/api/games/:no/:id/optimizer-status', async (req, res) => {
  if (!gateCoach(req, res)) return;
  const included = (req.body || {}).included;
  const reason = String((req.body || {}).reason || '').trim();
  if (typeof included !== 'boolean' || reason.length > 160) {
    return res.status(400).json({ error: 'included must be boolean and reason at most 160 characters' });
  }
  await saveAndReply(res, () => {
    const p = P(req.params.no);
    const game = p && p.games.find(g => String(g.id) === String(req.params.id));
    if (!game) { const e = new Error('unknown game'); e.httpStatus = 404; throw e; }
    game.optimizerIncluded = included;
    game.optimizerExclusionReason = included ? null : (reason || null);
    return game;
  }, game => ({ ok: true, game }));
});
app.delete('/api/games/:no/:id', async (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const no = req.params.no;
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'you can only delete your own games' });
  if (!P(no)) return res.status(404).json({ error: 'unknown player' });
  await saveAndReply(res, () => {
    const cur = P(no); if (!cur) { const e = new Error('unknown player'); e.httpStatus = 404; throw e; }
    const before = cur.games.length;
    cur.games = cur.games.filter(x => String(x.id) !== String(req.params.id));
    return { removed: before - cur.games.length };
  }, r => ({ ok: true, removed: r.removed })); });

app.put('/api/players/:no', async (req, res) => { if (!gateCoach(req, res)) return;
  if (!P(req.params.no)) return res.status(404).json({ error: 'unknown player' }); const b = req.body || {};
  if (b.team !== undefined && isSubmissionLocked(state.teamSubmission)) return res.status(423).json({ error: 'team list is submitted and locked', submittedAt: state.teamSubmission.submittedAt });
  if (b.estAvg !== undefined && !validEstimate(b.estAvg)) return res.status(400).json({ error: 'estimated average must be a number 0–300 or null' });
  if (b.target !== undefined && !validTarget(b.target)) return res.status(400).json({ error: 'target must be a whole number 0–300 or null' });
  let pubOut;
  await saveAndReply(res, () => {
    if (b.team !== undefined && isSubmissionLocked(state.teamSubmission)) { const e = new Error('team list is submitted and locked'); e.httpStatus = 423; throw e; }
    const p = P(req.params.no); if (!p) { const e = new Error('unknown player'); e.httpStatus = 404; throw e; }
    if (b.available !== undefined) p.available = !!b.available;
    if (b.estAvg   !== undefined) p.estAvg   = clearValue(b.estAvg) ? null : b.estAvg;
    if (b.team     !== undefined) {
      p.team = (['A', 'B', 'C'].includes(b.team)) ? b.team : null;
      clearStaleMatchdayEntries(p.no, p.team);
    }
    if (b.pin      !== undefined) p.pin      = !!b.pin;
    if (b.target   !== undefined) p.target   = clearValue(b.target) ? null : b.target;
    pubOut = pub(p);
  }, () => ({ ok: true, player: pubOut })); });

// A player sets their OWN target (or a coach for anyone)
app.post('/api/mytarget', async (req, res) => {
  const a = authOf(req); if (!a) return res.status(401).json({ error: 'sign in required' });
  const { no, target } = req.body || {}; if (!P(no)) return res.status(404).json({ error: 'unknown player' });
  if (!a.isCoach && Number(a.no) !== Number(no)) return res.status(403).json({ error: 'not your target' });
  if (!validTarget(target)) return res.status(400).json({ error: 'target must be a whole number 0–300 or null' });
  let out;
  await saveAndReply(res, () => {
    const p = P(no); if (!p) { const e = new Error('unknown player'); e.httpStatus = 404; throw e; }
    p.target = clearValue(target) ? null : target; out = p.target;
  }, () => ({ ok: true, target: out }));
});

app.post('/api/optimizer/evaluate', (req, res) => {
  if (!gateCoach(req, res)) return;
  const b = req.body || {};
  const allowedModes = ['championship-safe', 'aggressive', 'franchise-balanced'];
  const scenarioMode = b.scenarioMode || 'championship-safe';
  if (!allowedModes.includes(scenarioMode)) return res.status(400).json({ error: 'unknown scenario mode' });
  const validMap = (value, allowed) => value === undefined || (value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([no, v]) => ROSTER_NOS.includes(Number(no)) && allowed(v)));
  if (!validMap(b.pins, v => ['A', 'B', 'C'].includes(v))) return res.status(400).json({ error: 'pins must map roster numbers to A, B, or C' });
  if (!validMap(b.availability, v => typeof v === 'boolean')) return res.status(400).json({ error: 'availability must map roster numbers to booleans' });
  let benchmark = null;
  if (b.benchmark !== undefined) {
    const x = b.benchmark;
    if (!x || typeof x !== 'object' || !['stageOne', 'later'].includes(x.stage) ||
        !Number.isFinite(x.cutoff) || x.cutoff < 0 || x.cutoff > (x.stage === 'stageOne' ? 3000 : 1500) ||
        typeof x.source !== 'string' || !x.source.trim() || x.source.length > 120 || !validDate(x.observedAt)) {
      return res.status(400).json({ error: 'benchmark requires stage, valid cutoff, source, and observedAt date' });
    }
    benchmark = { stage: x.stage, cutoff: x.cutoff, source: x.source.trim(), observedAt: x.observedAt };
  }
  const snapshotUpdatedAt = state.updatedAt;
  const evaluationInstant = new Date(snapshotUpdatedAt).toISOString();
  const evaluationDate = evaluationInstant.slice(0, 10);
  const persistedPins = Object.fromEntries(state.players.filter(p => p.pin && p.team).map(p => [p.no, p.team]));
  const persistedAvailability = Object.fromEntries(state.players.map(p => [p.no, p.available !== false]));
  const pins = { ...persistedPins, ...(b.pins || {}) };
  const availability = { ...persistedAvailability, ...(b.availability || {}) };
  const seed = `${OPTIMIZER_VERSION}:${snapshotUpdatedAt}:${JSON.stringify({ pins, availability, benchmark })}`;
  const result = evaluateRoster({ roster: ROSTER, players: state.players, capCr: state.settings.capCr,
    leads: TEAM_LEADS, pins, availability, evaluationDate, seed, benchmark });
  if (result.conflict) return res.status(422).json({ error: result.conflict });
  const picked = result.scenarios;
  const byMode = { 'championship-safe': picked.championshipSafe, aggressive: picked.aggressive,
    'franchise-balanced': picked.franchiseBalanced };
  const labels = { 'championship-safe': 'Championship Safe', aggressive: 'Aggressive',
    'franchise-balanced': 'Franchise Balanced' };
  const labelled = (scenario, mode) => ({ ...scenario, mode, label: labels[mode] });
  res.json({
    modelVersion: result.modelVersion, evaluationVersion: snapshotUpdatedAt, evaluatedAt: evaluationInstant,
    legalPartitionCount: result.legalPartitionCount,
    dataQuality: result.forecasts.flatMap(f => f.warnings.map(message => ({ no: f.no, message }))),
    forecasts: result.forecasts, recommended: labelled(byMode[scenarioMode], scenarioMode),
    alternatives: Object.entries(byMode).filter(([mode]) => mode !== scenarioMode).map(([mode, scenario]) => labelled(scenario, mode)),
    unresolvedRules: ['Stage II says 12 advance while Stage III says 16 teams'],
  });
});

app.post('/api/teams/submit', async (req, res) => {
  if (!gateCoach(req, res)) return;
  const assignmentVersion = (req.body || {}).assignmentVersion;
  if (!Number.isFinite(assignmentVersion) || assignmentVersion !== state.updatedAt) {
    return res.status(409).json({ error: 'team data changed — refresh before submitting' });
  }
  const assignments = Object.fromEntries(state.players.map(p => [p.no, p.team]));
  const err = teamSplitError(ROSTER_INFO, assignments, state.settings.capCr, TEAM_LEADS);
  if (err) return res.status(400).json({ error: err });
  const actor = authOf(req).no ?? 'coach';
  await saveAndReply(res, () => {
    if (assignmentVersion !== state.updatedAt) { const e = new Error('team data changed — refresh before submitting'); e.httpStatus = 409; throw e; }
    if (isSubmissionLocked(state.teamSubmission)) { const e = new Error('team list is already submitted'); e.httpStatus = 423; throw e; }
    state.teamSubmission = { submittedAt: gameNow(), submittedBy: actor, assignmentVersion };
    return state.teamSubmission;
  }, submission => ({ ok: true, submission }));
});

app.post('/api/teams/unlock', async (req, res) => {
  if (!gateCoach(req, res)) return;
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5 || reason.length > 160) return res.status(400).json({ error: 'unlock reason must be 5–160 characters' });
  if (!isSubmissionLocked(state.teamSubmission)) return res.status(409).json({ error: 'team list is not locked' });
  const actor = authOf(req).no ?? 'coach';
  await saveAndReply(res, () => {
    if (!isSubmissionLocked(state.teamSubmission)) { const e = new Error('team list is not locked'); e.httpStatus = 409; throw e; }
    const unlockedAt = Math.max(gameNow(), Number(state.teamSubmission.submittedAt) + 1);
    const audit = { submittedAt: state.teamSubmission.submittedAt, unlockedAt, unlockedBy: actor, reason,
      priorAssignments: Object.fromEntries(state.players.map(p => [p.no, p.team])) };
    state.teamSubmission.unlockedAt = unlockedAt; state.teamSubmission.unlockedBy = actor; state.teamSubmission.unlockReason = reason;
    state.teamSubmissionAudit.push(audit); state.teamSubmissionAudit = state.teamSubmissionAudit.slice(-100);
    return audit;
  }, () => ({ ok: true, submission: state.teamSubmission, audit: state.teamSubmissionAudit }));
});

app.post('/api/teams', async (req, res) => { if (!gateCoach(req, res)) return;
  if (isSubmissionLocked(state.teamSubmission)) return res.status(423).json({ error: 'team list is submitted and locked', submittedAt: state.teamSubmission.submittedAt });
  const evaluationVersion = (req.body || {}).evaluationVersion;
  if (evaluationVersion !== undefined && (!Number.isFinite(evaluationVersion) || evaluationVersion !== state.updatedAt)) {
    return res.status(409).json({ error: 'team data changed — refresh the analysis before applying it' });
  }
  const a = (req.body && req.body.assignments) || {};
  const next = Object.fromEntries(state.players.map(p => [p.no, Object.prototype.hasOwnProperty.call(a, p.no) ? a[p.no] : p.team]));
  if (Object.values(next).every(team => ['A', 'B', 'C'].includes(team))) {
    const err = teamSplitError(ROSTER_INFO, next, state.settings.capCr, TEAM_LEADS);
    if (err) return res.status(400).json({ error: err });
  }
  await saveAndReply(res, () => {
    if (isSubmissionLocked(state.teamSubmission)) { const e = new Error('team list is submitted and locked'); e.httpStatus = 423; throw e; }
    if (evaluationVersion !== undefined && evaluationVersion !== state.updatedAt) {
      const e = new Error('team data changed — refresh the analysis before applying it'); e.httpStatus = 409; throw e;
    }
    Object.keys(a).forEach(no => { const p = P(no); if (p) {
      p.team = ['A', 'B', 'C'].includes(a[no]) ? a[no] : null;
      clearStaleMatchdayEntries(p.no, p.team);
    } });
  }, () => ({ ok: true, assignmentVersion: state.updatedAt })); });
function applySettings(b) {
  ['defaultAvg', 'capCr'].forEach(k => {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '' && Number.isFinite(Number(b[k]))) state.settings[k] = Number(b[k]);
  });
  if (['powerhouse', 'balanced', 'tiered'].includes(b.splitStrategy)) state.settings.splitStrategy = b.splitStrategy;
  if (['A', 'B', 'C'].includes(b.powerTeam)) state.settings.powerTeam = b.powerTeam;
}
app.put('/api/settings', async (req, res) => { if (!gateCoach(req, res)) return;
  const b = req.body || {};
  await saveAndReply(res, () => applySettings(b), () => ({ ok: true, settings: state.settings })); });
app.post('/api/import', async (req, res) => { if (!gateCoach(req, res)) return;
  const incoming = (req.body && req.body.players) || [];
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'players must be an array' });
  for (const ip of incoming) {
    const err = validateImportPlayer(ip);
    if (err) return res.status(400).json({ error: 'not a valid import: ' + err });
  }
  await saveAndReply(res, () => {
    let added = 0;
    incoming.forEach(ip => { const p = P(ip.no); if (!p) return; (ip.games || []).forEach((g, i) => {
      const dup = p.games.some(x => {
        if (g.id) return x.id === g.id;
        if (g.clientId) return x.clientId === g.clientId;
        return x.date === g.date && x.score === g.score &&
          (x.strikes || 0) === (g.strikes || 0) && (x.spares || 0) === (g.spares || 0) &&
          (x.ts || 0) === (g.ts || 0) && (x.by || 'self') === (g.by || 'self') &&
          !!x.verified === !!g.verified;
      });
      if (!dup) { p.games.push(cleanGame(g, ip.no, i)); added++; } }); });
    return { added };
  }, r => ({ ok: true, added: r.added })); });
app.post('/api/reset', async (req, res) => { if (!gateCoach(req, res)) return;
  await saveAndReply(res, () => {
    const keepId = state.installId;
    const coachSessions = {};
    Object.entries(state.sessions).forEach(([k, s]) => { if (s.no == null && s.isCoach) coachSessions[k] = s; });
    state = defaultState(); state.installId = keepId; state.sessions = coachSessions;
  }, { ok: true }); });
// Match day: coach records each sub-team's tournament games (2 per player), kept separate from practice.
app.post('/api/matchday', async (req, res) => { if (!gateCoach(req, res)) return;
  const b = req.body || {}, team = b.team;
  if (!['A', 'B', 'C'].includes(team)) return res.status(400).json({ error: 'team must be A/B/C' });
  if (b.clear) return saveAndReply(res, () => { state.matchday[team] = {}; }, () => ({ ok: true, matchday: state.matchday }));
  const no = Number(b.no), game = Number(b.game);
  if (!ROSTER_NOS.includes(no) || ![1, 2].includes(game)) return res.status(400).json({ error: 'bad no/game' });
  if (P(no).team !== team) return res.status(400).json({ error: 'player is not assigned to sub-team ' + team });
  const score = Math.max(0, Math.min(300, parseInt(b.score, 10) || 0));
  const strikes = Math.max(0, Math.min(12, parseInt(b.strikes, 10) || 0));
  const spares = Math.max(0, Math.min(10, parseInt(b.spares, 10) || 0));
  await saveAndReply(res, () => {
    state.matchday[team] = state.matchday[team] || {};
    state.matchday[team][no + '-' + game] = { score, strikes, spares };
  }, () => ({ ok: true, matchday: state.matchday }));
});

/* ---------------- backup / import validation ----------------
   Backups and imports are treated as untrusted input even though the
   endpoints are coach-only: every game must be well-formed before it is
   accepted, and only known-safe fields are copied. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE_RE = /^[0-9a-f]{16,64}$/;
const PIN_HASH_RE = /^([0-9a-f]{64}|scrypt:\d{1,8}:\d{1,3}:\d{1,3}:[0-9a-f]{16,64}:[0-9a-f]{32,128})$/;
function gameError(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'game is not an object';
  if (!intIn(g.score, 0, 300)) return 'game score must be an integer 0–300';
  if (g.strikes !== undefined && !intIn(g.strikes, 0, 12)) return 'strikes must be an integer 0–12';
  if (g.spares !== undefined && !intIn(g.spares, 0, 10)) return 'spares must be an integer 0–10';
  if (g.strikesRecorded !== undefined && typeof g.strikesRecorded !== 'boolean') return 'bad strikesRecorded flag';
  if (g.sparesRecorded !== undefined && typeof g.sparesRecorded !== 'boolean') return 'bad sparesRecorded flag';
  if (g.optimizerIncluded !== undefined && typeof g.optimizerIncluded !== 'boolean') return 'bad optimizerIncluded flag';
  if (g.optimizerExclusionReason !== undefined && g.optimizerExclusionReason !== null &&
      (typeof g.optimizerExclusionReason !== 'string' || g.optimizerExclusionReason.length > 160)) return 'bad optimizer exclusion reason';
  if (!validDate(g.date)) return 'game date must be a valid YYYY-MM-DD';
  if (g.id !== undefined && g.id !== null && !ID_RE.test(String(g.id))) return 'bad game id';
  if (g.clientId !== undefined && g.clientId !== null && !ID_RE.test(String(g.clientId))) return 'bad game clientId';
  if (g.ts !== undefined && !(Number.isFinite(g.ts) && g.ts >= 0)) return 'bad game ts';
  if (g.verified !== undefined && typeof g.verified !== 'boolean') return 'bad verified flag';
  if (g.by !== undefined && !['coach', 'self'].includes(g.by)) return 'bad "by" field';
  return null;
}
// copy only known-safe fields; assign a stable immutable id when missing (legacy backups)
function cleanGame(g, no, idx) {
  const out = {
    id: (g.id && ID_RE.test(String(g.id))) ? String(g.id) : legacyGameId(no, g, idx || 0),
    score: g.score,
    strikes: intIn(g.strikes, 0, 12) ? g.strikes : 0,
    spares: intIn(g.spares, 0, 10) ? g.spares : 0,
    strikesRecorded: g.strikesRecorded === true,
    sparesRecorded: g.sparesRecorded === true,
    optimizerIncluded: g.optimizerIncluded !== false,
    optimizerExclusionReason: g.optimizerIncluded === false && typeof g.optimizerExclusionReason === 'string'
      ? g.optimizerExclusionReason.slice(0, 160) : null,
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
  const seenIds = new Set(), seenNos = new Set();
  for (const bk of b.players) {
    const no = Number(bk && bk.no);
    if (seenNos.has(no)) return 'duplicate player no ' + no;
    seenNos.add(no);
    const err = playerEntryError(bk, seenIds);
    if (err) return err;
  }
  if (b.matchday !== undefined) {
    const err = matchdayError(b.matchday);
    if (err) return err;
  }
  if (b.settings !== undefined && (typeof b.settings !== 'object' || b.settings === null || Array.isArray(b.settings))) return 'settings must be an object';
  if (b.teamSubmission !== undefined && b.teamSubmission !== null && !cleanSubmission(b.teamSubmission)) return 'bad teamSubmission';
  if (b.teamSubmissionAudit !== undefined && (!Array.isArray(b.teamSubmissionAudit) || b.teamSubmissionAudit.some(x => !cleanAudit(x)))) return 'bad teamSubmissionAudit';
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
      if (!/^\d+-(1|2)$/.test(key)) return;
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
