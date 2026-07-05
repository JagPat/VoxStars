/* ============================================================
   VOX STARS Cockpit — shared team backend (IncrediBowl S2)
   - Serves the app (public/index.html)
   - Stores shared team data as JSON on a persistent volume (/data)
   - Player logging is open; coach actions require the coach PIN
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const COACH_PIN = String(process.env.COACH_PIN || '2626'); // OVERRIDE in Coolify env vars!

fs.mkdirSync(DATA_DIR, { recursive: true });

// Canonical squad — the 15 VOX STARS auction numbers. Names/league stats live in the
// frontend (public/index.html); the server only stores mutable state per player.
const ROSTER_NOS = [149, 171, 175, 99, 31, 22, 114, 38, 137, 8, 128, 41, 49, 43, 82];

function defaultState() {
  return {
    players: ROSTER_NOS.map(no => ({
      no, games: [], available: true, lockIn: false, lockOut: false, estAvg: null
    })),
    settings: { lineupSize: 5, minFemales: 1, rankBy: 'avg', defaultAvg: 100 },
    updatedAt: Date.now()
  };
}

let state = loadState();
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // make sure every canonical player exists (roster is authoritative)
    const byNo = new Map(s.players.map(p => [p.no, p]));
    s.players = ROSTER_NOS.map(no => byNo.get(no) || { no, games: [], available: true, lockIn: false, lockOut: false, estAvg: null });
    s.settings = Object.assign({ lineupSize: 5, minFemales: 1, rankBy: 'avg', defaultAvg: 100 }, s.settings || {});
    return s;
  } catch (e) {
    const s = defaultState();
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(s)); } catch (_) {}
    return s;
  }
}

// serialized atomic writes (write to temp then rename) to avoid corruption/races
let writeChain = Promise.resolve();
function persist() {
  state.updatedAt = Date.now();
  const snapshot = JSON.stringify(state);
  const tmp = DATA_FILE + '.tmp';
  writeChain = writeChain
    .then(() => fs.promises.writeFile(tmp, snapshot))
    .then(() => fs.promises.rename(tmp, DATA_FILE))
    .catch(err => console.error('persist error:', err.message));
  return writeChain;
}

const P = no => state.players.find(p => p.no === Number(no));
function requireCoach(req, res) {
  if (String(req.get('x-coach-pin') || '') !== COACH_PIN) {
    res.status(401).json({ error: 'coach PIN required' });
    return false;
  }
  return true;
}

/* ---------------- API ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, updatedAt: state.updatedAt }));

app.get('/api/state', (req, res) =>
  res.json({ players: state.players, settings: state.settings, updatedAt: state.updatedAt }));

// Player logs a practice game (open to anyone with the URL)
app.post('/api/games', (req, res) => {
  const { no, score, strikes, spares, date } = req.body || {};
  const p = P(no);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  const s = Number(score);
  if (!(s >= 0 && s <= 300)) return res.status(400).json({ error: 'score must be 0–300' });
  const game = {
    score: s,
    strikes: Math.max(0, Math.min(12, Number(strikes) || 0)),
    spares: Math.max(0, Math.min(10, Number(spares) || 0)),
    date: (String(date || '').slice(0, 10)) || new Date().toISOString().slice(0, 10),
    ts: Date.now(),
    verified: false
  };
  p.games.push(game);
  persist();
  res.json({ ok: true, game });
});

// Coach: verify / unverify a game
app.post('/api/games/:no/:ts/verify', (req, res) => {
  if (!requireCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).end();
  const g = p.games.find(x => String(x.ts) === String(req.params.ts));
  if (!g) return res.status(404).end();
  g.verified = !g.verified; persist();
  res.json({ ok: true, verified: g.verified });
});

// Coach: delete a game
app.delete('/api/games/:no/:ts', (req, res) => {
  if (!requireCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).end();
  const before = p.games.length;
  p.games = p.games.filter(x => String(x.ts) !== String(req.params.ts));
  persist();
  res.json({ ok: true, removed: before - p.games.length });
});

// Coach: update a player's flags / estimate
app.put('/api/players/:no', (req, res) => {
  if (!requireCoach(req, res)) return;
  const p = P(req.params.no); if (!p) return res.status(404).end();
  const b = req.body || {};
  if (b.available !== undefined) p.available = !!b.available;
  if (b.lockIn   !== undefined) p.lockIn   = !!b.lockIn;
  if (b.lockOut  !== undefined) p.lockOut  = !!b.lockOut;
  if (b.estAvg   !== undefined) p.estAvg   = (b.estAvg === null || b.estAvg === '') ? null : Number(b.estAvg);
  persist();
  res.json({ ok: true, player: p });
});

// Coach: update lineup settings
app.put('/api/settings', (req, res) => {
  if (!requireCoach(req, res)) return;
  const b = req.body || {};
  ['lineupSize', 'minFemales', 'defaultAvg'].forEach(k => { if (b[k] !== undefined) state.settings[k] = Number(b[k]); });
  if (b.rankBy === 'avg' || b.rankBy === 'high') state.settings.rankBy = b.rankBy;
  persist();
  res.json({ ok: true, settings: state.settings });
});

// Check a coach PIN (used by the app when switching to Coach mode)
app.post('/api/coach/verify', (req, res) =>
  res.json({ ok: String((req.body || {}).pin || '') === COACH_PIN }));

// Coach: merge an exported backup (dedupes games by timestamp)
app.post('/api/import', (req, res) => {
  if (!requireCoach(req, res)) return;
  const incoming = (req.body && req.body.players) || [];
  let added = 0;
  incoming.forEach(ip => {
    const p = P(ip.no); if (!p) return;
    (ip.games || []).forEach(g => {
      const dup = p.games.some(x => x.ts === g.ts || (x.date === g.date && x.score === g.score && x.strikes === g.strikes));
      if (!dup) { p.games.push(g); added++; }
    });
  });
  persist();
  res.json({ ok: true, added });
});

// Coach: reset to the original 15-player roster
app.post('/api/reset', (req, res) => {
  if (!requireCoach(req, res)) return;
  state = defaultState(); persist();
  res.json({ ok: true });
});

/* ---------------- static app ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`VOX STARS Cockpit running on :${PORT}  (data: ${DATA_FILE})`);
  if (COACH_PIN === '2626') console.warn('⚠︎  Using default COACH_PIN — set COACH_PIN in Coolify env vars.');
});
