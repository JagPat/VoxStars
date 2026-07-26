# VOX STARS Cockpit 🎳

Shared team app for **VOX STARS** in **Design IncrediBowl — Ahmedabad Season 2** (ten-pin bowling), with data synced live across the whole team.

Built to the official DIB S2 format: your 15-player Master Squad splits into **3 sub-teams (A / B / C)** of **4 men + 1 woman** each, every sub-team capped at **₹25 Cr** base value (final auction price), with the Captain and two Vice-Captains fixed to separate teams.

The app is **role-based** behind a single login. Each person signs in as themselves (remembered on their phone) and sees only what their role should — a private, motivating **Player** app and a powerful **Coach/Captain** cockpit.

**Player app** (bottom nav Me / My Team / Form / Profile):

- **Me** — your target + a progress ring, games / best / strikes / spares, a last-6 form chart, and a **game plan** written from your own numbers. Only you can edit your games.
- **My Team** — your sub-team, **read-only**: you see your five and the team's projected series, but only each player edits their own scores.
- **Form** — the squad leaderboard, where VOX STARS rank among the 12 brands, plus a team-only strikes leaderboard.
- **Log a game** — a fast sheet with a **Quick score** stepper *and* a **frame-by-frame scorer** that does the real ten-pin math (strikes, spares, 10th-frame bonus). Instant toast + Undo. If you're offline, the score is **queued on your phone** ("⏳ Queued — not yet synced") and saved automatically when you reconnect — retries can never create duplicates.

**Coach / Captain cockpit** (Squad / Log session / Optimizer / Match Day), unlocked from the captain/VC login or the coach PIN:

- **Squad readiness board** — every player's avg, trend, confidence (games logged), target gap and availability, with **Nudge** and **Log-for-them** on anyone short of data.
- **Session logger** — punch a whole lane's scores off the overhead monitor in one ~30-second pass. Failed saves stay on the form and say so — nothing is silently dropped.
- **Tournament optimizer** — evaluates every legal ₹25 Cr split, models each player's uncertainty, and compares **Championship Safe**, **Aggressive**, and **Franchise Balanced** scenarios before the captain applies one.
- **Match Day** — each sub-team's two qualifier games with strike/spare tie-breakers, kept separate from practice.

Data lives on a small server + JSON store on a persistent volume, so everyone sees the same numbers.

**VOX STARS leads:** Captain Ar. Jagrut Patel (Team A), VC1 Sandeep Sisodiya (Team B), VC2 Siddharth Bhatt (Team C). Squad base value totals 60 Cr.

> **Sign-in (real per-player auth):** each player gets a personal **single-use invite link** from the coach (Squad → Invite links). Opening it claims your identity and sets a **required 4-digit PIN**; after that you sign in with **name + PIN** on any device. A claimed link stops working — it can't be replayed to take over an identity. The server **enforces** everything: a player can only ever log *their own* games. The **Captain and Vice-Captains** get the coach cockpit from their own login, and the **coach PIN** works as a backup unlock (it issues a ~12-hour coach session; the PIN itself is never stored on the device). Lost PIN or lost phone? The coach taps **Reset** next to the player in Invite links — that revokes their old link, PIN **and every signed-in session**, and produces a fresh invite.

---

## How the team uses it

1. Open the deployed URL on your phone → **Add to Home Screen** (works like an app).
2. **Sign in** — open your personal **invite link** (sets your PIN) the first time; after that just **name + PIN** on any phone. You land straight on **Me**.
3. **Play & log:** after each game tap **＋ Log a game** (quick score, or tap the pins frame-by-frame). Your ring and plan update instantly — and only *you* can log *your* games. No signal in the alley? The score queues on your phone and syncs itself later.
4. **The captain / vice-captains** get the cockpit from their own login (**Profile → Enter coach cockpit**; coach PIN works as a backup). Share each player's link from **Squad → Invite links**.

## Tournament optimizer

Open **Coach cockpit → Optimizer** and tap **Analyze all teams**. The server evaluates every legal partition of the 15-player roster while enforcing 4 men + 1 woman, the 25 Cr cap, unique player assignment, availability, coach pins, and separate Captain/VC leadership.

- **Championship Safe** is the default compromise between a strong title contender and protection for the weakest sub-team.
- **Aggressive** maximizes the strongest team's conservative later-round score.
- **Franchise Balanced** maximizes the weakest team's conservative floor.

Each team card shows expected Stage I score, a conservative Stage I floor, the one-game later-round floor, Base Value, forecast confidence, and tie-break data coverage. Tap a player to inspect their forecast range and evidence. Recommendations are advisory: assignments change only after the coach taps **Apply**.

### Competitors and benchmarks

The coach-only **Competitors & benchmarks** panel accepts an observed competitor franchise/team score, tournament stage, source, and date. Stage I uses 10-game totals; later rounds use 5-game totals. Each VOX team is shown against that field using its P20, expected, and P80 forecast plus an observed rank range.

This is a score comparison, not a win probability. Named A/B/C observations are labelled `confirmed`; franchise-only observations are `provisional`. These records are excluded from ordinary player API state and included in coach backups.

### Score evidence and exclusions

New games explicitly record whether strikes and spares were actually tracked, so missing tie-break data is not treated as zero. The data-quality queue highlights missing/stale practice data, influential scores, incomplete tie-break tracking, and unavailable players. A coach may exclude a suspicious game from optimization; the score remains visible in player history, exports, and backups and can be included again later.

### Submitting and unlocking team lists

After applying and reviewing all three teams, tap **Mark official list submitted**. This locks both the optimizer and direct team edits, enforcing the organizer's no-internal-swaps rule. If the organizer approves a correction, **Organizer-approved unlock** requires a reason and retains the prior assignments, actor, and timestamp in the coach-only audit trail.

### Model limitations

- Forecasts use prior-season evidence plus recency-weighted practice scores and deliberately widen when evidence is limited; they are decision support, not guarantees.
- Qualification probability is omitted unless a dated, sourced opponent/cutoff benchmark is supplied.
- The supplied rules PDF conflicts internally: Stage II says 12 teams advance while Stage III describes 16 teams. The optimizer uses the conservative interpretation but does not claim to resolve that organizer inconsistency.
- Spirit of IncrediBowl scoring is not calculated because the official methodology has not been announced.

---

## Run locally (optional)

```bash
npm ci        # or npm install
npm start
# open http://localhost:3000
```

In development the server falls back to a development coach PIN (with a warning). Env vars: `PORT` (default 3000), `COACH_PIN`, `DATA_DIR` (default ./data).

**In production (`NODE_ENV=production`, which the Docker image sets) the server refuses to start unless `COACH_PIN` is set to something that isn't a known development default.**

### Tests & checks (safe by design)

```bash
npm test        # full isolated suite: spawns its own server on a random free
                # port, a fresh temporary DATA_DIR and a random test-only
                # coach credential — it never touches ./data or a deployed URL
npm run check   # syntax-checks server.js, app-core.js, the tests and the
                # inline <script> in public/index.html
```

---

## Deploy on Coolify (GitHub auto-deploy)

### 1. Push this folder to GitHub
```bash
git remote add origin https://github.com/<you>/voxstars-cockpit.git
git branch -M main
git push -u origin main
```

### 2. Create the app in Coolify
- **+ New → Resource → Application → Public/Private Git Repository**.
- Select your `voxstars-cockpit` repo and the `main` branch.
- **Build Pack: Dockerfile** (Coolify auto-detects the included `Dockerfile`).
- **Port: `3000`**.

### 3. Add a persistent volume (so data survives redeploys) — IMPORTANT
- Under **Storages / Persistent Storage**, add a volume mounted at **`/data`**.
- Without this, a redeploy would wipe the team's logged games.

### 4. Set environment variables
| Key | Value | Notes |
|-----|-------|-------|
| `COACH_PIN` | *your secret PIN* | **Required — the container will not start without it.** Must be **at least 6 characters** and not a known default; weak/known values are refused at startup. |
| `PORT` | `3000` | Optional; matches the exposed port. |
| `TRUST_PROXY` | `1` | Optional (defaults to `1` in production). Number of proxy hops in front of the app — keep it accurate so clients can't forge their IP (`X-Forwarded-For`) and dodge login/coach rate limits. Set higher only if you add more proxies. |
| `AUTH_SALT` | *only if you set it before* | Only needed to verify pre-migration player PINs; PINs are re-hashed with per-player salts (scrypt) as players log in. |

> **Run a single instance per data volume.** The store is one JSON file with last-writer-wins semantics, so two app instances sharing the same `/data` volume can overwrite each other. During deploys, let the old container **stop before** the new one starts (avoid overlapping rolling deploys against the same volume).

### 5. Domain + health check
- Assign a domain (or use the Coolify-generated URL). Coolify issues HTTPS automatically.
- **Health check path: `/api/health`** — it returns **503** if the data store is corrupt/unreadable, so a broken volume shows up as an unhealthy deploy instead of silent data loss.

### 6. Deploy + enable auto-deploy
- Click **Deploy**.
- Turn on **Auto Deploy**. Every `git push` to `main` redeploys automatically — and because the data is on the `/data` volume, the team's numbers are preserved across deploys.

> **First deploy after this upgrade:** all previously issued sessions are invalidated once (players sign in again with name + PIN; existing PINs keep working and are transparently upgraded to stronger hashing on the next login).

---

## Updating the app

```bash
git add -A && git commit -m "tweak" && git push
```
Coolify rebuilds and redeploys automatically. Practice data on the `/data` volume is untouched.

---

## Backups & recovering from a corrupt state file

- The server writes a **daily rotating backup** (last 14 days) to `DATA_DIR/backups/state-YYYY-MM-DD.json` on the persistent volume, and the coach can download a snapshot anytime via **Squad → Export backup**.
- If `/data/state.json` is ever **unreadable or corrupt**, the server **preserves the file untouched**, refuses all reads/writes, and reports `503` on `/api/health` (degraded mode). It will never overwrite your data with a blank roster.
- **To recover:**
  1. Pick a backup: a coach-exported file, or the newest `DATA_DIR/backups/state-*.json`.
  2. **Validate it** first: check it parses (`node -e "JSON.parse(require('fs').readFileSync('state-....json'))"`) and that it contains your players/games.
  3. Move the corrupt file aside (e.g. `mv state.json state.json.corrupt`), copy the validated backup to `DATA_DIR/state.json`, and restart the app. Health goes green again.
  4. Alternatively, once the server is healthy, use **Squad → Restore** with a coach-exported file — restores are strictly validated before being applied.

---

## Notes & security

- **Read access:** viewing the squad's scores requires sign-in — `GET /api/state` needs a valid player or coach session, so the public / logged-out can't read team data. Signed-in team-mates still see the whole squad (the team-transparency model is unchanged). **Every write** also requires sign-in, and players can only write their own games. To lock things down further (e.g. hide even the login page), add **Basic Auth** in Coolify or put the app behind your network.
- **Sessions** expire (players ~30 days, coach ~12 h), are stored only as hashes on the server, and are revoked by sign-out, invite reset, restore, and roster reset.
- **PINs** are stored as per-player salted scrypt hashes. Sign-in is rate limited per (account + IP) so no one can lock a player out by guessing — the real owner with the correct PIN from a different device is never blocked; coach-PIN verification is rate limited per IP plus a global backstop. An invite **Reset** by the coach clears any lockout.
- **Durable writes** are atomic and fsync'd; a mutation is acknowledged only after it is on disk, and concurrent writes are serialized so a failed save can never lose or leak another request's change.
- **Durability:** every change is written atomically and acknowledged only after it's on disk — if the volume fails, the API says so instead of pretending it saved.
- The store is a single JSON file (`/data/state.json`) — perfect for a 15-player squad. It can be swapped for SQLite/Postgres later if the league grows.
- Roster and prior-season averages are preloaded from the IncrediBowl S2 auction results (VOX STARS). New signings start without data and build their average through practice logs.

## API (for reference)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | health check (503 = degraded store) |
| GET | `/api/state` | player/coach session | full team state (secrets stripped; sign-in required) |
| GET | `/api/join?t=` | invite token | resolve a (still unused) invite link |
| POST | `/api/claim` | invite token | claim identity + set PIN (consumes the invite, issues a session) |
| POST | `/api/login` | name + PIN | sign in on a new device (rate limited) |
| POST | `/api/session` | session | validate a stored session |
| POST | `/api/logout` | session | revoke the presented session(s) |
| POST | `/api/coach/verify` | coach PIN | verify once → expiring coach session (rate limited) |
| GET | `/api/invites` | coach | per-player invite tokens (null once claimed) |
| POST | `/api/invites/reset` | coach | new single-use invite; clears PIN, revokes all sessions |
| POST | `/api/games` | player/coach | log a game (idempotent via `clientId`) |
| POST | `/api/games/:no/:id/verify` | coach | verify/unverify a game (by immutable id) |
| PUT | `/api/games/:no/:id/optimizer-status` | coach | include/exclude a retained game from forecasts |
| DELETE | `/api/games/:no/:id` | own player/coach | delete a game (by immutable id) |
| PUT | `/api/players/:no` | coach | availability / lock / estimate / target |
| POST | `/api/mytarget` | own player/coach | set a player's target |
| POST | `/api/optimizer/evaluate` | coach | evaluate every legal split and return three scenarios |
| POST | `/api/teams` | coach | assign sub-teams (supports stale-analysis guard) |
| POST | `/api/teams/submit` | coach | lock the complete official team list |
| POST | `/api/teams/unlock` | coach | audited organizer-approved unlock |
| PUT | `/api/settings` | coach | lineup size, cap, strategy |
| GET | `/api/backup` | coach | download a full snapshot |
| POST | `/api/restore` | coach | restore a snapshot (strictly validated) |
| POST | `/api/import` | coach | merge an exported snapshot (validated, deduped) |
| POST | `/api/matchday` | coach | record/clear match-day qualifier scores |
| POST | `/api/reset` | coach | reset to original roster (revokes player sessions) |
