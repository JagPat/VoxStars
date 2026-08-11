# Team Management & Standings Design

## Goal

Let the coach build and adjust the three sub-teams directly in the app, and let
everyone read the standings the way the tournament actually scores them —
per sub-team, with the official tie-breaker order (series → strikes → spares →
female score) made explicit. This removes the backup/restore round-trip that was
previously the only way to set an arbitrary team split.

## Scope

- **Manual sub-team editor** in the coach Optimizer tab: a per-player A/B/C
  control with live legality feedback, running per-team base-value totals against
  the cap, and a single save of all fifteen assignments. Read-only once the
  official list is submitted.
- **Grouped leaderboard**: the player Form view's flat 15-player board becomes
  three per-sub-team blocks, each ranked internally, each with a team total,
  keeping the existing By-average / Most-improved toggle within each group.
- **Team-vs-team summary card** at the top of the Form view: each sub-team's
  combined average, projected series, strikes and spares — in tie-breaker order —
  plus the optimizer's per-team tie-break data coverage.
- **Team context on the individual (Me) card**: a player's rank within their own
  sub-team and how their sub-team is tracking against the other two.
- **Match Day scorecard**: the coach match view reorganised so each sub-team's ten
  qualifier games read as one scorecard with a running tie-breaker tally in the
  official order.
- Friendly squad labels (Team 1 = sub-team B, Team 2 = A, Team 3 = C) surfaced
  alongside the app's canonical A/B/C letters where it aids reading.

## Non-goals

- No change to the roster, bowling math, optimizer engine, cap/legality rules, or
  the single-JSON-file deployment model.
- No new write endpoints: the manual editor reuses `POST /api/teams`; Match Day
  reuses `POST /api/matchday`. No server logic changes are required.
- No new persisted state — standings and comparisons are derived at render time
  from existing player, game, and match-day data.

## Design

### Shared standings model (`public/team-standings.js`)

A new UMD module, unit-tested in Node, holds the pure logic shared by the
leaderboard, the comparison card, and the Me-card context. It operates on plain
per-player view-models the caller assembles from the existing helpers
(`disp`, `teamAvg`, `srate`/`sprate`, `seasonStats`), so it stays free of app
globals:

- `groupByTeam(players)` → `{A,B,C}` of the assigned players (unassigned dropped).
- `rankWithinTeam(players, no)` → `{rank, size}` by average within that player's
  sub-team; unranked (no team, or no average) returns `null`.
- `teamStandings(players, opts)` → for each of A/B/C: combined average, projected
  series, total strikes and spares, and passthrough of the optimizer's
  `tieBreakCoverage`, ordered A/B/C. A `compareTeams` helper orders the three by
  the official tie-breakers (series, then strikes, then spares, then female score)
  and returns each team's standing plus its position.

The module never invents strike/spare data: team strike and spare totals reuse
`teamStrikes`/`teamSpares`, whose per-player fallback is already the documented
behaviour, and the card surfaces the optimizer's `tieBreakCoverage` so the coach
sees that only part of the field records strikes at all.

### Manual sub-team editor

A collapsible editor is added to `optimizerViewHTML()`, below the scenario cards.
It seeds its working assignment map from the current `players[].team` (falling
back to the selected scenario when nothing is assigned yet). Each player row has a
three-way A/B/C control; changing one mutates a client-only `S.manualAssign` map
and re-renders. On every change the editor calls `teamSplitError` (the same
validator used by `applySplit` and the server) and shows the returned message or a
green "legal split" state, and it shows each team's running base-value total
against the `capCr` cap. Save is disabled while any error is present and while the
list is locked. Save writes all fifteen assignments through the existing
`coachAction('POST','/api/teams',{assignments})` path — mirroring `applySplit` —
and reflects the result into `players[].team`. When `teamsAreLocked()` the editor
renders read-only with the existing lock banner.

### Grouped leaderboard and comparison card

`competeViewHTML()` gains the comparison card at the top and replaces the single
`squadLbHTML()` board with three grouped blocks built from `groupByTeam` +
`teamStandings`. Each block keeps the existing `S.lbSort` toggle semantics
(By-average / Most-improved) applied within the group, shows the group's total
line, and highlights the viewer's own row. When fewer than fifteen players are
assigned, the view falls back to the current flat board so nothing regresses
before teams are set.

### Individual card context

`meViewHTML()` adds, in the progress section, the player's `rankWithinTeam`
result ("#2 of 5 in Team 1") and a one-line read on how their sub-team sits among
the three (from `compareTeams`), using the same warm card idiom as `seasonCardHTML`.

### Match Day scorecard

`matchDayViewHTML()` is reorganised so the selected sub-team's five players ×
two games read as a single scorecard, with the running tally shown in strict
tie-breaker order: series → strikes → spares → female score. The existing
per-cell score and strikes/spares entry, team switching, share and clear actions,
and the practice/ match separation are preserved.

## Test strategy

- New `test/team-standings.test.js` covers `groupByTeam`, `rankWithinTeam`
  (including ties and unranked players), `teamStandings` totals, and
  `compareTeams` tie-breaker ordering (series, then strikes, then spares, then
  female score) plus the empty/partial-assignment cases.
- Existing suites must stay green: `client-optimizer`, `submission`, and the
  team/validation API tests already exercise `POST /api/teams`, its lock
  behaviour, and `teamSplitError`; the manual editor reuses those paths.
- `npm run check` (syntax) and the full `npm test` run before every push, on the
  same Node 18/20 matrix CI enforces.

## Acceptance criteria

- The coach can set any legal split from the app and save it without a
  backup/restore round-trip; an illegal split cannot be saved and the reason is
  shown live; a submitted list is read-only.
- The Form view shows three per-sub-team blocks and a tie-breaker-ordered
  team-vs-team card, and falls back to the flat board before teams are assigned.
- A player sees their rank within their own sub-team and how it is tracking.
- Match Day reads as one scorecard per sub-team with a tie-breaker-ordered tally.
- New and existing tests pass and the work ships as a mergeable pull request.
