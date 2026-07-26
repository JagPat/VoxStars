# Tournament Optimizer Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a coach-only, explainable optimizer that evaluates every legal three-team split, presents Championship Safe, Aggressive, and Franchise Balanced scenarios, and locks assignments after official submission.

**Architecture:** Move immutable roster facts and optimization logic into focused CommonJS/UMD modules that both the server and browser can consume. The server derives forecasts from durable state, exhaustively generates legal partitions, evaluates them with deterministic seeded simulations, and exposes only safe derived results through coach-only APIs. Existing serialized commits remain the sole path for state mutations.

**Tech Stack:** Node.js 18+, Express 4, CommonJS/UMD JavaScript, `node:test`, vanilla HTML/CSS/JavaScript, JSON-file persistence.

## Global Constraints

- Release 1 covers decision quality, data-quality controls, and submission locking; stage-aware Match Day and the administrator rules panel are separate follow-on work.
- Every team must contain exactly four men and one woman, stay at or below 25 Cr, and have one of Captain 149, Vice-Captain 171, and Vice-Captain 175 fixed to A, B, and C respectively.
- The optimizer is advisory and never applies assignments without an explicit coach action.
- Missing strike/spare data is unknown, never a measured zero.
- No qualification probability is returned without an explicit opponent or cutoff benchmark.
- The same state, evaluation date, model version, settings, and seed must return the same result.
- A submitted team list is read-only unless an administrator records an approved unlock reason.
- All mutations must use the existing serialized `commit()` / `saveAndReply()` durability pipeline.
- No session token, PIN hash, invite token, or raw backup content may appear in optimizer responses.
- Avoid new runtime dependencies; use the existing Node and browser platform APIs.

---

## File Structure

- `public/roster.js`: one UMD roster source shared by browser and server.
- `lib/optimizer/forecast.js`: empirical-Bayes score forecasts and data-quality flags.
- `lib/optimizer/legal-teams.js`: exhaustive legal partition generation and pin-conflict reporting.
- `lib/optimizer/evaluator.js`: seeded tournament simulation, Pareto filtering, and scenario selection.
- `lib/optimizer/index.js`: orchestration and response shaping for the API.
- `server.js`: state migration, validation, coach-only optimizer/status/submission routes, durable mutations.
- `public/app-core.js`: small pure client helpers for optimizer formatting and submission state.
- `public/index.html`: optimizer scenarios, player forecast drawer, data-quality actions, and submission lock UI.
- `test/roster.test.js`: shared-roster invariants.
- `test/forecast.test.js`: forecast, confidence, recency, exclusion, and coverage behavior.
- `test/legal-teams.test.js`: exhaustive constraint and conflict tests.
- `test/evaluator.test.js`: deterministic metrics, Pareto selection, and benchmark behavior.
- `test/optimizer-api.test.js`: authorization, response safety, stale apply, exclusion, and degraded-mode behavior.
- `test/submission.test.js`: submission lock, audited unlock, restore, and durability behavior.
- `test/client-optimizer.test.js`: pure rendering/view-model helper tests.
- `README.md`: coach workflow, model limitations, and backup compatibility notes.

### Task 1: Establish a single shared roster source

**Files:**
- Create: `public/roster.js`
- Create: `test/roster.test.js`
- Modify: `server.js:64-74`
- Modify: `public/index.html:53-70`

**Interfaces:**
- Produces: `VoxRoster.ROSTER`, `VoxRoster.LEADS`, and CommonJS exports `{ ROSTER, LEADS }`.
- Roster entries retain the browser fields `no`, `name`, `firm`, `g`, `pt`, `lgAvg`, `lgHigh`, `lgM`, `lgStr`, `lgSpr`, and `role`.

- [ ] **Step 1: Write the failing roster invariant test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER, LEADS } = require('../public/roster');

test('official roster can form exactly three legal five-player teams', () => {
  assert.equal(ROSTER.length, 15);
  assert.equal(ROSTER.filter(p => p.g === 'M').length, 12);
  assert.equal(ROSTER.filter(p => p.g === 'F').length, 3);
  assert.deepEqual(LEADS, { A: 149, B: 171, C: 175 });
  assert.equal(new Set(ROSTER.map(p => p.no)).size, 15);
  assert.ok(ROSTER.every(p => Number.isFinite(p.pt) && p.pt >= 0));
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `node --test test/roster.test.js`

Expected: FAIL with `Cannot find module '../public/roster'`.

- [ ] **Step 3: Add the UMD roster module and load it before the inline app script**

```js
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.VoxRoster = value;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ROSTER = Object.freeze([
    { no:149, name:'AR. Jagrut Patel', firm:'Vitan Architects', g:'M', pt:2, lgAvg:89, lgHigh:93, lgM:2, lgStr:null, lgSpr:null, role:'C' },
    { no:171, name:'Mr. Sandeep Sisodiya', firm:'Vox India', g:'M', pt:1, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'VC' },
    { no:175, name:'Mr. Siddharth Bhatt', firm:'Vox India', g:'M', pt:1, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'VC' },
    { no:99, name:'ID. Nayan Mistry', firm:'Hridgata Atelier', g:'M', pt:4, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:31, name:'ID. Shivangi Paradava', firm:'PDC Architects', g:'F', pt:7, lgAvg:115, lgHigh:158, lgM:3, lgStr:3, lgSpr:null, role:'P' },
    { no:22, name:'ID. Pranati Shah', firm:'PV Design Studio', g:'F', pt:10, lgAvg:121, lgHigh:152, lgM:4, lgStr:6, lgSpr:null, role:'P' },
    { no:114, name:'ER. Pratik Vasant', firm:'P.INE Studio', g:'M', pt:6, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:38, name:'AR. Akhil Gajjar', firm:'Verizon Architects', g:'M', pt:10, lgAvg:140, lgHigh:150, lgM:3, lgStr:10, lgSpr:null, role:'P' },
    { no:137, name:'Suraj Gajera', firm:'SV Design Interior', g:'M', pt:3, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:8, name:'AR. Sachi Prajapati', firm:'Verizon Architects', g:'F', pt:2, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:128, name:'AR. Saumil Patel', firm:'Squelette Design', g:'M', pt:4, lgAvg:165, lgHigh:177, lgM:2, lgStr:7, lgSpr:null, role:'P' },
    { no:41, name:'AR. Ankur Sanghvi', firm:'Tranquil Design Wave', g:'M', pt:4, lgAvg:133, lgHigh:145, lgM:3, lgStr:3, lgSpr:null, role:'P' },
    { no:49, name:'AR. Bhavik Nandi', firm:'Associated Architects', g:'M', pt:2, lgAvg:126, lgHigh:151, lgM:3, lgStr:5, lgSpr:null, role:'P' },
    { no:43, name:'AR. Arpan Patel', firm:'Briqmort', g:'M', pt:2, lgAvg:125, lgHigh:142, lgM:4, lgStr:6, lgSpr:null, role:'P' },
    { no:82, name:'AR. Karnav Patel', firm:'Satatya Architects', g:'M', pt:2, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
  ].map(p => Object.freeze(p)));
  const LEADS = Object.freeze({ A: 149, B: 171, C: 175 });
  return { ROSTER, LEADS };
});
```

Add `<script src="/roster.js"></script>` immediately before `/app-core.js`, then bind `const { ROSTER, LEADS } = VoxRoster;`. In `server.js`, replace `ROSTER_NOS`, `ROSTER_INFO`, and `TEAM_LEADS` duplication with:

```js
const { ROSTER, LEADS: TEAM_LEADS } = require('./public/roster');
const ROSTER_NOS = ROSTER.map(p => p.no);
const ROSTER_INFO = ROSTER.map(({ no, g, pt }) => ({ no, g, pt }));
```

- [ ] **Step 4: Run focused and full checks**

Run: `node --test test/roster.test.js && npm test && npm run check`

Expected: all tests and static checks PASS.

- [ ] **Step 5: Commit the shared source**

```bash
git add public/roster.js public/index.html server.js test/roster.test.js
git commit -m "refactor: share tournament roster metadata"
```

### Task 2: Preserve score-stat coverage and optimizer exclusions

**Files:**
- Create: `test/optimizer-api.test.js`
- Modify: `server.js:194-249,584-618,737-783`
- Modify: `public/app-core.js:58-77`
- Modify: `public/index.html:637-643`
- Modify: `test/api.test.js`
- Modify: `test/outbox.test.js`

**Interfaces:**
- Produces game fields `strikesRecorded:boolean`, `sparesRecorded:boolean`, `optimizerIncluded:boolean`, `optimizerExclusionReason:string|null`.
- Produces coach-only route `PUT /api/games/:no/:id/optimizer-status` with body `{ included:boolean, reason?:string }`.
- Legacy numeric strike/spare values normalize to unknown coverage unless explicit flags exist.

- [ ] **Step 1: Add failing persistence and authorization tests**

```js
test('new score records explicit strike and spare coverage', async () => {
  const r = await req('POST', '/api/games', {
    body: { no: 99, score: 150, strikes: 0, spares: 0,
      strikesRecorded: true, sparesRecorded: true }, coachSession
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.game.strikesRecorded, true);
  assert.equal(r.body.game.sparesRecorded, true);
});

test('only a coach can exclude a game and the score remains stored', async () => {
  const game = (await req('POST', '/api/games', {
    body: { no: 99, score: 10 }, coachSession
  })).body.game;
  const playerSession = await claimPlayer(req, coachSession, 99);
  assert.equal((await req('PUT', `/api/games/99/${game.id}/optimizer-status`, {
    body: { included: false, reason: 'possible entry error' }, session: playerSession
  })).status, 401);
  const changed = await req('PUT', `/api/games/99/${game.id}/optimizer-status`, {
    body: { included: false, reason: 'possible entry error' }, coachSession
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.game.optimizerIncluded, false);
});
```

Use the existing invite helpers already present in `test/api.test.js`; if shared setup is needed, move only the claim helper into `test/helpers.js` and import it from both suites.

- [ ] **Step 2: Run focused tests and confirm missing behavior**

Run: `node --test test/optimizer-api.test.js`

Expected: FAIL because coverage flags and the optimizer-status route do not exist.

- [ ] **Step 3: Implement validation, normalization, and the durable route**

Add this shape in `normalize()` and `cleanGame()`:

```js
strikesRecorded: g.strikesRecorded === true,
sparesRecorded: g.sparesRecorded === true,
optimizerIncluded: g.optimizerIncluded !== false,
optimizerExclusionReason: g.optimizerIncluded === false && typeof g.optimizerExclusionReason === 'string'
  ? g.optimizerExclusionReason.slice(0, 160) : null,
```

Accept explicit coverage booleans in `POST /api/games`; set both to `true` for the frame scorer and quick entry only after the user changes or confirms the counters. Add the coach route with a 160-character reason limit and mutate via `saveAndReply()`:

Extend the transient `createScoreEntry()` value with `strikesEntered:false` and `sparesEntered:false`. `adjS('strikes', ...)` and `adjS('spares', ...)` flip the matching flag even when the confirmed count is zero; completed frame-score entry sets both flags true. Send those flags as `strikesRecorded` and `sparesRecorded`, and preserve them in offline outbox payloads and retries.

```js
app.put('/api/games/:no/:id/optimizer-status', async (req, res) => {
  if (!gateCoach(req, res)) return;
  const included = (req.body || {}).included;
  const reason = String((req.body || {}).reason || '').trim();
  if (typeof included !== 'boolean' || reason.length > 160) {
    return res.status(400).json({ error: 'included must be boolean and reason at most 160 characters' });
  }
  await saveAndReply(res, () => {
    const p = P(req.params.no);
    const game = p && p.games.find(g => g.id === req.params.id);
    if (!game) { const e = new Error('unknown game'); e.httpStatus = 404; throw e; }
    game.optimizerIncluded = included;
    game.optimizerExclusionReason = included ? null : (reason || null);
    return game;
  }, game => ({ ok: true, game }));
});
```

- [ ] **Step 4: Verify backup, restore, import, outbox, and regression behavior**

Run: `node --test test/optimizer-api.test.js test/api.test.js test/outbox.test.js test/durability.test.js`

Expected: PASS, including round-trip preservation of all four new fields.

- [ ] **Step 5: Commit game evidence metadata**

```bash
git add server.js public/app-core.js public/index.html test/helpers.js test/optimizer-api.test.js test/api.test.js test/outbox.test.js
git commit -m "feat: track optimizer score evidence"
```

### Task 3: Build the player forecast engine

**Files:**
- Create: `lib/optimizer/forecast.js`
- Create: `test/forecast.test.js`

**Interfaces:**
- Consumes: roster entry, durable player state, ISO evaluation date, and optional model settings.
- Produces: `buildForecasts(roster, players, options)` returning a `Map<number, PlayerForecast>`.
- `PlayerForecast` contains `no`, `mean`, `sd`, `p20`, `p80`, `effectiveN`, `confidence`, `confidenceLabel`, `recencyDays`, `tieBreak`, `warnings`, and `evidence`.

- [ ] **Step 1: Write failing forecast behavior tests**

```js
const { forecastPlayer } = require('../lib/optimizer/forecast');

test('recent evidence outweighs stale evidence and exclusions are ignored', () => {
  const meta = { no: 1, g: 'M', lgAvg: 100, lgM: 4 };
  const player = { no: 1, games: [
    { score: 80, date: '2026-05-01', optimizerIncluded: true },
    { score: 160, date: '2026-07-25', optimizerIncluded: true },
    { score: 300, date: '2026-07-25', optimizerIncluded: false }
  ] };
  const f = forecastPlayer(meta, player, { evaluationDate: '2026-07-26', squadBaseline: 110 });
  assert.ok(f.mean > 110 && f.mean < 160);
  assert.ok(f.p20 < f.mean && f.mean < f.p80);
  assert.ok(!f.evidence.includedScores.includes(300));
});

test('missing tie-break metadata stays unknown', () => {
  const f = forecastPlayer({ no: 1, g: 'F', lgAvg: null, lgM: 0 }, {
    no: 1, games: [{ score: 100, date: '2026-07-25', strikes: 0, spares: 0 }]
  }, { evaluationDate: '2026-07-26', squadBaseline: 100 });
  assert.equal(f.tieBreak.strikeRate, null);
  assert.equal(f.tieBreak.spareRate, null);
  assert.equal(f.tieBreak.coverage, 0);
});
```

Also cover: no data yields a wide bounded forecast; consistent added games narrow `sd`; a fixed date yields stable output; influential scores produce a warning; all percentiles stay in 0–300.

- [ ] **Step 2: Run tests and verify the forecast module is missing**

Run: `node --test test/forecast.test.js`

Expected: FAIL with `Cannot find module '../lib/optimizer/forecast'`.

- [ ] **Step 3: Implement the pure forecast functions**

Export exact functions:

```js
module.exports = {
  MODEL_VERSION: 'forecast-v1',
  DEFAULT_MODEL: Object.freeze({ halfLifeDays: 21, baselineGames: 3, minSd: 8, maxSd: 55 }),
  weightedMoments,
  robustOutlierIds,
  forecastPlayer,
  buildForecasts,
};
```

Use `weight = Math.exp(-Math.LN2 * ageDays / halfLifeDays)`, blend prior-season evidence and current weighted evidence with a three-game squad baseline, shrink observed variance toward squad variance for small samples, and compute bounded normal approximations `p20 = mean - 0.8416 * sd` and `p80 = mean + 0.8416 * sd`. Calculate robust flags with median absolute deviation; report IDs only and never remove those games automatically.

Use these exact v1 calculations so results are reproducible: `priorWeight = Math.min(lgM, 6) * 0.75`; `currentWeight = sum(recencyWeights)`; and `mean = (baseline * 3 + lgAvg * priorWeight + weightedCurrentSum) / (3 + priorWeight + currentWeight)`, omitting the prior term when unavailable. Let `varianceWeight = currentWeight / (currentWeight + 5)` and blend current weighted variance with the gender-aware squad variance; use `maxSd` when no personal evidence exists. Set confidence to `clamp((priorWeight + currentWeight) / 12, 0, 1) * recencyFactor * completenessFactor`, where `recencyFactor` is `1` within 21 days and decays with the same half-life, while `completenessFactor` is `1` for score forecasts and is computed separately for tie-break coverage. Use modified z-score `0.6745 * deviation / MAD > 3.5` for influential-game flags, falling back to an absolute 50-pin deviation when MAD is zero.

- [ ] **Step 4: Run forecast tests**

Run: `node --test test/forecast.test.js`

Expected: PASS with deterministic numeric assertions using tolerances no looser than `0.01`.

- [ ] **Step 5: Commit the forecast engine**

```bash
git add lib/optimizer/forecast.js test/forecast.test.js
git commit -m "feat: forecast player tournament performance"
```

### Task 4: Exhaustively generate legal team partitions

**Files:**
- Create: `lib/optimizer/legal-teams.js`
- Create: `test/legal-teams.test.js`

**Interfaces:**
- Consumes: `generateLegalPartitions({ roster, capCr, leads, pins, availability })`.
- Produces: `{ partitions, conflict }`, where each partition is `{ A:number[], B:number[], C:number[] }` and `conflict` is `null` or a coach-readable string.

- [ ] **Step 1: Write failing legality and completeness tests**

```js
test('every generated partition obeys official constraints', () => {
  const { partitions, conflict } = generateLegalPartitions({
    roster: ROSTER, capCr: 25, leads: LEADS, pins: {}, availability: {}
  });
  assert.equal(conflict, null);
  assert.ok(partitions.length > 0);
  for (const split of partitions) {
    assert.equal(new Set([...split.A, ...split.B, ...split.C]).size, 15);
    assert.equal(teamSplitError(ROSTER, Object.fromEntries(
      Object.entries(split).flatMap(([team, nos]) => nos.map(no => [no, team]))
    ), 25, LEADS), null);
  }
});

test('impossible pins return a specific conflict and no partial split', () => {
  const r = generateLegalPartitions({
    roster: ROSTER, capCr: 25, leads: LEADS,
    pins: { 149: 'B' }, availability: {}
  });
  assert.deepEqual(r.partitions, []);
  assert.match(r.conflict, /Captain.*A/);
});
```

Add a brute-force count assertion for a small synthetic roster so the recursion cannot silently skip a valid combination.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test test/legal-teams.test.js`

Expected: FAIL because `generateLegalPartitions` is undefined.

- [ ] **Step 3: Implement deterministic exhaustive enumeration**

Validate leadership pins and availability first. Permute the three women across A/B/C, then recursively choose three of the nine non-lead men for A, three of the remaining six for B, and assign the final three to C. Reject cap and pin violations as early as possible. Sort player numbers inside teams and sort partitions by their `A|B|C` numeric key before returning.

```js
module.exports = { generateLegalPartitions, assignmentsOf, partitionKey };
```

Do not return greedy or partial results; `{ partitions: [], conflict }` is the only impossible-result shape.

- [ ] **Step 4: Run legality and existing split validation tests**

Run: `node --test test/legal-teams.test.js test/validation.test.js`

Expected: PASS.

- [ ] **Step 5: Commit exhaustive generation**

```bash
git add lib/optimizer/legal-teams.js test/legal-teams.test.js
git commit -m "feat: enumerate every legal team split"
```

### Task 5: Evaluate tournament downside and select Pareto scenarios

**Files:**
- Create: `lib/optimizer/evaluator.js`
- Create: `test/evaluator.test.js`

**Interfaces:**
- Consumes: `evaluatePartitions(partitions, forecasts, options)` with `seed`, `iterations`, `benchmark`, and stage rules.
- Produces scenario entries with `key`, `assignments`, `teams`, `championshipPotential`, `downsideProtection`, `confidence`, `warnings`, and `explanations`.
- Produces `selectScenarios(evaluations)` returning `{ championshipSafe, aggressive, franchiseBalanced, frontierSize }`.

- [ ] **Step 1: Write failing deterministic and selection tests**

```js
test('same seed returns identical scenario metrics', () => {
  const one = evaluatePartitions(partitions, forecasts, { seed: 'state-123', iterations: 200 });
  const two = evaluatePartitions(partitions, forecasts, { seed: 'state-123', iterations: 200 });
  assert.deepEqual(one, two);
});

test('scenario selectors choose endpoints and normalized Pareto knee', () => {
  const selected = selectScenarios([
    { key: 'fragile', championshipPotential: 100, downsideProtection: 20 },
    { key: 'knee', championshipPotential: 85, downsideProtection: 80 },
    { key: 'flat', championshipPotential: 60, downsideProtection: 100 },
    { key: 'dominated', championshipPotential: 50, downsideProtection: 10 }
  ]);
  assert.equal(selected.aggressive.key, 'fragile');
  assert.equal(selected.franchiseBalanced.key, 'flat');
  assert.equal(selected.championshipSafe.key, 'knee');
  assert.equal(selected.frontierSize, 3);
});
```

Also assert two-game Stage I variance is lower relative to its mean than one-game later rounds, high volatility reduces downside without erasing upside, and missing benchmark data omits all qualification probability fields.

- [ ] **Step 2: Run tests and verify the evaluator is missing**

Run: `node --test test/evaluator.test.js`

Expected: FAIL with `Cannot find module '../lib/optimizer/evaluator'`.

- [ ] **Step 3: Implement seeded sampling, aggregation, and Pareto selection**

Implement a string-seeded PRNG and Box-Muller normal sampler locally; clamp each sampled player game to 0–300. Precompute per-player draws for each iteration, then reuse them across partitions. Default to 750 iterations and these rules:

```js
const DEFAULT_RULES = Object.freeze({
  stageOneGamesPerPlayer: 2,
  laterGamesPerPlayer: 1,
  downsideQuantile: 0.20,
});
```

Define `championshipPotential` as the maximum team later-round P20 and `downsideProtection` as the minimum of each team's Stage I and later-round normalized P20. Remove points dominated on both axes, normalize frontier coordinates to 0–1, and choose the point with minimum Euclidean distance to `(1,1)` for Championship Safe. Break ties by expected total, tie-break coverage, confidence, then lexicographic partition key.

Normalize Stage I by dividing its ten-game team total by ten and later rounds by five before taking the weakest value; retain the unnormalized totals for display. If a benchmark is present, compare only the matching stage totals and attach `qualificationProbability` plus the benchmark source/date to that stage. With no benchmark, do not create the property.

- [ ] **Step 4: Run evaluator tests and a performance budget check**

Run: `node --test test/evaluator.test.js`

Run: `node -e "const e=require('./lib/optimizer/evaluator'); console.time('evaluation'); require('./test/fixtures/full-evaluation').run(e); console.timeEnd('evaluation')"`

Expected: tests PASS and a full fixed-roster evaluation completes within 5 seconds on the development machine. Create `test/fixtures/full-evaluation.js` with deterministic synthetic forecasts for all 15 roster players as part of this step.

- [ ] **Step 5: Commit tournament evaluation**

```bash
git add lib/optimizer/evaluator.js test/evaluator.test.js test/fixtures/full-evaluation.js
git commit -m "feat: rank optimizer scenarios by tournament risk"
```

### Task 6: Add the coach-only evaluation API and stale-result guard

**Files:**
- Create: `lib/optimizer/index.js`
- Modify: `server.js:548-682`
- Modify: `test/optimizer-api.test.js`
- Modify: `test/durability.test.js`

**Interfaces:**
- Consumes: `POST /api/optimizer/evaluate` body `{ pins?, availability?, scenarioMode?, benchmark? }`.
- Produces: `{ modelVersion, evaluationVersion, evaluatedAt, dataQuality, forecasts, recommended, alternatives, unresolvedRules }`.
- Extends `POST /api/teams` body with required `evaluationVersion` when assignments came from an optimizer result.

- [ ] **Step 1: Add failing API contract and security tests**

```js
test('optimizer evaluation is coach-only and strips private state', async () => {
  assert.equal((await req('POST', '/api/optimizer/evaluate', { body: {} })).status, 401);
  const r = await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession });
  assert.equal(r.status, 200);
  assert.equal(r.body.evaluationVersion, (await req('GET', '/api/state', { coachSession })).body.updatedAt);
  const text = JSON.stringify(r.body);
  for (const secret of ['authPin', 'inviteToken', 'sessions']) assert.ok(!text.includes(secret));
  assert.equal('qualificationProbability' in r.body.recommended, false);
});

test('an optimizer assignment cannot apply after state changes', async () => {
  const result = (await req('POST', '/api/optimizer/evaluate', { body: {}, coachSession })).body;
  await req('POST', '/api/games', { body: { no: 99, score: 120 }, coachSession });
  const apply = await req('POST', '/api/teams', {
    body: { assignments: result.recommended.assignments,
      evaluationVersion: result.evaluationVersion }, coachSession
  });
  assert.equal(apply.status, 409);
});
```

Add tests for malformed pins, impossible availability, explicit benchmark provenance/date, deterministic repeated results, and protected-mode 503 behavior.

- [ ] **Step 2: Run the API tests and verify missing route behavior**

Run: `node --test test/optimizer-api.test.js test/durability.test.js`

Expected: FAIL with 404 for the evaluation endpoint and no stale-result rejection.

- [ ] **Step 3: Implement orchestration and safe response shaping**

In `lib/optimizer/index.js`, export:

```js
const { MODEL_VERSION, buildForecasts } = require('./forecast');
const { generateLegalPartitions } = require('./legal-teams');
const { evaluatePartitions, selectScenarios } = require('./evaluator');

const OPTIMIZER_VERSION = 'tournament-v1';

module.exports = {
  OPTIMIZER_VERSION,
  evaluateRoster({ roster, players, capCr, leads, pins, availability,
    evaluationDate, seed, benchmark }) {
    const forecasts = buildForecasts(roster, players, { evaluationDate });
    const generated = generateLegalPartitions({ roster, capCr, leads, pins, availability });
    if (generated.conflict) return { conflict: generated.conflict };
    const evaluations = evaluatePartitions(generated.partitions, forecasts,
      { seed, iterations: 750, benchmark });
    return {
      modelVersion: `${OPTIMIZER_VERSION}+${MODEL_VERSION}`,
      forecasts: [...forecasts.values()],
      scenarios: selectScenarios(evaluations),
    };
  },
};
```

Validate API maps against `ROSTER_NOS`, permit benchmark only as `{ stage, cutoff, source, observedAt }`, and derive the seed from optimizer version plus the immutable evaluation snapshot. Return 409 from `/api/teams` when a supplied numeric `evaluationVersion` differs from `state.updatedAt`; perform the same check again inside the `commit()` callback to close races.

Shape the orchestration result at the route boundary with this stable mapping:

```js
const picked = result.scenarios;
const byMode = {
  'championship-safe': picked.championshipSafe,
  aggressive: picked.aggressive,
  'franchise-balanced': picked.franchiseBalanced,
};
const labels = {
  'championship-safe': 'Championship Safe',
  aggressive: 'Aggressive',
  'franchise-balanced': 'Franchise Balanced',
};
const withScenarioLabel = (scenario, mode) => ({ ...scenario, mode, label: labels[mode] });
const selectedMode = scenarioMode || 'championship-safe';
const requested = byMode[selectedMode];
res.json({
  modelVersion: result.modelVersion,
  evaluationVersion: snapshotUpdatedAt,
  evaluatedAt: evaluationDate,
  dataQuality: result.forecasts.flatMap(f => f.warnings.map(message => ({ no: f.no, message }))),
  forecasts: result.forecasts,
  recommended: withScenarioLabel(requested, selectedMode),
  alternatives: Object.entries(byMode)
    .filter(([mode]) => mode !== selectedMode)
    .map(([mode, scenario]) => withScenarioLabel(scenario, mode)),
  unresolvedRules: ['Stage II says 12 advance while Stage III says 16 teams'],
});
```

Return 422 with the generator conflict when no legal partition exists. After a successful `/api/teams` commit, return `{ ok:true, assignmentVersion:state.updatedAt }` so the client can submit that exact durable version.

- [ ] **Step 4: Run focused and full server tests**

Run: `node --test test/optimizer-api.test.js test/durability.test.js test/validation.test.js && npm test`

Expected: PASS.

- [ ] **Step 5: Commit the evaluation API**

```bash
git add lib/optimizer/index.js server.js test/optimizer-api.test.js test/durability.test.js test/validation.test.js
git commit -m "feat: expose secure tournament optimizer API"
```

### Task 7: Enforce official team-list submission locking

**Files:**
- Create: `test/submission.test.js`
- Modify: `server.js:174-249,548-582,631-681,784-823`
- Modify: `test/api.test.js`
- Modify: `test/validation.test.js`

**Interfaces:**
- Adds durable state `teamSubmission:null|{ submittedAt, submittedBy, assignmentVersion, unlockedAt?, unlockedBy?, unlockReason? }` and `teamSubmissionAudit:[]`.
- Produces `POST /api/teams/submit` with body `{ assignmentVersion }`.
- Produces `POST /api/teams/unlock` with body `{ reason }`; coach authorization is the current administrator authority model.
- All team-changing routes return HTTP 423 with `{ error, submittedAt }` while locked.

- [ ] **Step 1: Write failing lock, race, audit, and restore tests**

```js
test('submitted assignments reject every team mutation until audited unlock', async () => {
  const state = (await req('GET', '/api/state', { coachSession })).body;
  const submitted = await req('POST', '/api/teams/submit', {
    body: { assignmentVersion: state.updatedAt }, coachSession
  });
  assert.equal(submitted.status, 200);
  assert.equal((await req('POST', '/api/teams', {
    body: { assignments: { 149: 'A' } }, coachSession
  })).status, 423);
  assert.equal((await req('PUT', '/api/players/99', {
    body: { team: 'B' }, coachSession
  })).status, 423);
  const unlocked = await req('POST', '/api/teams/unlock', {
    body: { reason: 'Organizer approved correction' }, coachSession
  });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.audit.at(-1).reason, 'Organizer approved correction');
});
```

Also test that incomplete or illegal assignments cannot be submitted, a stale assignment version returns 409, an empty unlock reason returns 400, backup/restore preserves the lock and audit, and reset clears both.

Add a response-privacy assertion: ordinary player `/api/state` responses may contain only `{ submittedAt, assignmentVersion, locked }`, while coach responses may additionally contain the unlock audit. Unlock reasons and prior assignment maps must never be sent to ordinary players.

- [ ] **Step 2: Run the submission tests and verify failure**

Run: `node --test test/submission.test.js`

Expected: FAIL because submission routes and state do not exist.

- [ ] **Step 3: Add normalized state and lock enforcement**

Normalize missing fields without changing old assignments:

```js
teamSubmission: validSubmission(s.teamSubmission) ? s.teamSubmission : null,
teamSubmissionAudit: Array.isArray(s.teamSubmissionAudit)
  ? s.teamSubmissionAudit.filter(validAuditEntry).slice(-100) : [],
```

Before changing `p.team` in both `PUT /api/players/:no` and `POST /api/teams`, reject when `teamSubmission` has `submittedAt` and no later `unlockedAt`. Repeat that check inside the commit callback. Submission validates the complete current split with `teamSplitError()`, then records the authenticated coach identity, timestamp, and current `updatedAt`. Unlock requires a trimmed 5–160 character reason and appends an immutable audit entry containing the prior assignment map.

In `/api/state`, call `authOf(req)` once and shape submission fields by role:

```js
const auth = authOf(req);
const safePlayers = state.players.map(({ authPin, inviteToken, ...rest }) => rest);
const submission = state.teamSubmission && {
  submittedAt: state.teamSubmission.submittedAt,
  assignmentVersion: state.teamSubmission.assignmentVersion,
  locked: !(Number(state.teamSubmission.unlockedAt) > Number(state.teamSubmission.submittedAt)),
};
const coachOnly = auth.isCoach ? { teamSubmissionAudit: state.teamSubmissionAudit } : {};
res.json({ players: safePlayers, settings: state.settings, matchday: state.matchday,
  teamSubmission: submission, ...coachOnly, updatedAt: state.updatedAt, installId: state.installId });
```

- [ ] **Step 4: Run submission, restore, and durability tests**

Run: `node --test test/submission.test.js test/api.test.js test/validation.test.js test/durability.test.js`

Expected: PASS with no mutation acknowledged before its lock/audit state is durable.

- [ ] **Step 5: Commit submission enforcement**

```bash
git add server.js test/submission.test.js test/api.test.js test/validation.test.js test/durability.test.js
git commit -m "feat: lock submitted team assignments"
```

### Task 8: Replace heuristic optimizer UI with scenario comparison

**Files:**
- Create: `test/client-optimizer.test.js`
- Modify: `public/app-core.js:91-119,169-177`
- Modify: `public/index.html:72-93,156-169,463-477,645-655`
- Modify: `scripts/check.js`

**Interfaces:**
- Consumes the Task 6 evaluation response.
- Produces pure helpers `scenarioViewModel(result, selectedKey)`, `forecastWarningLabel(forecast)`, and `submissionLocked(teamSubmission)` from `VoxCore`.
- UI state adds `optimizerResult`, `optimizerBusy`, `optimizerError`, `selectedScenario`, and `forecastNo`.

- [ ] **Step 1: Write failing pure client-helper tests**

```js
const { scenarioViewModel, forecastWarningLabel, submissionLocked } = require('../public/app-core');

test('scenario view model keeps recommendation and alternatives distinct', () => {
  const vm = scenarioViewModel({
    recommended: { key: 'safe', label: 'Championship Safe' },
    alternatives: [{ key: 'attack', label: 'Aggressive' }, { key: 'floor', label: 'Franchise Balanced' }]
  }, 'attack');
  assert.equal(vm.cards.length, 3);
  assert.equal(vm.selected.key, 'attack');
  assert.equal(vm.recommended.key, 'safe');
});

test('submission is locked only before an audited unlock', () => {
  assert.equal(submissionLocked({ submittedAt: 10 }), true);
  assert.equal(submissionLocked({ submittedAt: 10, unlockedAt: 11 }), false);
});
```

- [ ] **Step 2: Run helper tests and verify missing exports**

Run: `node --test test/client-optimizer.test.js`

Expected: FAIL because the helper exports are missing.

- [ ] **Step 3: Implement helpers and coach data loading**

Add the pure functions to `public/app-core.js`. In `public/index.html`, replace `buildTeams()` calls in the optimizer view with one `POST /api/optimizer/evaluate` request on entry and an explicit Refresh analysis action. Store the returned `evaluationVersion`, and apply the selected scenario through:

```js
apiSend('POST', '/api/teams', {
  assignments: scenario.assignments,
  evaluationVersion: S.optimizerResult.evaluationVersion,
});
```

Keep the current team cards visible while evaluation is loading. Never fall back to the old heuristic as if it were an analyzed recommendation.

- [ ] **Step 4: Render scenario cards, explanations, player drawer, and data queue**

Each scenario card must render expected and P20 totals, cap compliance, confidence, tie-break coverage, and the main explanations. Selecting a player opens a drawer with evidence, uncertainty, recency, excluded games, and warnings. The Squad queue groups no data, stale data, influential score, missing tie-break coverage, and unavailable status; wire Exclude/Include to the Task 2 route and refresh analysis after success.

Use textContent or existing `esc()` for all server-derived strings. Disable Apply while locked, stale, busy, or invalid. Render unavailable probabilities as “Opponent cutoff not provided,” never `0%`.

- [ ] **Step 5: Add submission controls and error recovery**

Render “Mark teams submitted” only when the current split is complete and legal. Confirm the no-swap consequence, call `/api/teams/submit` with the current assignment version, and render the returned timestamp. Render audited unlock behind a second confirmation with a required reason. For 409, refresh analysis; for 423, refresh state and show the submission timestamp; for 503, retain the last displayed result but label it unavailable/stale.

- [ ] **Step 6: Run client tests and static checks**

Run: `node --test test/client-optimizer.test.js test/scoring.test.js test/outbox.test.js && npm run check`

Expected: PASS; `scripts/check.js` confirms `roster.js` loads before `app-core.js`, scenario copy exists, no legacy strategy controls remain, and all inline handlers resolve.

- [ ] **Step 7: Commit the coach experience**

```bash
git add public/app-core.js public/index.html scripts/check.js test/client-optimizer.test.js
git commit -m "feat: add coach tournament scenario workspace"
```

### Task 9: Complete regression, browser verification, and operations documentation

**Files:**
- Modify: `README.md`
- Modify: `test/optimizer-api.test.js`
- Modify: `test/submission.test.js`

**Interfaces:**
- Produces an operator-ready Release 1 with documented limitations and recovery behavior.

- [ ] **Step 1: Add end-to-end API workflow coverage**

Add one test that logs representative games, excludes one suspicious game, evaluates, applies Championship Safe, submits, verifies post-submission rejection, unlocks with a reason, and confirms the complete audit survives a server restart using `startServer({ dataDir, keepDataDir: true })`.

```js
assert.equal(evaluation.recommended.label, 'Championship Safe');
assert.equal(applied.status, 200);
assert.equal(submitted.status, 200);
assert.equal(lockedChange.status, 423);
assert.match(unlocked.body.audit.at(-1).reason, /Organizer approved/);
```

- [ ] **Step 2: Run the complete automated verification suite**

Run: `npm test && npm run check`

Expected: every test PASS, no unhandled rejection, and no static-check warning.

- [ ] **Step 3: Perform browser smoke verification at mobile and desktop sizes**

Run the app with an isolated data directory:

```bash
OPTIMIZER_SMOKE_DIR="$(mktemp -d)"
DATA_DIR="$OPTIMIZER_SMOKE_DIR" COACH_PIN="optimizer-smoke-pin" PORT=3000 npm start
```

Verify: coach login; analysis loading; three scenario cards; player drawer; exclusion and re-analysis; apply; stale-result recovery; submit; locked editor; audited unlock; player view remains free of coach-only forecast details. Check both approximately 390×844 and 1440×900 viewports, then stop the server and remove only the printed temporary directory path.

- [ ] **Step 4: Document the coach workflow and model boundaries**

In `README.md`, add exact sections for “Tournament optimizer,” “Score evidence and exclusions,” “Submitting and unlocking team lists,” and “Model limitations.” State that forecasts are advisory, opponent qualification probability is omitted without benchmark data, the PDF’s Stage II/III advancement contradiction is unresolved, and Spirit Award scoring is not implemented until official methodology is supplied.

- [ ] **Step 5: Review the final diff and commit documentation/test closure**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only intended Release 1 files changed.

```bash
git add README.md test/optimizer-api.test.js test/submission.test.js
git commit -m "docs: document tournament optimizer operations"
```

- [ ] **Step 6: Prepare deployment handoff without pushing automatically**

Run: `git log --oneline --decorate -10 && git status --short`

Expected: the worktree is clean and the Release 1 commits are visible. Deployment remains a separate explicit action: push only after reviewing the production diff and confirming that the persistent `/data` volume has a current backup.
