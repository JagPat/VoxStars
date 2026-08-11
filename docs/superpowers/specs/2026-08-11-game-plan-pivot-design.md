# Game Plan Pivot Design

## Goal

Once the sub-teams are formed, the optimizer's job — searching legal splits and
proposing three strategies — is done. Stop giving that stale suggestion the top
of the screen and make the coach tab lead with what matters now: practice and
closing the gap to the winning line. The manual editor also stops being buried
under the AI.

## Scope

- Make the coach "Game plan" tab (formerly "Optimizer") state-aware.
- **Before the teams are formed** (fewer than 15 assigned): the optimizer's
  scenario comparison leads ("Form your teams"), with the by-hand editor and the
  winning-line placeholder below.
- **After the teams are formed**: a coach dashboard ("Game plan") leads with the
  Winning Line, then a Practice pulse, then the by-hand editor and the
  submit/unlock action, with the optimizer scenarios demoted into a collapsed
  "Optimizer & what-if" section.
- Rename the tab from "Optimizer" to "Game plan".

## Design

`optimizerViewHTML()` branches on `teamsFormed()` (all fifteen assigned). The
scenario comparison is extracted into `optimizerScenariosHTML()` so it can be the
primary block in decision mode or the body of the collapsed section in dashboard
mode. `submitUnlockHTML()` and `lockBannerHTML()` are factored out so the
"Mark official list submitted" action stays visible in both modes.

`practicePulseHTML()` is a new compact card shown in dashboard mode: games logged
this week, players needing games, and players improving, plus a short
"needs a nudge" list (fewest games / longest stale) wired to the existing
`nudge` and `logForThem` actions. It reuses `gamesInDays`, `disp`, `trendOf`,
`lastLog`, and `daysAgo`; it adds no new data.

The Winning Line and by-hand editor are the already-shipped components, simply
promoted. Nothing about team legality, the optimizer engine, or persisted state
changes.

## Non-goals

- No change to the optimizer engine, roster, scoring, or data model.
- The optimizer is demoted, not removed — it remains one tap away for comparing
  the committed split against the theoretical best or re-optimizing after a
  change.

## Test strategy

- Existing suites stay green (the change is view-layer only; the client-optimizer
  tests exercise the unchanged pure `app-core` helpers).
- Both states verified in a real browser: decision mode leads with the optimizer;
  dashboard mode leads with the Winning Line and Practice pulse, with the
  optimizer collapsed. `npm run check` and `npm test` before pushing.

## Acceptance criteria

- Before teams are formed, the tab leads with the optimizer and offers the manual
  editor.
- Once all fifteen are assigned, the tab leads with the Winning Line and Practice
  pulse; the optimizer is collapsed; the manual editor and submit action stay
  reachable.
- Existing tests pass and the work ships as a mergeable pull request.
