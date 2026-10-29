import { createHash } from "node:crypto";
import path from "node:path";

export const RUBRIC = "slop/v1";
export const FAMILIES = [
  "redundancy",
  "complexity",
  "maintainability",
  "correctness",
  "reliability",
];
export const ANCHORS = [0, 25, 50, 75, 100];
export const CHECKLIST = {
  redundancy: ["changed-behaviour", "reuse-context"],
  complexity: ["changed-control-flow", "coupling-context"],
  maintainability: ["changed-abstractions", "repository-conventions"],
  correctness: ["execution-evidence"],
  reliability: ["changed-error-paths", "trust-boundaries"],
};

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function sourcePath(value) {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\u0000-\u001f\u007f\\]/u.test(value) &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Invalid repository-relative path",
  );
  return value;
}

export function redact(value) {
  return String(value)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
      "$1[REDACTED]",
    );
}

function text(value, label) {
  requireThat(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 4000,
    `Invalid ${label}`,
  );
  return redact(value);
}

export function eligibility(filename, { include = [], exclude = [] } = {}) {
  sourcePath(filename);
  const matches = (patterns) =>
    patterns.some((p) => path.matchesGlob(filename, p));
  if (matches(exclude)) return "configured exclusion";
  if (
    /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|secrets?\.(?:json|ya?ml))$/i.test(
      filename,
    ) ||
    /\.(?:pem|key|p12|pfx)$/i.test(filename)
  )
    return "sensitive file";
  if (matches(include)) return null;
  if (
    /(^|\/)(?:node_modules|vendor|dist|build|generated|coverage|\.git)(\/|$)/.test(
      filename,
    ) ||
    /(?:\.min\.[cm]?js|\.map|\.generated\.[^/]+|\.g\.[^/]+)$/i.test(filename)
  )
    return "generated or vendored";
  if (
    /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i.test(
      filename,
    )
  )
    return "lockfile";
  if (
    /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|exe|dll|so|woff2?|mp[34]|mov)$/i.test(
      filename,
    )
  )
    return "binary";
  if (/\.(?:md|mdx|rst|txt)$/i.test(filename)) return "documentation context";
  return null;
}

export function validateEvidence(input, identity) {
  if (input == null) return null;
  requireThat(
    input.schema_version === 1 &&
      input.head_sha === identity.head_sha &&
      Array.isArray(input.checks) &&
      input.checks.length <= 100,
    "Evidence must use schema_version 1 and match the assessed head SHA",
  );
  const checks = input.checks.map((check) => {
    requireThat(
      ["build", "types", "tests", "static-analysis", "security"].includes(
        check.kind,
      ) && ["passed", "failed", "unavailable"].includes(check.result),
      "Invalid evidence check",
    );
    const provenance = text(check.provenance, "check provenance");
    requireThat(
      /^https:\/\/[^\s]+$/.test(provenance),
      "Evidence provenance must be an HTTPS URL",
    );
    const result = {
      name: text(check.name, "check name"),
      kind: check.kind,
      result: check.result,
      provenance,
    };
    if (check.base_result !== undefined) {
      requireThat(
        input.base_sha === identity.base_sha &&
          ["passed", "failed"].includes(check.base_result) &&
          typeof check.base_provenance === "string" &&
          /^https:\/\/[^\s]+$/.test(check.base_provenance),
        "Comparable base evidence requires the matching SHA and provenance",
      );
      result.base_result = check.base_result;
      result.base_provenance = check.base_provenance;
    }
    return result;
  });
  return { schema_version: 1, head_sha: input.head_sha, checks };
}

export function fingerprint(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function aggregate(categories) {
  const available = FAMILIES.filter((id) =>
    Number.isFinite(categories[id]?.score),
  );
  return {
    score:
      available.length >= 3
        ? Math.round(
            available.reduce((sum, id) => sum + categories[id].score, 0) /
              available.length,
          )
        : null,
    assessed: available.length,
    total: FAMILIES.length,
  };
}

export function deterministicReport(context) {
  const categories = Object.fromEntries(
    FAMILIES.map((id) => [
      id,
      {
        score: null,
        justification: "Semantic assessment unavailable in deterministic mode.",
        checklist: [],
        finding_ids: [],
      },
    ]),
  );
  const execution = context.evidence?.checks.filter(
    (c) =>
      ["build", "types", "tests"].includes(c.kind) &&
      c.result !== "unavailable",
  );
  if (execution?.length && execution.every((c) => c.result === "passed")) {
    categories.correctness = {
      score: 0,
      justification:
        "Supplied execution checks passed. This does not establish untested correctness.",
      checklist: ["execution-evidence"],
      finding_ids: [],
    };
  }
  return {
    schema_version: 1,
    rubric: RUBRIC,
    identity: context.identity,
    model: context.model,
    configuration: context.configuration,
    input_key: context.input_key,
    mode: "deterministic",
    status: context.truncated ? "partial" : "unavailable",
    experimental: true,
    categories,
    overall: aggregate(categories),
    findings: [],
    observations: context.duplicates ?? [],
    evidence: context.evidence,
    scope: context.scope,
    duplicate_scope: context.duplicate_scope ?? null,
    drift: { available: false, reason: "No compatible historical report." },
    remediation: {
      automatic: false,
      reason: "Maintainer-mediated feedback only.",
    },
  };
}

export async function validateAssessment(draft, context, readSource) {
  requireThat(
    draft?.schema_version === 1 &&
      ["complete", "partial"].includes(draft.status) &&
      Array.isArray(draft.findings) &&
      draft.findings.length <= 50 &&
      Array.isArray(draft.reviewed_files),
    "Invalid assessment envelope",
  );
  const eligible = context.scope.filter((file) => !file.exclusion);
  const reviewed = new Set(draft.reviewed_files);
  requireThat(
    reviewed.size === draft.reviewed_files.length &&
      [...reviewed].every((p) => eligible.some((f) => f.path === p)),
    "Reviewed paths must be unique eligible changed files",
  );
  if (context.reads) {
    for (const filename of reviewed) {
      const read = context.reads[filename];
      requireThat(read?.total_lines > 0, "Reviewed file was not read");
      const ranges = [...read.ranges].sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [start, last] of ranges) {
        requireThat(
          start <= end + 1,
          "Reviewed module has unread source ranges",
        );
        end = Math.max(end, last);
      }
      requireThat(
        end === read.total_lines,
        "Reviewed module was not fully read",
      );
    }
  }
  const cache = new Map();
  async function location(input, mustBeChanged = false) {
    requireThat(input && typeof input === "object", "Location required");
    const filename = sourcePath(input.path);
    requireThat(
      ["head", "base"].includes(input.snapshot) &&
        Number.isSafeInteger(input.start_line) &&
        Number.isSafeInteger(input.end_line) &&
        input.start_line >= 1 &&
        input.end_line >= input.start_line &&
        input.end_line - input.start_line < 40,
      "Invalid source range",
    );
    const file = eligible.find((f) => f.path === filename);
    if (mustBeChanged) {
      requireThat(
        file &&
          reviewed.has(filename) &&
          input.snapshot === "head" &&
          file.ranges.some(
            ([start, end]) =>
              input.start_line <= end && input.end_line >= start,
          ),
        "Finding must overlap eligible changed lines in reviewed head code",
      );
    }
    const key = `${input.snapshot}:${filename}`;
    if (!cache.has(key))
      cache.set(key, await readSource(filename, input.snapshot));
    const lines = cache.get(key).split("\n");
    const excerpt = text(input.excerpt, "evidence excerpt");
    requireThat(
      input.end_line <= lines.length &&
        lines.slice(input.start_line - 1, input.end_line).join("\n") ===
          excerpt,
      "Evidence excerpt does not match the immutable source range",
    );
    return {
      path: filename,
      snapshot: input.snapshot,
      start_line: input.start_line,
      end_line: input.end_line,
      excerpt,
    };
  }
  const ids = new Set();
  const findings = [];
  for (const input of draft.findings) {
    requireThat(
      typeof input.id === "string" &&
        /^[a-z0-9-]{1,60}$/.test(input.id) &&
        !ids.has(input.id) &&
        FAMILIES.includes(input.family) &&
        ["high", "medium", "low"].includes(input.confidence) &&
        ["minor", "material", "severe", "critical"].includes(input.severity),
      "Invalid or duplicate finding",
    );
    ids.add(input.id);
    const finding = {
      id: input.id,
      family: input.family,
      confidence: input.confidence,
      severity: input.severity,
      title: text(input.title, "finding title"),
      explanation: text(input.explanation, "explanation"),
      correction: text(input.correction, "suggested correction"),
      location: await location(input.location, true),
    };
    if (finding.family === "correctness" && finding.confidence === "high")
      requireThat(
        context.evidence?.checks.some(
          (c) =>
            ["build", "types", "tests"].includes(c.kind) &&
            c.result !== "unavailable",
        ),
        "Source-only correctness suspicions must remain medium/low-confidence observations",
      );
    if (input.kind === "missed-reuse") {
      finding.kind = "missed-reuse";
      finding.existing = await location(input.existing);
      requireThat(
        finding.existing.snapshot === "base",
        "Missed reuse must cite a utility that already exists in the base",
      );
      finding.compatibility = text(input.compatibility, "reuse compatibility");
    }
    findings.push(finding);
  }
  const categories = {};
  for (const id of FAMILIES) {
    const input = draft.categories?.[id];
    requireThat(
      input &&
        (input.score === null || ANCHORS.includes(input.score)) &&
        Array.isArray(input.checklist) &&
        Array.isArray(input.finding_ids),
      `Invalid ${id} category`,
    );
    const scored = input.score !== null;
    if (scored) {
      requireThat(
        CHECKLIST[id].every((item) => input.checklist.includes(item)),
        `${id} coverage checklist incomplete`,
      );
      requireThat(
        eligible.length > 0 &&
          reviewed.size === eligible.length &&
          !context.truncated,
        "Score requires complete eligible source scope; use N/A for incomplete review",
      );
      if (id === "correctness")
        requireThat(
          context.evidence?.checks.some(
            (c) =>
              ["build", "types", "tests"].includes(c.kind) &&
              c.result !== "unavailable",
          ),
          "Correctness requires supplied execution evidence",
        );
    }
    const relevant = input.finding_ids.map((findingId) => {
      const finding = findings.find((f) => f.id === findingId);
      requireThat(
        finding?.family === id && finding.confidence === "high",
        "Score references must name high-confidence findings in that family",
      );
      return finding;
    });
    requireThat(
      !(input.score > 0) || relevant.length > 0,
      "Positive scores require grounded high-confidence findings",
    );
    requireThat(
      input.score !== 0 ||
        !findings.some((f) => f.family === id && f.confidence === "high"),
      "Zero cannot conceal high-confidence findings",
    );
    categories[id] = {
      score: input.score,
      justification: text(input.justification, "category justification"),
      checklist: CHECKLIST[id].filter((c) => input.checklist.includes(c)),
      finding_ids: [...new Set(input.finding_ids)],
    };
  }
  const report = deterministicReport(context);
  report.mode = "model";
  report.status =
    context.truncated || reviewed.size !== eligible.length
      ? "partial"
      : draft.status;
  report.categories = categories;
  report.overall = aggregate(categories);
  report.findings = findings;
  report.scope = context.scope.map((f) => ({
    ...f,
    reviewed: reviewed.has(f.path),
  }));
  return report;
}

export function compareHistory(report, previous) {
  if (!previous) return report;
  const compatible =
    previous.schema_version === report.schema_version &&
    previous.rubric === report.rubric &&
    previous.model === report.model &&
    previous.identity?.repository === report.identity.repository &&
    previous.identity?.pr === report.identity.pr &&
    previous.identity?.base_sha === report.identity.base_sha &&
    previous.identity?.head_sha !== report.identity.head_sha &&
    fingerprint(previous.configuration) === fingerprint(report.configuration) &&
    fingerprint(previous.scope?.map((f) => f.path).sort()) ===
      fingerprint(report.scope.map((f) => f.path).sort());
  if (!compatible) {
    report.drift = {
      available: false,
      reason:
        "Base, rubric, model, configuration, revision, or file scope changed.",
    };
    return report;
  }
  const deltas = Object.fromEntries(
    FAMILIES.map((id) => [
      id,
      Number.isFinite(report.categories[id].score) &&
      Number.isFinite(previous.categories?.[id]?.score)
        ? report.categories[id].score - previous.categories[id].score
        : null,
    ]),
  );
  const comparable = Object.values(deltas).some(Number.isFinite);
  report.drift = {
    available: comparable,
    reason: comparable
      ? "Compatible per-family revision comparison."
      : "No comparable family scores.",
    previous_head_sha: previous.identity.head_sha,
    scope_changed: fingerprint(previous.scope) !== fingerprint(report.scope),
    interpretation:
      "Score deltas are not proof that changed requirements are unjustified.",
    deltas,
  };
  return report;
}

function markdown(value) {
  return redact(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

export function render(report) {
  const lines = [
    "## PR slop assessment (experimental)",
    "",
    `**Status:** ${report.status} | **Index:** ${report.overall.score ?? "N/A"}/100 (higher is worse) | **Coverage:** ${report.overall.assessed}/5 families`,
    "",
    "An authorship-neutral rubric index, not a percentage of defective or AI-generated code.",
    "",
    `Head: \`${report.identity.head_sha}\` | Rubric: \`${RUBRIC}\` | Mode: ${report.mode}`,
    "",
    "| Family | Score | Evidence / limitations |",
    "|---|---:|---|",
    ...FAMILIES.map(
      (id) =>
        `| ${id} | ${report.categories[id].score ?? "N/A"} | ${markdown(report.categories[id].justification)} |`,
    ),
    "",
    `**Revision drift:** ${report.drift.available ? markdown(JSON.stringify(report.drift.deltas)) + (report.drift.scope_changed ? " — scope changed; interpret deltas with care." : "") : markdown(report.drift.reason)}`,
    "",
    "### Findings",
  ];
  for (const finding of report.findings) {
    lines.push(
      "",
      `**${markdown(finding.severity)} / ${finding.confidence}: ${markdown(finding.title)}**`,
      `${markdown(finding.location.path)}:${finding.location.start_line}-${finding.location.end_line}`,
      markdown(finding.explanation),
      `Suggested correction: ${markdown(finding.correction)}`,
    );
    if (finding.existing)
      lines.push(
        `Existing utility: ${markdown(finding.existing.path)}:${finding.existing.start_line}. ${markdown(finding.compatibility)}`,
      );
  }
  if (!report.findings.length)
    lines.push("", "No supported findings reported.");
  lines.push("", "### Scope", "");
  for (const file of report.scope)
    lines.push(
      `- ${markdown(file.path)}: ${markdown(file.exclusion ?? (file.reviewed ? "reviewed" : "not semantically reviewed"))}`,
    );
  if (report.duplicate_scope)
    lines.push(
      "",
      `Exact duplicate candidate inventory: ${report.duplicate_scope.files.length} changed files inspected (limit ${report.duplicate_scope.limit}); not repository-wide semantic duplication analysis.`,
    );
  if (report.evidence)
    lines.push(
      "",
      "### Supplied CI evidence (not independently executed)",
      "",
      ...report.evidence.checks.map(
        (check) =>
          `- ${markdown(check.name)} (${check.kind}): ${check.result}${check.result === "failed" ? (check.base_result === "passed" ? " — comparable base passed" : " — regression not established") : ""}`,
      ),
    );
  const actionable = report.findings.filter((f) => f.confidence === "high");
  if (report.observations?.length)
    lines.push(
      "",
      "### Exact duplicate candidates (not scored)",
      "",
      ...report.observations.map(
        (item) =>
          `- ${markdown(item.path)}:${item.line} matches ${markdown(item.other_path)}:${item.other_line}; identical text alone does not establish avoidable debt.`,
      ),
    );
  if (report.status === "complete" && actionable.length)
    lines.push(
      "",
      "### Maintainer-mediated feedback",
      "",
      "Copy the following request into a new comment only after reviewing the findings and confirming Copilot is assigned. Nothing is sent automatically.",
      "",
      "```text",
      "@copilot Please investigate these evidence-backed findings from the slop assessment:",
      ...actionable.map((f) => `- ${f.id}: ${markdown(f.title)}`),
      "Check the report against current code; fix justified issues only. Do not merge.",
      "```",
    );
  lines.push(
    "",
    "Automatic remediation is disabled. Optional absent CI/history is N/A; incomplete source review is partial.",
  );
  return lines.join("\n") + "\n";
}

export function duplicateCandidates(files, width = 8) {
  const seen = new Map();
  const candidates = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let index = 0; index + width <= lines.length; index++) {
      const block = lines.slice(index, index + width);
      if (block.filter((line) => line.trim().length > 8).length < 5) continue;
      const key = fingerprint(block);
      const other = seen.get(key);
      if (other && file.changed && candidates.length < 20) {
        candidates.push({
          path: file.path,
          line: index + 1,
          other_path: other.path,
          other_line: other.line,
          snapshot: file.snapshot,
          other_snapshot: other.snapshot,
        });
        index += width - 1;
      } else {
        seen.set(key, {
          path: file.path,
          line: index + 1,
          snapshot: file.snapshot,
        });
      }
    }
  }
  return candidates;
}
