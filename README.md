# VOX STARS Cockpit 🎳

Shared team app for **VOX STARS** in **Design IncrediBowl — Ahmedabad Season 2** (ten-pin bowling), with data synced live across the whole team.

Built to the official DIB S2 format: your 15-player Master Squad splits into **3 sub-teams (A / B / C)** of **4 men + 1 woman** each, every sub-team capped at **₹25 Cr** base value (final auction price), with the Captain and two Vice-Captains fixed to separate teams.

The app is **role-based** behind a single login. Each person signs in as themselves (remembered on their phone) and sees only what their role should — a private, motivating **Player** app and a powerful **Coach/Captain** cockpit.

**Player app** (bottom nav Me / My Team / Compete / Profile):

- **Me** — your target + a progress ring, games / best / strikes / spares, a last-6 form chart, and a **game plan** written from your own numbers. Only you can edit your games.
- **My Team** — your sub-team, **read-only**: you see your five and the team's projected series, but only each player edits their own scores.
- **Compete** — where VOX STARS rank among the 12 brands, plus an opt-in, team-only strikes leaderboard.
- **Log a game** — a fast sheet with a **Quick score** stepper *and* a **frame-by-frame scorer** that does the real ten-pin math (strikes, spares, 10th-frame bonus). Instant toast + Undo.

**Coach / Captain cockpit** (Squad / Log session / Optimizer), unlocked with the coach PIN:

- **Squad readiness board** — every player's avg, trend, confidence (games logged), target gap and availability, with **Nudge** and **Log-for-them** on anyone short of data.
- **Session logger** — punch a whole lane's scores off the overhead monitor in one ~30-second pass (photo-OCR is flagged for next).
- **Optimizer** — the living sub-team builder: Powerhouse / Balanced / Tiered, ₹25 Cr cap, fixed Captain/VC leads, pins, and a live "stronger split available → Apply" prompt.

Data lives on a small server + JSON store on a persistent volume, so everyone sees the same numbers.

**VOX STARS leads:** Captain Ar. Jagrut Patel (Team A), VC1 Sandeep Sisodiya (Team B), VC2 Siddharth Bhatt (Team C). Squad base value totals 60 Cr.

> **Sign-in (real per-player auth):** each player gets a personal **invite link** from the coach (Squad → Invite links). Opening it claims your identity and sets a 4-digit PIN; after that you sign in with **name + PIN** on any device. The server **enforces** it — a player can only ever log *their own* games (others are rejected). The **Captain and Vice-Captains** get the coach cockpit straight from their own login, and the **coach PIN** still works as a backup unlock.

---

## How the team uses it

1. Open the deployed URL on your phone → **Add to Home Screen** (works like an app).
2. **Sign in** — open your personal **invite link** (sets your PIN) the first time; after that just **name + PIN** on any phone. You land straight on **Me**.
3. **Play & log:** after each game tap **＋ Log a game** (quick score, or tap the pins frame-by-frame). Your ring and plan update instantly — and only *you* can log *your* games.
4. **The captain / vice-captains** get the cockpit from their own login (**Profile → Enter coach cockpit**; coach PIN works as a backup). Share each player's link from **Squad → Invite links**.

---

## Run locally (optional)

```bash
npm install
npm start
# open http://localhost:3000
```

Optional env vars: `PORT` (default 3000), `COACH_PIN` (default 2626 — change it!), `DATA_DIR` (default ./data).

---

## Deploy on Coolify (GitHub auto-deploy)

### 1. Push this folder to GitHub
```bash
git remote add origin https://github.com/<you>/voxstars-cockpit.git
git branch -M main
git push -u origin main
```
(The repo is already initialised with a first commit.)

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
| `COACH_PIN` | *your secret PIN* | **Change from the default.** Only people with this can set the lineup/verify. |
| `PORT` | `3000` | Optional; matches the exposed port. |

### 5. Domain + health check
- Assign a domain (or use the Coolify-generated URL). Coolify issues HTTPS automatically.
- **Health check path: `/api/health`**.

### 6. Deploy + enable auto-deploy
- Click **Deploy**.
- Turn on **Auto Deploy** (Coolify adds a webhook to your GitHub repo). Now every `git push` to `main` redeploys automatically — and because the data is on the `/data` volume, the team's numbers are preserved across deploys.

---

## Updating the app

```bash
git add -A && git commit -m "tweak" && git push
```
Coolify rebuilds and redeploys automatically. Practice data on the `/data` volume is untouched.

---

## Notes & security

- Anyone with the URL can view the app and log a practice game. Coach-only actions (lineup, verify, delete, roster edits, reset) require `COACH_PIN`.
- To lock the whole app behind a password, add **Basic Auth** in Coolify, or put it behind your network.
- The store is a single JSON file (`/data/state.json`) — perfect for a 15-player squad. It can be swapped for SQLite/Postgres later if the league grows.
- Roster and prior-season averages are preloaded from the IncrediBowl S2 auction results (VOX STARS). New signings start without data and build their average through practice logs.

## API (for reference)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | health check |
| GET | `/api/state` | — | full team state |
| POST | `/api/games` | open | player logs a game |
| POST | `/api/games/:no/:ts/verify` | coach | verify/unverify a game |
| DELETE | `/api/games/:no/:ts` | coach | delete a game |
| PUT | `/api/players/:no` | coach | availability / lock / estimate |
| PUT | `/api/settings` | coach | lineup size, min women, rank-by |
| POST | `/api/coach/verify` | — | check a coach PIN |
| POST | `/api/import` | coach | merge an exported snapshot |
| POST | `/api/reset` | coach | reset to original roster |
