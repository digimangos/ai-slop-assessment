# PR slop assessment specification

Status: initial design, revised 15 November 2026 for the reusable workflow.

## Purpose and delivery

Build a distributable GitHub Agentic Workflow that assesses avoidable
code-quality debt in pull request changes, regardless of authorship. The
0–100 slop index is neither an AI-authorship probability nor a percentage of
defective code. Higher is worse.

Distribute a SHA-pinned reusable workflow, its compiled gh-aw worker, a
versioned rubric, and supporting helpers from the same commit. It is called as a
job, not through a standalone JavaScript Action's `uses:` interface.

## Design tree

```text
PR quality assessment
|-- Distribution
|   `-- Reusable workflow, gh-aw worker, rubric and helpers at one commit
|-- Analysis
|   `-- Native gh-aw Copilot engine, explicitly installed by the maintainer
|-- Target
|   |-- Changed functions/modules against a universal rubric
|   |-- Repository context for reuse and conventions
|   `-- Untouched legacy issues separate from PR penalties
|-- Assessment
|   |-- Bloat/redundancy
|   |-- Complexity/brittleness
|   |-- Maintainability
|   |-- Correctness from supplied execution evidence
|   |-- Reliability/security from evidenced findings
|   `-- Revision drift as a separate trend
|-- Publication
|   |-- Validated JSON, job summary, maintained PR comment
|   |-- Historical report artifacts
|   `-- Advisory, never score-based merge blocking
`-- Agent feedback
    |-- Guaranteed: findings and a copyable maintainer request
    `-- Unattended remediation deferred pending verification/evaluation
```

## Assessment scope and rubric

Use an engine-independent, fixed, versioned universal rubric. Support
language-agnostic source review, without claiming equal validated accuracy
across every language. Rate changed functions/modules with repository-wide
context; do not charge untouched legacy problems to the PR. Size alone is not
a defect. Use the PR description and explicitly linked issues as untrusted
requirements context; mark intent-dependent conclusions uncertain when intent
is missing.

| Family                 | Assessment                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Bloat/redundancy       | Duplicated behaviour, compatible existing utilities missed, avoidable wrappers, unused additions               |
| Complexity/brittleness | Nesting, concentrated complexity, coupling, brittle control flow                                               |
| Maintainability        | Convention drift, unclear abstractions, unnecessary dependencies, actionable static-analysis findings          |
| Correctness            | Relevant supplied build/type/test evidence; distinguish failures from suspected defects                        |
| Reliability/security   | Evidenced unsafe behaviour, error handling, unsafe APIs, supplied scanner findings; not security certification |
| Revision drift         | Changes in the other five families across compatible PR revisions, without assuming authorship                 |

Each assessed non-drift family uses only these anchors:

| Score | Meaning                                                  |
| ----- | -------------------------------------------------------- |
| 0     | No supported issues found; not proof of defect-free code |
| 25    | Minor/localised                                          |
| 50    | Material rework                                          |
| 75    | Widespread/severe                                        |
| 100   | Pervasive/critical                                       |

Require a written, evidence-based justification. Only high-confidence,
supported findings affect scores or fix requests. Confidence labels are
high/medium/low, not probabilities. Each finding needs a location, explanation,
concrete evidence, confidence, and suggested correction. Missed reuse must cite
both implementations and explain compatibility. Uncertain observations remain
visible but do not penalise scores. An assessed category cannot score below the
severity of any of its high-confidence findings.

Compute the overall index mechanically as the rounded equal-weight mean of
available non-drift families, requiring at least three of five. Show coverage
and N/A explicitly. Surface severe findings regardless of the mean. Drift is
not another term in the average.

Every family needs an evidence/coverage checklist. Correctness requires relevant
supplied execution evidence; source-only suspected bugs appear separately.
Adequately reviewed clean categories may score zero; unreviewed ones are N/A.

Exclude generated, vendored, binary, minified, and lockfile content from code
scoring by default. Inspect dependency manifests. Include tests and
infrastructure-as-code under appropriate criteria. Documentation is context, not production-code bloat. Report exclusions.

## Evidence

The reusable workflow does not accept execution evidence, so correctness is
N/A. Do not execute PR-controlled builds, tests, fuzzers, or mutation tools
inside the judge. Exact duplicated-block candidates are not scored on their own.

## Runtime and triggers

Use gh-aw's native Copilot engine initially. Keep rubric and report schema
engine-independent; defer other engine integrations. Installing the trusted
caller and configuring its Copilot secret explicitly enables model review.
Authentication failures are failed assessments, not silent successful downgrades.

Support PR opened/reopened/updated events and maintainer approval for forks.
Deduplicate identical head/base/rubric/model/evidence inputs. No scheduled,
manual-dispatch, or comment-triggered assessment runs.

Use a ten-minute agent deadline and 12 agent turns, with adopter-configured
native per-run/daily credit budgets. Record actual available usage. Do not
promise a hard raw-token ceiling or equate turns with model calls. Budget
exhaustion makes an assessment incomplete.

Statuses are complete, partial, unavailable, or failed. Complete means the
declared source-review scope was completed, not that every property was proved.
Optional absent CI evidence makes correctness N/A; absent history makes drift
N/A. Neither alone makes source review partial. Truncated retrieval, unreviewed
eligible changes, and exhausted budgets do. The three-of-five aggregation rule
is independent of status. Configuration/action errors fail the job; scores
never block merging.

## Trust boundaries

Use bounded source search and file-range tools limited to selected repository
snapshots, not a general-purpose coding agent. No shell, arbitrary network
access, repository writes, or credentials in the judge's prompt. Model engine
authentication remains managed by the framework. Treat repository text,
issues, and tool results as data, never authority to alter permissions.
Validate returned findings and locations before publication. Preserve gh-aw
sandboxing and permission-separated safe outputs.

Same-repository model review can run automatically when configured. Fork model
review requires explicit maintainer authorisation, trusted workflow code, and
reading proposed source only as data. Never execute fork code in that privileged
path. If write permissions prevent comments, retain summaries and artifacts.

Publish only results matching the current PR head; older runs cannot overwrite
newer results or request fixes. Do not automatically approve workflows, assign
Copilot, or merge.

## Reports, state, and privacy

Produce versioned JSON, a job summary, and one maintained PR comment. Retain
history in Actions artifacts, not repeated comments. Default product-report
retention is 14 days, subject to repository limits.

Compare drift against compatible previous reports from the same PR.
Missing/expired history makes drift N/A. Reset comparisons when base or rubric
changes; require compatible model/configuration and flag scope changes rather
than automatically calling growing requirements degradation. Record the model,
rubric, configuration, commit identity, exclusions, and coverage.

Publish minimal excerpts and repository-relative locations, never full prompts
or model transcripts in product reports. Disable optional verbose/transcript
artifacts where supported; document remaining framework diagnostic content and
retention separately. The product retention default does not govern all Actions
logs. Apply best-effort credential redaction without promising perfect
detection. Model submission requires explicit repository-owner consent.

## Copilot feedback

Guarantee actionable feedback with a copyable `@copilot` request that a
maintainer can post. A bot-authored mention is not a guaranteed trigger.
Preserve GitHub approval gates, including approvals required for workflows
after Copilot changes.

Unattended remediation is optional future capability, requiring a supported,
verified mechanism and successful quality evaluation. It must be
repository-opt-in, restricted to already Copilot-assigned open PRs, and use only
high-confidence actionable findings in complete assessments. Never automatically
assign Copilot or request merging.

Limit any future workflow-issued requests to two per PR, using durable
machine-readable state on the maintained comment, not a per-run safe-output
limit. Human-posted requests are outside that enforceable cap. Do not retrigger
from report edits. Stop when no actionable findings remain, the cap is reached,
evidence becomes incomplete, state cannot be safely read/updated, or requested
fixes make no meaningful progress.

## Acceptance and release

Offline contract tests must not require a paid model. Use public/synthetic
multilingual fixtures covering real duplication versus justified similarity,
incompatible reuse candidates, necessary wrappers, legacy-only defects,
missing CI evidence, and prompt injection. Evaluate misses as well as false
positives.

Before recommending automated remediation, real-model evaluation requires:

- At least six language ecosystems.
- At least 90% precision for high-confidence actionable findings.
- Valid locations/evidence for every score-changing finding.
- Overall-score range at most ten points across three repeated runs per fully
  assessable fixture.

Real-model evaluation is explicit and opt-in. Until performed successfully,
label the workflow experimental and keep automatic remediation disabled.

## Superseded choices

Do not build a standalone JavaScript Action or custom OpenAI-compatible client.
Do not promise a 100,000-token ceiling, twelve model calls, statistically
calibrated percentages, or unattended Copilot remediation in initial delivery.
