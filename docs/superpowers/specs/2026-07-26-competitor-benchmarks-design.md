# Competitor Benchmarks Design

## Goal

Give captains and coaches an honest, stage-aware way to compare VOX A/B/C with observed competitor results without inventing opponent probabilities.

## Scope

- Coach-only management of competitor observations: franchise, optional sub-team, stage, score, source, and observation date.
- Persistent observations in the existing JSON state and backup/restore flow.
- Stage I (10-game) and later-round (5-game) comparisons using the optimizer's P20, expected, and P80 totals.
- Rank range and field position derived from observed scores.
- Explicit confidence labels: `confirmed` for named sub-team observations, `provisional` for franchise-only observations, and `historical` for the existing embedded averages.
- Players retain the existing historical Form view; private competitor observations remain coach-only.

## Data and validation

Each observation is `{id, franchise, team, stage, score, source, observedAt, createdAt}`. `team` is `A`, `B`, `C`, or null; `stage` is `stageOne` or `later`; scores are integers from 0–3000 for Stage I and 0–1500 for later rounds. Text is trimmed and length-limited. The server generates IDs and timestamps.

## Comparison semantics

The coach chooses a stage. For each optimized VOX team, the UI compares P20/expected/P80 against all observations for that stage. It reports the expected rank among observed teams and a rank interval bounded by the VOX upside and downside. These are scenario comparisons, not win probabilities. A cutoff comparison is shown only when a sourced benchmark exists.

## UI

Add a compact “Competitors & benchmarks” section below the optimizer. It contains a stage selector, three VOX comparison cards, an observation list, and an add-observation form. Empty state copy explains what data to enter. Destructive removal requires confirmation.

## Safety and testing

All write routes require coach authentication. API tests cover authorization, validation, persistence, state privacy, and deletion. Pure comparison tests cover ranking and empty datasets. Client smoke checks assert that the controls and semantics remain wired.
