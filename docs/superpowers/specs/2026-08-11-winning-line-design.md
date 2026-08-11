# Winning Line Design

## Goal

Once the sub-teams are formed, tell the coach what each team must score to win
and turn that into a concrete per-game target for every player — closing the loop
from "here is the team" to "here is your number." Match-day scores stay a record;
this is the forward-looking planning view the coach asked for.

## Scope

- A coach-only "Winning line" card in the Optimizer tab, per sub-team.
- A target 10-game team total ("the line"), suggested from the field and
  adjustable by the coach.
- The team's projected 10-game total and the gap to the line.
- Per-player targets that close the gap by equal lift, each pinnable so the rest
  re-balance, and a one-tap apply that writes every player's `target`.

## Design

### The line

Stage I is a 10-game total per sub-team (5 players x 2 games), so a team's
projected total is `2 x sum(projected per-game averages)` — the same projection
the My Team and team-vs-team views use. The suggested line is the strongest
sub-team the field is expected to field: the highest of (each rival franchise's
top-five averages x 2) and any Stage-I scoreboard totals the coach has entered
under Competitors. Observed totals take precedence over rival-average estimates.
The coach can nudge the line or type an exact number; it is working state, not
persisted, so it never fabricates a stored "cut."

### Per-player targets

To reach a team total `T`, the five per-game averages must sum to `T/2`. The gap
between that and the current projection is spread equally across the players
(each gets the same pin lift over their projection). The coach can pin any
player's target; pinned values are held and the remaining players re-balance to
still meet the line. Targets clamp to 0–300, and the card warns when equal lift
would require a 300 from someone (the line is then unreachable that way).

Applying writes each player's `target` through the existing coach-gated
`PUT /api/players/:no`, so every player immediately sees their team-driven target
on their own card — no new endpoint or stored state.

### Pure module

`public/winning-line.js` (unit-tested) holds `fieldTotalsFromRivals`,
`winningLine`, and `equalLiftTargets`. The client assembles per-player
view-models from the existing `disp`/`teamAvg` helpers and renders the card; all
arithmetic lives in the module.

## Non-goals

- No change to the roster, optimizer engine, or the persisted data model beyond
  the per-player `target` that already exists.
- No qualification probabilities — the line is an explicit, sourced or estimated
  total the coach controls, consistent with the competitor-benchmarks philosophy
  of not inventing opponent odds.

## Test strategy

- `test/winning-line.test.js` covers rival field totals, the line selection,
  equal-lift distribution, on-track detection, pinning/re-balance, and the
  300-ceiling flag.
- Client render and the apply-to-targets flow verified in a real browser; full
  `npm test` and `npm run check` before pushing.

## Acceptance criteria

- The coach sees, per sub-team, the projected total, an adjustable line, the gap,
  and each player's target; pinning a player re-balances the rest.
- Applying sets every player's target and it appears on their individual card.
- New and existing tests pass and the work ships as a mergeable pull request.
