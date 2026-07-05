# VOX STARS Cockpit 🎳

Shared team app for **VOX STARS** in the **IncrediBowl S2** ten-pin bowling league.
Best-XI combination optimizer + practice tracker, with data synced live across the whole team.

- **Lineup** — recommends your strongest XI from the 15-player squad (ranks by average, enforces bowlers-per-match + minimum-women, honours lock in/out and availability).
- **Roster** — availability, lock a player into the XI, estimated averages for new bowlers.
- **Practice** — players log each game (score / strikes / spares); averages update and the lineup re-ranks automatically.
- **Rivals** — compare your projected total against any opponent.
- Data lives on a small server + JSON store on a persistent volume, so everyone sees the same numbers.

---

## How the team uses it

1. Open the deployed URL on your phone → **Add to Home Screen** (works like an app).
2. Default is **Player** mode — pick "You are" and log your practice games.
3. The captain/coach taps **Mode → enter coach PIN** to set the lineup, verify games, and edit the roster.

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
