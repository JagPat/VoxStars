# Score Reliability Hardening Design

## Goal

Make score logging dependable in the poor-connectivity conditions of a bowling venue, while rejecting malformed team data before it can affect standings, match results, or recovery.

## Scope

- Make each player score submission single-flight and idempotent across a double tap, a lost response, and offline queuing.
- Permit a deliberately entered score of zero without treating an untouched form as a zero-score game.
- Preserve access to the cached player experience after an offline reload only when a stored session and its bound player identity are both present. Revalidate that session as soon as the network is available; signing out removes the local binding.
- Send the browser-local calendar date for player and coach session logs.
- Time out stalled API calls so the score logger can use its existing durable outbox rather than wait indefinitely.
- Enforce bounded targets and estimated averages, reject duplicate player records in restores, and require a match-day player to belong to the submitted sub-team.
- Carry a photo-derived frame score into the log entry state before saving it.

## Non-goals

- No visual redesign, role redesign, database migration, or change to the existing single-JSON-file deployment model.
- No attempt to validate every possible real-world bowling score from optional quick-entry strike/spare metadata.
- No server-side storage of browser-only offline session state.

## Design

### Score-entry state

The player logger will keep an `entered` flag, a stable `clientId`, and a `submitting` flag in its entry state. A fresh or edited entry clears the client ID; the first save assigns it and marks the form busy before issuing the request. Retrying an unchanged entry reuses that ID, and a network failure queues the same payload. A zero is accepted only after the user has entered a score, adjusted it, or supplied frame data.

The session logger will retain its existing per-player client IDs and gain a submission guard. It will submit every score explicitly entered into its score map, including zero.

### Offline resume and networking

On boot, an unavailable network will not invalidate a stored session. If a cached player identity is bound to that still-present session, the app opens in offline player mode using cached state and can queue a score. It remains visibly local/offline and revalidates with `/api/session` and refreshes state when connectivity returns. Sign-out clears the session and the identity binding, so a signed-out shared device cannot use this fallback.

All API requests use an abort timeout. A timed-out score request follows the existing network-error route into the durable outbox.

### Server invariants

- `target` is either null or an integer from 0 through 300.
- `estAvg` is either null or a finite number from 0 through 300.
- A backup cannot contain the same roster number twice.
- A match-day entry can be written only for a player currently assigned to that sub-team.

## Test strategy

Add API regression tests for invalid targets/estimates, duplicate restore players, and cross-team match entries. Extend scorer/outbox tests as appropriate for zero values. Run syntax checks and the full Node test suite after every implementation task.

## Acceptance criteria

- Repeated Save actions for one unchanged score create or queue one mutation only.
- A completed gutter game is retained by both logging paths.
- An offline reload lets the previously signed-in player queue a score, while a signed-out device cannot resume offline.
- Invalid data receives a 400 response and leaves state unchanged.
- The full test suite passes and the branch is delivered as a mergeable pull request.
