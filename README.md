# PR slop assessment

An experimental **GitHub Agentic Workflow** for reviewing avoidable code-quality
debt in pull requests, regardless of who wrote the code.

Scores range from **0 (no supported issues found) to 100 (worst)**. They are
rubric-based indices, not percentages of AI-generated or defective code.
[SPEC.md](SPEC.md) records the approved product design.

## Pipeline

```mermaid
flowchart TD
    PR[Open or updated PR / manual run] --> Installed{Helpers installed on trusted default branch?}
    Installed -->|No| Bootstrap[Skip with installation summary]
    Installed -->|Yes| Scope[Trusted inventory: freeze head and base SHAs]
    Scope --> Evidence[Validate optional commit-bound CI evidence]
    Evidence --> Mode{Model explicitly enabled and same-repository PR?}
    Mode -->|No| Inventory[Deterministic inventory and exact duplicate candidates]
    Mode -->|Yes| Judge[Sandboxed Copilot: bounded source reads and path discovery]
    Judge --> Detection{Explicit successful threat-detection verdict?}
    Detection -->|No| Reject[Fail closed: no model report]
    Detection -->|Yes| Validate[Separate safe-output job: validate source evidence and coverage]
    Inventory --> Score[Mechanical aggregation and compatible historical drift]
    Validate --> Score
    Score --> Head{Still current PR head and base?}
    Head -->|Yes| Comment[Update one advisory PR comment]
    Head -->|No| Skip[Skip comment publication]
    Score --> Reports[JSON artifact, Markdown summary, job outputs]
    Comment --> Human[Maintainer reviews and optionally posts copyable Copilot request]
```

1. **Inventory** queries the GitHub API using trusted default-branch helpers. It
   freezes the PR head/base, lists changes and exclusions, validates optional CI
   evidence, and retrieves available report history. It never checks out or runs
   proposed code.
2. **Analysis** either stays deterministic or uses gh-aw's native Copilot engine.
   The judge gets only custom path-discovery, source-range, and context tools,
   with shell, editing, built-in GitHub tools, and general outbound access disabled.
   Source-byte reservations and read coverage use shared, atomic state across
   MCP subprocesses; concurrent tool calls cannot reset the one-megabyte budget.
3. **Validation** runs separately from the judge. Exact excerpts must match
   immutable source ranges, findings must overlap changed code, and reviewed
   modules must have been fully read. Missed reuse also requires a base utility
   and compatibility explanation.
4. **Scoring** averages available non-drift families only when at least three
   are assessable. Missing evidence is N/A, never a clean score. Compatible prior
   report artifacts provide per-family drift.
5. **Publication** rechecks the open PR head/base and updates one bot-authored report
   comment. Artifacts and summaries remain available when comments cannot be
   posted. Human-readable reports include a copyable, non-automatic Copilot
   feedback request where appropriate.

## Scoring and evidence

| Family          | What is reviewed                                                       |
| --------------- | ---------------------------------------------------------------------- |
| Redundancy      | Duplicated behaviour, compatible utilities missed, avoidable wrappers  |
| Complexity      | Changed control flow, nesting, coupling, brittleness                   |
| Maintainability | Abstractions, conventions, unnecessary dependencies                    |
| Correctness     | Supplied build, type-check, or test evidence                           |
| Reliability     | Changed error paths and trust boundaries; not a security certification |
| Revision drift  | Compatible historical score deltas, separate from the overall index    |

Category scores use only **0, 25, 50, 75, 100**, with evidence-based explanations.
Medium/low-confidence observations do not penalise scores. High-confidence
findings remain visible even if a low overall average would hide them.

Generated/vendor/binary/minified/lockfile content is excluded by default.
Tests, dependency manifests, and infrastructure-as-code are eligible.
Documentation is context. Sensitive filenames and known credential patterns
receive additional filtering; this is not a guarantee of perfect secret detection.

Deterministic mode reports eligible scope, supplied evidence, and conservative
exact eight-line duplicate candidates among up to twenty changed modules.
Candidates are **not scored**. Passing supplied execution checks can assess the
correctness family, but do not imply untested correctness. Failed checks are
reported as failures, not automatically PR-caused regressions. Without enough
assessable families there is no overall index.

## Install

Requires GitHub.com Actions, Node.js 24 on the runner, and **gh-aw v1.0.1** for
workflow compilation. No production npm dependencies are needed by the helpers.

The initial distribution consists of:

- `.github/workflows/slop-review.md` and its compiled `.lock.yml`;
- `.github/workflows/slop-inventory.yml` for the non-model/fork path;
- all `src/*.mjs` helpers, including the shared state module.

Copy those files into the adopting repository, preserving their paths. Helpers
must be on its **trusted default branch** before the assessment workflows run.
This intentionally does not bootstrap itself by executing helpers from a PR.
Before helpers are installed, inventory exits with an installation summary
instead of failing. Explicit manual inventory runs remain available even when
automatic model review is enabled.
Once this repository is published, gh-aw can install the agentic source using
`gh aw add OWNER/REPOSITORY/slop-review@REF`; the companion deterministic workflow
and helpers must also be copied. A workflow-only installation is not sufficient.

Initially leave `SLOP_MODEL_ENABLED` unset: only deterministic analysis runs.

To opt into model-assisted review:

1. Choose a supported Copilot model and set repository variable `SLOP_MODEL` to
   its explicit model identifier. Pinning the identifier prevents accidental
   comparisons against an unidentified changing default.
2. Configure `COPILOT_GITHUB_TOKEN` using the
   [documented gh-aw authentication setup](https://github.github.com/gh-aw/reference/auth/).
   Organisations with centralised inference billing can instead add
   `copilot-requests: write` to the Markdown frontmatter and recompile.
   The compiled default uses PAT authentication.
3. Review the workflow's inference/diagnostic data exposure and configure native
   per-run/daily credit limits in frontmatter according to the
   [cost-management reference](https://github.github.com/gh-aw/reference/cost-management/).
   No product-specific monetary budget is chosen for you; framework defaults
   still apply unless you set limits. The agent has a ten-minute job deadline and
   twelve turns, not a twelve-model-call or fixed-token guarantee.
4. Set repository variable `SLOP_MODEL_ENABLED` to `true`.

Fork PRs use the deterministic workflow and do not post comments. The initial
implementation deliberately **does not enable privileged model review of forks**.
An authorised fork path remains future work; do not use `pull_request_target`
to check out or execute proposed code.

Manual runs accept `pr_number` and optional `force`. The PR must be open.
Duplicate completed inputs are skipped where compatible artifact history is
available. Historical lookup is bounded to thirty recent report artifacts and
ten pages of comments; missing history leaves drift unavailable.

## Optional configuration and CI results

Set `SLOP_CONFIG_PATH` to a trusted JSON configuration file:

```json
{
  "include": ["generated/hand-maintained/**"],
  "exclude": ["fixtures/vendor/**"]
}
```

Patterns use Node's `path.matchesGlob`. Explicit exclusions win; includes can
override ordinary generated/documentation defaults, but never sensitive-file
protection. The universal scoring rubric and weights are not configurable.

Set `SLOP_EVIDENCE_PATH` to a JSON file made available to the inventory job:

```json
{
  "schema_version": 1,
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "base_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "checks": [
    {
      "name": "unit tests",
      "kind": "tests",
      "result": "failed",
      "provenance": "https://github.com/OWNER/REPOSITORY/actions/runs/123",
      "base_result": "passed",
      "base_provenance": "https://github.com/OWNER/REPOSITORY/actions/runs/122"
    }
  ]
}
```

Supported kinds are `build`, `types`, `tests`, `static-analysis`, and `security`.
Results are `passed`, `failed`, or `unavailable`. Head SHA and HTTPS provenance
are required; comparable base results also require the matching base SHA and
base provenance. Provenance is recorded, not independently attested.

High-confidence correctness findings must name a failed check (`execution_check`)
and explain its connection to the defect (`execution_relevance`). A
`regression: true` claim additionally requires comparable passing base evidence.
A zero correctness score requires every available execution check to pass;
unexplained failures leave that category N/A rather than clean.

The default PR trigger does not guess which CI workflows matter. To assess after
CI, adapt the caller/inventory job to wait for your chosen checks and download
their evidence artifact before `prepare`, or dispatch a run after supplying the
file. Do not load scripts or workflow instructions from that artifact. No
arbitrary log parsing, test execution, mutation testing, or fuzzing is performed.

## Reports and trust

Product artifacts contain `report.json` and `report.md`, with fourteen-day
retention by default (subject to repository limits and gh-aw's configured
retention override). Inventory/read-ledger artifacts have one-day retention.
Product reports never contain full prompts or transcripts. **gh-aw itself
produces diagnostic artifacts/logs**, which may include reviewed source and
engine transcripts; configure their retention and access separately. Product
artifact retention does not control all Actions logs.

Reports record assessed SHAs, model/configuration/rubric, exclusions, evidence,
coverage, and findings. Framework run metadata records inference usage separately.
Deterministic jobs expose `assessment_status`, `overall_score`, and
`assessed_families`; model publication exposes the same step outputs.
Status distinguishes complete source review, partial review, unavailable
assessment, and failed execution. Optional absent CI/history is N/A. A real
configuration/provider/validation error fails the job, not the PR's quality gate.
Do not configure the experimental assessment as a required merge check.

The publishing job receives write permission only after gh-aw's detection gate
and requires an explicit successful detection verdict before reading the draft.
The model does not. Report text escapes injected markup and mentions; feedback
requests appear in a code block for a maintainer to copy. No automatic agent
assignment, workflow approval, fix request, or merge is implemented.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
gh aw compile slop-review --no-check-update --action-mode release \
  --action-tag 0627fdbe4beb5f3b71aa569f8d97150b87f2111a
```

Commit the regenerated lock file alongside workflow edits. The runtime action
pin is the immutable gh-aw v1.0.1 commit. CI runs offline contracts and checks
compilation freshness without invoking a paid model.

This is the **initial implementation**, not an evaluated production judge.
The approved specification also calls for multilingual real-model evaluation,
authorised fork model review, richer bounded retrieval, and robust end-to-end
validation in GitHub. Those are not claimed complete here. Automated remediation
remains disabled until a supported trigger mechanism and the specification's
six-ecosystem precision/stability acceptance gates have been verified.
