# Optional routing evaluation (VW18)

Jev remains disabled for live task dispatch. This release supplies an offline
benchmark workspace and a bounded suggestion policy. It neither calls TypeSafe
nor collects an API key. Static routing and its existing escalation are unchanged.
A real benefit has **not** been established. Enabling a live classifier requires
measured owner data and a separate, authorized deployment decision.

Settings → Routing evaluation accepts recorded data, compares matched outcomes,
saves immutable reports, reopens them after restart and downloads their evidence.
Its Evaluate action is separate from Save Settings. A browser-tab draft (including
the retry request ID) survives reload; storage failures are visible. Replacing
input requires confirmation. Existing unsaved settings remain intact. Saved
reports live in the application database; imported historical calls are not added
to the live invocation ledger or charged again.

## Collect a defensible comparison

1. Reserve representative development tasks before tuning criteria or confidence.
   Include small edits and larger integration work, frontend, backend, docs and
   operations. Tag tuning examples `calibration`; only `held_out` cases contribute
   to the report. The minimum 12 cases, all difficulties and three categories is
   an exploratory floor, not statistical certification.
2. Freeze the static model choice, candidate eligibility and evaluation policy.
   Candidates should be actual configured model profiles, with harness, context,
   isolated-worker, capacity and reviewer-independence requirements already checked.
   The imported eligibility snapshot is operator evidence; this offline tool cannot
   verify a historical runtime. A future live router must recheck all of those
   constraints at admission, never trust a classifier to grant capabilities.
3. Obtain one recorded Jev Choice response per task using the same pinned response
   version. Record actual classifier cost, duration and tokens, including failures.
   Do not place credentials in the dataset. No provider pricing is assumed here.
4. Independently review actual downstream runs for both the static and selected
   model on equivalent repository revisions, criteria and environment. Record the
   outcome and an evidence reference (run/PR/artifact IDs). Include author work,
   validation and every repair; compare completion quality, not token price alone.
5. Import the data and review unknowns, unacceptable outcomes, fallback reasons,
   allocation, cost, latency, calls and tokens. Retain a fresh held-out set if you
   tune the policy again. A `candidate_for_pilot` report is only a suggestion for
   a bounded separately approved pilot; it does not enable anything automatically.

TypeSafe's documented request is a POST to `https://api.typesafe.ai/v1/systemone`
with `state`, a model selector and `questions.route` of type `choice`; criteria
map candidate IDs to descriptions. The response contains `answers.route.choice`,
confidence/probabilities, a response model version and token usage. See the
[official quickstart](https://docs.typesafe.ai/introduction/quickstart) and
[Choice contract](https://docs.typesafe.ai/primitives/choice). Confidence is a
0–1 distribution statistic, not a measured probability of successful software
completion; choose thresholds using domain evidence
([TypeSafe confidence](https://docs.typesafe.ai/confidence)). Sources reviewed
2026-09-21. No SDK or plugin installation is required for offline replay.

## Dataset version 1

Use Load synthetic example, then Download input for a complete editable JSON
format. `packages/types/src/routing-evaluation.ts` is canonical.

- Metadata: `version: 1`, name, provenance (`synthetic|observed`), methodology.
  Observed provenance and evidence references are **operator-supplied assertions**,
  not independently authenticated by this application.
- Policy: `minConfidence` (0–1), `maxClassifierCostUsd` (0–10),
  `maxClassifierLatencyMs` (0–60000). Limits apply to each recorded suggestion.
- Each case has a unique ID, brief, category, difficulty, split, 1–12 unique
  candidates with eligibility booleans, and an eligible `staticModel` fallback.
- Classification: status (`ok|unavailable|timeout`), original response (unknown
  shape allowed so malformed-output fallback is testable), `costUsd`, durationMs,
  tokens, evidence. The response question must be named `route`.
- Outcomes map candidate IDs to `initialCostUsd`, `validationCostUsd`,
  `repairCostUsd`, tokens, calls, durationMs, acceptable and evidence. Costs are
  disjoint: initial author work, initial validation, then **all** repair costs.
  Tokens/calls/duration include the entire downstream attempt and its repairs.
  Acceptable means the independently reviewed result meets the original brief.
- Explicit `null` means an unknown metric. Missing numeric fields, negative or
  non-finite values, duplicate IDs, unknown candidate outcomes and extra command
  fields are refused. Unknown outcome rows are permitted and mark the comparison
  incomplete. A real zero subscription dollar cost remains zero, while tokens
  and calls still expose resource consumption.

Limits: 512 KB normalized input, 1–100 cases, 4000-character briefs/methodology,
500-character evidence references, 24 nesting levels and 20000 JSON values. The
HTTP body limit is 550 KB. No imported
text is executed, fetched as a URL, attached to model context or allowed to
alter routing/settings. Evidence references are displayed as text.

## Policy and report interpretation

One pure policy decision is made per held-out case. Unavailable, timeout,
over-budget/unknown classifier cost, malformed response, low confidence or an
ineligible suggestion selects exactly the declared static fallback and records
why. There is no recursive classifier retry. A valid response requires a bounded
Jev model identifier, Choice fields, finite confidence, token counts and a
probability distribution over the eligible candidates. Unverified plugin/MCP
capabilities can never be granted by the suggestion.

Only complete matched cases contribute to allocation totals. The report separately
shows the held-out/compared counts, all reported classifier cost and unknown cost
count. A proposed total adds classifier cost, tokens, one routing attempt and its
latency to downstream execution. It includes repairs on both sides. Calls/attempts
are resource observations, not a new invoice. Assignment counts are task choices,
not estimates of unused subscription quota. Mixed/unknown/unpinned response model
versions cannot support a pilot recommendation.

Reports return one of:

- `insufficient_evidence`: synthetic, incomplete, unrepresentative, missing
  methodology or unpinned/mixed response-version evidence.
- `keep_static`: no net dollar savings, increased total observed latency or any
  unacceptable proposed outcome. Cheap failures cannot satisfy the gate.
- `candidate_for_pilot`: the imported matched sample meets those exploratory
  gates. Sample bias, evidence authenticity and statistical power still require
  operator review. `liveRoutingEnabled` is always false.

The shipped synthetic fixture has 12 held-out cases. Static cost is $6.0000;
proposed cost is $6.0120 including $0.0120 classifier overhead and $2.4000 repairs.
Eight choices use the illustrative economy profile; four low-confidence choices
fall back to the strong profile. It deliberately demonstrates repairs erasing
initial savings. These are fabricated values, not a Jev pricing/quality result.

## Persistence and remaining commissioning

`routing_evaluations` stores the UUID request ID, canonical dataset SHA-256,
evaluator version, exact normalized input and result in one transaction. A
retry with the same ID/data returns the original report even after a restart;
different input under that ID returns 409. No record is silently overwritten.
The list shows the most recent 50; direct lookup by ID retains access to older
records. Creation refuses at 200 reports, preserving prior evidence for export
and operator maintenance. Fresh schema and additive migration are idempotent.

Focused tests cover policy refusal, repairs/failure/latency/unknown costs,
subscription zeros, report retry/restart and HTTP bounds. Browser checks cover
input/error/retry/confirmation, reload, download and five widths. A real measured
Jev comparison, authorized provider calls and live scheduling integration remain
conditional follow-up work after suitable evidence. AWS is separately
owner-deferred; no deployment or login was attempted.
