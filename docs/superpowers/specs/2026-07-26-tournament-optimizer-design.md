# Tournament Optimizer Upgrade Design

Date: 2026-07-26

## Objective

Upgrade the Coach Optimizer so it recommends three legal VOX STARS sub-teams that maximize championship potential while protecting against a fragile weakest team. Recommendations must be derived from the current score database, explainable to captains, and explicitly uncertain when player or opponent data is incomplete.

The optimizer remains advisory. It never changes team assignments until an authorized coach reviews and applies a recommendation.

## Verified Tournament Rules

The design is based on `DIB Ahemdabad S2 - R&R.pdf` and the June 30, 2026 WhatsApp amendments supplied by the captain.

- The master squad contains 15 players: 12 men and 3 women.
- The franchise must nominate teams A, B, and C.
- Each sub-team contains exactly five players: four men and one woman.
- The Captain and two Vice-Captains must be on separate teams.
- A player may appear in only one sub-team.
- Each sub-team has an independent maximum Base Value of 25 Crore Points.
- A player's Base Value is the final auction price. A replacement inherits the replaced player's auction value.
- No internal swaps are permitted after submission.
- Stage I has three groups of 12 teams. Each player bowls two games, for ten team games total.
- The top six teams in each group advance directly. Teams ranked seventh through tenth enter the Wild Card.
- The Wild Card uses one game per player; the top six advance.
- Subsequent stages use one fresh game per player, and previous-stage scores do not carry forward.
- Ranking tie-breaks are strikes, spares, woman-player score, a one-male/one-woman tie-break, and sudden death where applicable.
- Teams have 50 minutes to complete a five-game set.
- A player bowling another player's turn incurs a 50-point penalty.

The source PDF contains an unresolved contradiction: Stage II says the top 12 of 24 advance, while Stage III says it contains 16 teams. The optimizer will default to the more conservative top-12 interpretation and expose this rule as an administrator setting rather than hardcoding it.

The Spirit of IncrediBowl scoring methodology is not yet known. The first release will show franchise depth but will not claim to calculate the award.

## Current Data Findings

The live coach backup reviewed on 2026-07-26 contains practice data for 13 of 15 players.

- Siddharth Bhatt and Karnav Patel have no current practice games.
- Practice samples range from four to 24 games.
- Several promising averages have limited or volatile evidence.
- Arpan Patel currently has a notably stable practice record.
- Pratik Vasant and Nayan Mistry have comparatively useful sample sizes.
- Shivangi Paradava has the strongest-supported current female forecast.
- Sandeep Sisodiya has a recorded score of 10 that should be reviewed as a possible entry error.
- Strike and spare fields are incomplete for multiple players and cannot yet be treated as measured zeros.

These observations are snapshots, not hardcoded player judgments. All ratings are recalculated from the current database whenever the optimizer runs.

## Recommended Product Approach

Combine an exhaustive tournament simulator with a coach-facing scenario comparison.

1. Generate every legal partition of the 15-player roster.
2. Forecast a score distribution for each player from prior-season and current practice data.
3. Evaluate every partition under Stage I and single-game later-round conditions.
4. Remove dominated partitions and present three scenarios from the remaining Pareto frontier.
5. Explain the recommendation and its uncertainty.
6. Require explicit coach action before applying assignments.

This is preferred over a single weighted-average formula because later rounds reset scores and depend on only one game per player. Variance and downside therefore matter materially.

## Architecture

Move forecasting and optimization out of the inline browser script into independently tested server modules.

### Shared roster source

Create one roster module containing immutable tournament metadata:

- player number and display identity
- gender
- role
- auction Base Value
- prior-season average, game count, high score, strikes, and spares

The server and browser consume the same source so rule enforcement and displayed values cannot drift.

### Forecast engine

The forecast engine accepts player metadata, practice games, the evaluation date, and model settings. It returns derived values only; forecasts are never persisted as facts.

### Legal-team generator

The generator enumerates assignments while enforcing:

- five players per team
- four men and one woman
- separated Captain and Vice-Captains
- Base Value cap
- unique player assignment
- availability
- coach pins

Invalid pins return a clear conflict instead of an incomplete or illegal split.

### Tournament evaluator

The evaluator receives player forecasts, legal partitions, tournament rules, and optional opponent benchmarks. It produces scenario metrics and explanations.

### API

Add a coach-only endpoint:

`POST /api/optimizer/evaluate`

Request fields:

- optional pinned assignments
- optional availability overrides
- scenario mode, defaulting to `championship-safe`
- optional opponent or cutoff benchmarks

Response fields:

- model version and evaluation timestamp
- data-quality warnings
- per-player forecasts
- recommended scenario and two alternatives
- team metrics and assignment explanations
- unresolved rules affecting interpretation

Applying a split continues through the existing `POST /api/teams` endpoint.

The team-assignment state also gains a submission record containing `submittedAt`,
`submittedBy`, and the assignment version. Once a coach marks the three-team list
as submitted, `POST /api/teams` rejects further assignment changes. An
administrator may unlock the list only to correct an organizer-approved issue;
the reason, actor, timestamp, and prior assignment version are retained in an
audit entry.

## Player Forecast Model

Each player forecast contains:

- expected next-game score
- downside score
- upside score
- volatility
- confidence
- recency status
- strike/spare coverage and rates when usable
- warnings

### Expected score

Use an empirical-Bayes blend:

- prior-season games act as historical evidence rather than a permanent fixed weight
- current practice games receive recency weighting
- the prior influence declines as reliable current games accumulate
- players with no personal evidence begin from a gender-aware squad baseline or coach estimate, with wide uncertainty

The default recency half-life is 21 days and is model configuration, not a coach-facing tuning control in the first release.

### Volatility

Use the player's observed variation when the sample is sufficient. For small samples, shrink variation toward the squad distribution so four games cannot falsely imply extreme consistency or volatility.

Predicted scores are bounded to the legal bowling range of 0 through 300.

### Downside and upside

Report the 20th and 80th percentiles of the predictive distribution. Historical minimum and maximum are displayed separately and are not used as forecasts.

### Confidence

Confidence is derived continuously from effective sample size, recency, and data completeness. UI labels map the result to Low, Developing, or Reliable without changing the underlying calculation.

### Data quality

No score is automatically removed. A robust median-deviation check identifies unusually influential games for review.

Add coach-only optimization status to a game:

- included by default
- excluded from optimizer
- optional exclusion reason

Excluded games remain visible, auditable, exportable, restorable, and usable in ordinary player history unless the product later introduces a separate correction workflow.

Missing strike/spare values must be represented as unknown. Legacy numeric zeros cannot safely distinguish a measured zero from missing metadata, so the schema gains explicit `strikesRecorded` and `sparesRecorded` flags for new entries. Tie-break forecasts use only recorded observations and display coverage.

## Tournament Evaluation

For each legal partition, run deterministic seeded simulations so the same database and model version produce stable recommendations.

### Stage I

Simulate two games per player and sum all ten results. Report expected, downside, and upside totals.

### Wild Card and later rounds

Simulate one game per player. These results receive greater downside emphasis because one poor player game has no second-game recovery opportunity.

### Tie-breaks

Simulate strikes, spares, and woman-player scores only when coverage is adequate. Otherwise report tie-break data as low confidence and do not allow missing metadata to produce a false disadvantage.

### Opponent benchmarks

Without reliable opponent distributions, show relative strength among legal VOX partitions rather than fabricated qualification probabilities.

Administrators may add stage cutoff benchmarks with provenance and date. When benchmarks exist, the evaluator may show estimated probabilities of clearing them, labelled as estimates.

## Scenario Selection

Build a Pareto frontier using two primary measures:

- championship potential: the strongest team's downside-adjusted later-round total
- downside protection: the weakest team's downside-adjusted Stage I and single-round totals

Partitions worse on both measures are discarded.

Present three scenarios:

### Championship Safe - default

Select the knee of the Pareto frontier: the partition closest to the ideal combination of championship potential and weakest-team protection after normalizing both axes. This avoids exposing arbitrary weights to coaches.

### Aggressive

Select the frontier endpoint with the highest strongest-team championship potential.

### Franchise Balanced

Select the frontier endpoint with the highest weakest-team protection.

Use expected totals, tie-break coverage, and confidence as secondary ordering criteria when primary metrics are effectively equal.

## Coach Experience

### Optimizer overview

Replace the existing Powerhouse/Balanced/Tiered control with:

- Championship Safe
- Aggressive
- Franchise Balanced

Each scenario card shows:

- expected and conservative team totals
- later-round downside
- confidence
- Base Value and rule compliance
- tie-break coverage
- primary assignment rationale
- warnings that materially affect the recommendation

### Player forecast drawer

Selecting a player shows:

- prior-season baseline
- recent weighted form
- practice sample count and recency
- score range and volatility
- included/excluded games
- strike/spare coverage
- what additional data would most improve confidence

### Data-quality queue

The Squad page gains a compact coach-only queue:

- no practice data
- stale practice data
- unusually influential score
- missing strike/spare tracking
- unavailable player

Actions are Review, Nudge, Log for them, and Exclude/Include for optimizer.

### Scenario comparison

Show the three scenarios side by side on wide screens and as swipeable cards on mobile. Highlight the recommendation but allow the coach to inspect all differences before applying.

### Submission lock

After applying and reviewing all three teams, a coach can mark the complete list
as submitted. The confirmation clearly states that organizer rules prohibit
internal swaps afterward. Submitted lists become read-only across the optimizer
and existing team editor, with the submission time and assignment version shown.

### Explanation language

Use plain statements such as:

- “Arpan raises Team B's floor because his recent scores are unusually consistent.”
- “Bhavik raises Team A's upside, but the estimate has high volatility.”
- “Siddharth has no practice data, so Team C's forecast range is wide.”

Do not claim certainty or use unexplained model jargon.

## Match Day Upgrade - second release

Expand Match Day from qualifier-only storage into stage-aware rounds:

- Stage I
- Wild Card
- Stage II
- Stage III
- Finale
- tie-break and sudden-death records

Each stage stores its own games, fresh totals, tie-break metrics, rank/cutoff status, and optional 50-minute timer. Add foul-play penalties as explicit entries rather than editing raw scores.

The first optimizer release does not depend on this redesign.

## Administrator Rules Panel - second release

Add versioned tournament settings for:

- team count and size
- gender composition
- Base Value cap
- fixed leadership separation
- games per player by stage
- advancement counts
- tie-break order
- replacement deadlines and deduction schedules
- 50-minute limit and penalties
- opponent/cutoff benchmarks with provenance
- Spirit Award rules when announced

Rule changes create a new version. Existing match-day records retain the rule version under which they were entered.

## Error Handling

- If the store is degraded, optimizer endpoints return the existing protected-mode response.
- If pins make all legal partitions impossible, return specific conflicting constraints.
- If a forecast has insufficient data, return a wide distribution and warning rather than failing.
- If opponent benchmarks are absent, omit probability claims.
- If simulations exceed their time budget, return deterministic analytical summaries and a warning; never return a partially ranked result as complete.
- Applying a stale scenario requires re-evaluation when `state.updatedAt` differs from the evaluation version.
- Team mutations after submission are rejected unless an administrator has recorded an approved unlock reason.
- Game exclusion mutations use the existing serialized durable commit pipeline.

## Security and Privacy

- Evaluation and game optimization-status changes require coach authorization.
- No session tokens, PIN hashes, invite tokens, or raw backups appear in optimizer responses.
- Ordinary signed-in players continue to see only the existing team-transparency data.
- Forecast explanations avoid exposing private administrative notes.

## Testing

### Forecast unit tests

- no-data player produces a neutral, wide forecast
- additional consistent games increase confidence and narrow uncertainty
- recent games receive more influence than stale games
- small samples are shrunk toward squad priors
- excluded games do not affect forecasts but remain in state
- fixed random seed produces stable outputs
- prediction bounds remain 0 through 300
- missing strike/spare metadata is not counted as zero performance

### Team-generation tests

- every output has three teams of five
- every team has four men and one woman
- Captain and Vice-Captains remain separate
- no player is duplicated or omitted
- every team respects the Base Value cap
- pins and availability are respected
- impossible pins return a useful conflict
- every legal partition is considered for the fixed roster

### Scenario tests

- dominated partitions never appear as recommendations
- Championship Safe selects the Pareto knee deterministically
- Aggressive and Franchise Balanced select the correct endpoints
- high volatility lowers downside metrics without erasing upside
- missing benchmarks suppress qualification probability
- stale evaluations cannot be applied silently
- submitted assignments cannot be changed without an audited administrator unlock

### API and durability tests

- coach-only enforcement
- secrets stripped from responses
- exclusion changes persist atomically
- backup/restore preserves optimization status and rule versions
- failed writes are not acknowledged
- malformed rules and benchmark data are rejected

### Browser smoke tests

- mobile and desktop scenario layouts
- explanation and warning rendering
- pin conflict recovery
- review/exclude/include workflow
- applying a valid split updates the existing team views

## Delivery Plan

### Release 1 - decision quality

- shared roster source
- explicit strike/spare coverage for new games
- forecast engine
- exhaustive legal-team generator
- tournament evaluator
- coach data-quality controls
- three optimizer scenarios
- comparison and explanation UI
- stale-result protection
- coach-confirmed submission lock and audited administrator unlock

### Release 2 - tournament operations

- stage-aware Match Day
- rules panel and versioning
- cutoff benchmark management
- advancement tracking
- timer, penalties, tie-break, and sudden-death support
- Spirit Award calculation after official methodology is available

## Success Criteria

- Every recommendation is legal under the configured rules.
- The same state and model version produce the same recommendation.
- Coaches can understand the main reason for each assignment.
- Missing data widens uncertainty instead of silently becoming average performance.
- No qualification probability is shown without an explicit benchmark.
- A submitted team list cannot be silently changed.
- The optimizer identifies Championship Safe, Aggressive, and Franchise Balanced alternatives from the full legal search space.
- All existing authentication, durability, backup, offline score logging, and team-application tests continue to pass.
