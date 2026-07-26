# Competitor Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, sourced competitor observations and stage-aware VOX comparison cards.

**Architecture:** Extend the JSON state with normalized competitor observations and coach-only CRUD routes. Keep comparison math in a small pure module, then render its output inside the existing coach optimizer workspace.

**Tech Stack:** Node.js 18+, Express 4, browser JavaScript, Node test runner.

## Global Constraints

- Never expose competitor observations to unauthenticated users or ordinary player sessions.
- Never describe rank ranges as probabilities.
- Preserve backward compatibility with existing state files and backups.

---

### Task 1: Comparison model

**Files:** Create `public/competitor-core.js`; test `test/competitor-core.test.js`.

**Interfaces:** Produce `compareTeamToField(teamStats, observations)` returning expected rank, best/worst rank, field size, and score gap.

- [ ] Write tests for rank ordering, ties, and empty observations.
- [ ] Run `node --test test/competitor-core.test.js` and observe failure because the module is missing.
- [ ] Implement the minimal pure comparison function.
- [ ] Re-run the focused test and commit.

### Task 2: Persistent coach-only observations

**Files:** Modify `server.js`; test `test/competitors-api.test.js`.

**Interfaces:** Add `GET/POST /api/competitors` and `DELETE /api/competitors/:id`; include observations in coach `/api/state`, backups, and restores.

- [ ] Write API tests for authorization, validation, persistence, player privacy, and deletion.
- [ ] Run `node --test test/competitors-api.test.js` and observe the missing-route failures.
- [ ] Add normalization, validation, routes, and backup integration.
- [ ] Re-run the focused test and commit.

### Task 3: Coach comparison UI

**Files:** Modify `public/index.html`; modify `test/client-optimizer.test.js`.

**Interfaces:** Consume coach state `competitorObservations` and optimizer team stage summaries; provide add/remove actions through the new API.

- [ ] Add client assertions for the stage selector, source fields, confidence labels, and non-probabilistic rank language.
- [ ] Run `node --test test/client-optimizer.test.js` and observe failure.
- [ ] Render comparison cards, form, empty state, and observation list; wire create/delete actions.
- [ ] Run the client test and full test suite.

### Task 4: Verification and deployment

**Files:** Modify `README.md` and service-worker cache version if required.

- [ ] Document competitor observation semantics and privacy.
- [ ] Run `npm test` and `npm run check`.
- [ ] Smoke-test the coach flow locally.
- [ ] Review `git diff`, commit, push `main`, and verify `https://vox.vitan.in/api/health`.
