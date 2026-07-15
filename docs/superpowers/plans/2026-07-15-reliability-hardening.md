# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make score submission reliable under duplicate taps, reloads, and poor connectivity while rejecting invalid recovery and match data.

**Architecture:** Add small, testable browser helpers to `public/app-core.js`, wire them into the existing single-page client, and enforce data invariants at the Express API boundary. Keep the current static frontend and JSON persistence model unchanged.

**Tech Stack:** Node.js 18+, Express 4, browser JavaScript, `node:test`, localStorage durable outbox.

## Global Constraints

- No visual redesign, role redesign, database migration, or new runtime dependency.
- A score is reported saved only after server acknowledgement or durable local queuing.
- Offline resume requires both the stored player session and its matching local identity binding.
- Server validation failures return HTTP 400 and do not mutate state.
- Work only on `codex/reliability-hardening`; never write directly to remote `main`.

---

### Task 1: Testable client reliability primitives

**Files:**
- Modify: `public/app-core.js`
- Modify: `test/scoring.test.js`

**Interfaces:**
- Produces: `createScoreEntry()`, `updateScoreEntry(entry, patch)`, `beginScoreSubmission(entry, makeId)`, `endScoreSubmission(entry)`, `localDate(date)`, `offlineSessionIdentity(session, binding, knownNos)`, and `fetchWithTimeout(fetchImpl, url, options, timeoutMs)`.
- Consumes: existing CommonJS/browser UMD export and the browser `AbortController` implementation.

- [ ] **Step 1: Write failing client-helper tests**

Add tests demonstrating that an entered zero is valid, a second concurrent begin is rejected, an unchanged retry reuses its client ID, edits clear the ID, local calendar fields produce `YYYY-MM-DD`, mismatched offline bindings are rejected, and a stalled fetch aborts.

```js
test('score submission is single-flight and reuses its id on retry', () => {
  const entered = updateScoreEntry(createScoreEntry(), { score: 140 });
  const first = beginScoreSubmission(entered, () => 'score-1');
  assert.equal(first.ok, true);
  assert.equal(beginScoreSubmission(first.entry, () => 'score-2').ok, false);
  const retry = beginScoreSubmission(endScoreSubmission(first.entry), () => 'score-2');
  assert.equal(retry.clientId, 'score-1');
});

test('an explicitly entered zero is submittable', () => {
  const entered = updateScoreEntry(createScoreEntry(), { score: 0 });
  assert.equal(beginScoreSubmission(entered, () => 'gutter-1').ok, true);
});
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run: `node --test test/scoring.test.js`

Expected: FAIL because the new helper exports do not exist.

- [ ] **Step 3: Implement the minimal helpers**

Add pure state helpers that preserve a stable client ID until the entry changes, plus local-date, offline-binding, and fetch-timeout helpers. Export them from the existing UMD factory.

```js
function beginScoreSubmission(entry, makeId) {
  if (!entry || !entry.entered || entry.submitting) return { ok: false, entry };
  const next = Object.assign({}, entry, {
    clientId: entry.clientId || makeId(),
    submitting: true,
  });
  return { ok: true, entry: next, clientId: next.clientId };
}
```

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run: `node --test test/scoring.test.js`

Expected: all scorer and helper tests pass.

- [ ] **Step 5: Commit the client primitives**

```bash
git add public/app-core.js test/scoring.test.js
git commit -m "test: define reliable score submission state"
```

### Task 2: Server-side data invariants

**Files:**
- Create: `test/validation.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: existing `/api/mytarget`, `/api/players/:no`, `/api/restore`, `/api/teams`, and `/api/matchday` endpoints.
- Produces: HTTP 400 validation for out-of-range numeric fields, duplicate restore players, and cross-team match entries.

- [ ] **Step 1: Write isolated failing API tests**

Use a fresh temporary server per test and assert that invalid requests leave state unchanged.

```js
test('targets and estimated averages stay within bowling bounds', async () => {
  await withServer(async ({ req, coachSession }) => {
    assert.equal((await req('POST', '/api/mytarget', {
      body: { no: 149, target: -25 }, coachSession,
    })).status, 400);
    assert.equal((await req('PUT', '/api/players/149', {
      body: { estAvg: 301 }, coachSession,
    })).status, 400);
  });
});

test('restore rejects duplicate roster numbers', async () => {
  await withServer(async ({ req, coachSession }) => {
    const r = await req('POST', '/api/restore', {
      body: { players: [{ no: 149, games: [] }, { no: 149, games: [] }] },
      coachSession,
    });
    assert.equal(r.status, 400);
  });
});
```

- [ ] **Step 2: Run validation tests and verify RED**

Run: `node --test test/validation.test.js`

Expected: FAIL because the current endpoints accept these malformed requests.

- [ ] **Step 3: Add boundary validation before mutation**

Validate `target` as null or integer 0–300 and `estAvg` as null or finite number 0–300. Track roster numbers while validating a backup. Before a match-day write, require `P(no).team === team`.

```js
const clearValue = v => v === null || v === '';
const validTarget = v => clearValue(v) || intIn(v, 0, 300);
const validEstimate = v => clearValue(v) ||
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 300);
```

- [ ] **Step 4: Run validation tests and verify GREEN**

Run: `node --test test/validation.test.js`

Expected: all new validation tests pass.

- [ ] **Step 5: Run the existing API suite**

Run: `node --test test/api.test.js`

Expected: all existing API tests pass after assigning player 149 to team A before the match-day case.

- [ ] **Step 6: Commit server invariants**

```bash
git add server.js test/validation.test.js test/api.test.js
git commit -m "fix: reject invalid team data"
```

### Task 3: Wire resilient player and coach logging

**Files:**
- Modify: `public/index.html`
- Create: `public/sw.js`
- Modify: `scripts/check.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Consumes: all Task 1 helpers and the existing localStorage session/outbox keys.
- Produces: single-flight score saves, valid zero-score logs, local dates, timed requests, photo-frame state transfer, secure offline resume, and guarded coach session saves.

- [ ] **Step 1: Add a failing static integration assertion**

Extend the static-app API test to require the helper names and session-binding key in the served HTML.

```js
assert.match(html, /beginScoreSubmission/);
assert.match(html, /offlineSessionIdentity/);
assert.match(html, /vox_v3_session_binding/);
assert.match(html, /fetchWithTimeout/);
```

- [ ] **Step 2: Run the static integration test and verify RED**

Run: `node --test --test-name-pattern="static app" test/api.test.js`

Expected: FAIL because `public/index.html` is not wired to the helpers.

- [ ] **Step 3: Wire score state and submission guards**

Initialize entries with `createScoreEntry()`, update them with `updateScoreEntry()`, begin saves with `beginScoreSubmission()`, and clear only `submitting` after a rejected request. Disable the save button while submitting. Preserve the first client ID through retry and outbox insertion. Use score-map key presence so coach session score `0` is saved, and add an equivalent session `saving` guard.

- [ ] **Step 4: Wire local dates, request timeouts, photo frames, and offline resume**

Use `localDate()` for game/session dates and `fetchWithTimeout()` for API calls. Store `{ session, no, isCoach }` under `vox_v3_session_binding` on successful player authentication; clear it on sign-out/expiry. Cache only the static app shell with a service worker, leaving `/api/` requests uncached. On a network-only boot failure, enter cached player mode only when `offlineSessionIdentity()` confirms the binding. Copy the derived frame total/strikes/spares into `S.entry` after photo recognition.

- [ ] **Step 5: Run client integration and syntax checks**

Run: `node --test --test-name-pattern="static app" test/api.test.js`

Expected: PASS.

Run: `npm run check`

Expected: all server, client, test, and inline-script syntax checks pass.

- [ ] **Step 6: Commit browser integration**

```bash
git add public/index.html test/api.test.js
git commit -m "fix: harden score logging offline"
```

### Task 4: Full verification and delivery

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-reliability-hardening.md`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified branch, pushed GitHub branch, and mergeable pull request.

- [ ] **Step 1: Run the complete checks**

Run: `npm run check`

Expected: all files pass syntax checks.

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm audit --omit=dev`

Expected: zero known production vulnerabilities.

- [ ] **Step 2: Review the final diff**

Run: `git diff --check origin/main...HEAD`

Expected: no whitespace errors.

Run: `git status --short`

Expected: clean worktree after the plan checklist is committed.

- [ ] **Step 3: Commit plan completion**

Mark all plan checkboxes complete, then run:

```bash
git add docs/superpowers/plans/2026-07-15-reliability-hardening.md
git commit -m "docs: complete reliability hardening plan"
```

- [ ] **Step 4: Push and open the pull request**

```bash
git push -u origin codex/reliability-hardening
gh pr create --base main --head codex/reliability-hardening --title "Harden score logging and data validation" --body-file <prepared-pr-body>
```

Expected: GitHub returns a pull-request URL ready for review and merge.
