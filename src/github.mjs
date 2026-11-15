import { inflateRawSync } from "node:zlib";
import {
  eligibility,
  fingerprint,
  redact,
  requireThat,
  RUBRIC,
  sourcePath,
  validateEvidence,
} from "./report.mjs";

const SHA = /^[a-f0-9]{40}$/;
const MAX_SOURCE_BYTES = 64_000;
const MAX_ARTIFACT_BYTES = 2_000_000;
const MARKER = "<!-- slop-assessment:v1 -->";

export class GitHub {
  constructor({
    repository,
    token,
    api = "https://api.github.com",
    request = fetch,
    reserveBytes,
  }) {
    requireThat(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
      "Invalid repository",
    );
    requireThat(
      new URL(api).protocol === "https:",
      "GitHub API must use HTTPS",
    );
    this.repository = repository;
    this.root = `/repos/${repository}`;
    this.api = api;
    this.token = token;
    this.request = request;
    this.sources = new Map();
    this.trees = new Map();
    this.readBytes = 0;
    this.reserveBytes =
      reserveBytes ??
      ((bytes) => {
        requireThat(
          this.readBytes + bytes <= 1_000_000,
          "Source byte budget exhausted",
        );
        this.readBytes += bytes;
        return {
          commit: () => {},
          release: () => {
            this.readBytes -= bytes;
          },
        };
      });
  }

  async response(route, options = {}) {
    requireThat(route.startsWith(`${this.root}/`), "Repository scope mismatch");
    const response = await this.request(`${this.api}${route}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...options.headers,
      },
    });
    requireThat(response.ok, `GitHub API request failed (${response.status})`);
    return response;
  }

  async json(route, options) {
    const response = await this.response(route, options);
    return response.json();
  }

  async pr(number, { requireOpen = true } = {}) {
    requireThat(
      Number.isSafeInteger(number) && number > 0,
      "Invalid PR number",
    );
    const pr = await this.json(`${this.root}/pulls/${number}`);
    requireThat(
      (!requireOpen || pr.state === "open") &&
        pr.base.repo.full_name.toLowerCase() ===
          this.repository.toLowerCase() &&
        SHA.test(pr.head.sha) &&
        SHA.test(pr.base.sha),
      "Assessment requires an open PR with immutable head and base SHAs",
    );
    return pr;
  }

  async tree(sha) {
    requireThat(SHA.test(sha), "Immutable source SHA required");
    if (!this.trees.has(sha)) {
      const tree = await this.json(`${this.root}/git/trees/${sha}?recursive=1`);
      this.trees.set(sha, tree);
    }
    return this.trees.get(sha);
  }

  async read(filename, sha, configuration = {}) {
    sourcePath(filename);
    requireThat(
      !eligibility(filename, configuration) ||
        eligibility(filename, configuration) === "documentation context",
      "Source path excluded from model context",
    );
    const key = `${sha}:${filename}`;
    if (this.sources.has(key)) return this.sources.get(key);
    const tree = await this.tree(sha);
    const entry = tree.tree.find((item) => item.path === filename);
    requireThat(
      entry?.type === "blob" &&
        ["100644", "100755"].includes(entry.mode) &&
        entry.size <= MAX_SOURCE_BYTES,
      "Source missing, oversized, symlink, or non-regular file",
    );
    const reservation = await this.reserveBytes(entry.size, key);
    try {
      const blob = await this.json(`${this.root}/git/blobs/${entry.sha}`);
      requireThat(blob.encoding === "base64", "Unsupported blob encoding");
      const buffer = Buffer.from(blob.content, "base64");
      requireThat(
        buffer.length === entry.size &&
          buffer.length <= MAX_SOURCE_BYTES &&
          !buffer.includes(0),
        "Binary, oversized source, or blob size mismatch",
      );
      const value = redact(buffer.toString("utf8"));
      await reservation.commit();
      this.sources.set(key, value);
      return value;
    } catch (error) {
      await reservation.release();
      throw error;
    }
  }

  async prepare(
    number,
    { model = "disabled", configuration = {}, evidence = null } = {},
  ) {
    const pr = await this.pr(number);
    const identity = {
      repository: this.repository,
      pr: number,
      head_sha: pr.head.sha,
      base_sha: pr.base.sha,
    };
    const scope = [];
    for (let page = 1; page <= 10; page++) {
      const files = await this.json(
        `${this.root}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      for (const file of files) {
        sourcePath(file.filename);
        const ranges = [];
        for (const match of (file.patch ?? "").matchAll(
          /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
        )) {
          const start = Number(match[1]);
          const count = match[2] === undefined ? 1 : Number(match[2]);
          if (count) ranges.push([start, start + count - 1]);
        }
        scope.push({
          path: file.filename,
          status: file.status,
          previous_path: file.previous_filename ?? null,
          additions: file.additions,
          deletions: file.deletions,
          ranges,
          exclusion:
            eligibility(file.filename, configuration) ??
            (file.status === "removed"
              ? "deleted file context"
              : file.additions === 0 && file.deletions === 0
                ? "no textual changes"
                : !ranges.length && !file.patch
                  ? "no available textual diff"
                  : null),
        });
      }
      if (files.length < 100) break;
    }
    const current = await this.pr(number);
    requireThat(
      current.head.sha === identity.head_sha &&
        current.base.sha === identity.base_sha,
      "PR changed during scope collection; retry assessment",
    );
    const validated = validateEvidence(evidence, identity);
    const context = {
      identity,
      model,
      configuration,
      scope,
      evidence: validated,
      truncated:
        scope.length < pr.changed_files ||
        scope.some((f) => f.exclusion === "no available textual diff"),
      requirements: redact((pr.body ?? "").slice(0, 20_000)),
      fork:
        pr.head.repo?.full_name.toLowerCase() !== this.repository.toLowerCase(),
      fork_approved: (current.labels ?? []).some(
        (label) => label.name === "slop-review-approved",
      ),
    };
    context.input_key = fingerprint({
      identity,
      rubric: RUBRIC,
      model,
      configuration,
      evidence: validated,
      requirements: context.requirements,
    });
    return context;
  }

  async comments(number) {
    const comments = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json(
        `${this.root}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
    throw new Error(
      "Comment pagination limit exceeded; refusing ambiguous state",
    );
  }

  async publish(report, body, runUrl) {
    requireThat(
      /^https:\/\/[^\s]+\/actions\/runs\/\d+$/.test(runUrl),
      "Trusted workflow run URL required",
    );
    const pr = await this.pr(report.identity.pr, { requireOpen: false });
    if (pr.state !== "open") return { status: "skipped", reason: "closed-pr" };
    if (
      pr.head.sha !== report.identity.head_sha ||
      pr.base.sha !== report.identity.base_sha
    )
      return { status: "skipped", reason: "stale-head-or-base" };
    const comments = await this.comments(pr.number);
    const existing = comments.filter(
      (c) =>
        c.user?.login === "github-actions[bot]" &&
        c.body.startsWith(`${MARKER}\n`),
    );
    requireThat(
      existing.length <= 1,
      "Multiple report comments; refusing ambiguous update",
    );
    const content = `${MARKER}\n${body}\nGenerated by PR slop assessment: ${runUrl}\n<!-- slop-input:${report.input_key} -->`;
    if (Buffer.byteLength(content) > 60_000)
      return { status: "skipped", reason: "comment-size-budget-exceeded" };
    // Recheck immediately before the mutation; concurrency is also scoped per PR.
    const latest = await this.pr(pr.number, { requireOpen: false });
    if (latest.state !== "open")
      return { status: "skipped", reason: "closed-pr" };
    if (
      latest.head.sha !== report.identity.head_sha ||
      latest.base.sha !== report.identity.base_sha
    )
      return { status: "skipped", reason: "stale-head-or-base" };
    try {
      const comment = await this.json(
        existing.length
          ? `${this.root}/issues/comments/${existing[0].id}`
          : `${this.root}/issues/${pr.number}/comments`,
        {
          method: existing.length ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: content }),
        },
      );
      return { status: "success", url: comment.html_url };
    } catch (error) {
      if (/\((?:403|404)\)/.test(error.message))
        return { status: "skipped", reason: "comment-permission-unavailable" };
      throw error;
    }
  }

  async history(number, currentRunId, { model, configuration }) {
    const name = `slop-pr-${number}`;
    const artifacts = await this.json(
      `${this.root}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=30`,
    );
    const candidates = artifacts.artifacts
      .slice(0, 30)
      .filter(
        (artifact) =>
          !artifact.expired && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES,
      );
    if (!candidates.length) return null;
    requireThat(/^[0-9]+$/.test(currentRunId ?? ""), "Invalid workflow run ID");
    const current = await this.json(
      `${this.root}/actions/runs/${currentRunId}`,
    );
    requireThat(
      current.event === "pull_request_target" &&
        /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(current.path) &&
        current.repository?.full_name.toLowerCase() ===
          this.repository.toLowerCase(),
      "Invalid current assessment workflow",
    );
    for (const artifact of candidates) {
      const run = await this.json(
        `${this.root}/actions/runs/${artifact.workflow_run.id}`,
      );
      if (
        run.path !== current.path ||
        run.event !== current.event ||
        run.repository.full_name.toLowerCase() !==
          this.repository.toLowerCase() ||
        run.head_repository?.full_name.toLowerCase() !==
          this.repository.toLowerCase() ||
        run.status !== "completed" ||
        run.conclusion !== "success"
      )
        continue;
      const response = await this.request(
        `${this.api}${this.root}/actions/artifacts/${artifact.id}/zip`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        },
      );
      requireThat(
        response.status === 302,
        "Unexpected artifact download response",
      );
      const url = new URL(response.headers.get("location"));
      requireThat(
        url.protocol === "https:",
        "Artifact download requires HTTPS",
      );
      // Do not forward the GitHub credential to artifact storage.
      const download = await this.request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      requireThat(download.ok, "Artifact download failed");
      const chunks = [];
      let size = 0;
      for await (const chunk of download.body) {
        size += chunk.length;
        requireThat(size <= MAX_ARTIFACT_BYTES, "Artifact exceeds byte budget");
        chunks.push(chunk);
      }
      const report = JSON.parse(reportFromZip(Buffer.concat(chunks)));
      if (
        report.schema_version === 1 &&
        report.mode === "model" &&
        report.model === model &&
        /^[a-f0-9]{64}$/.test(report.input_key ?? "") &&
        report.identity?.repository === this.repository &&
        report.identity?.pr === number &&
        report.configuration !== null &&
        typeof report.configuration === "object" &&
        !Array.isArray(report.configuration) &&
        fingerprint(report.configuration) === fingerprint(configuration) &&
        report.categories &&
        Array.isArray(report.scope) &&
        report.scope.every((file) => typeof file?.path === "string")
      )
        return report;
    }
    return null;
  }
}

export function reportFromZip(buffer) {
  requireThat(buffer.length <= MAX_ARTIFACT_BYTES, "Oversized artifact");
  for (
    let end = buffer.length - 22;
    end >= Math.max(0, buffer.length - 65_557);
    end--
  ) {
    if (buffer.readUInt32LE(end) !== 0x06054b50) continue;
    const entries = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    for (let index = 0; index < entries; index++) {
      requireThat(
        buffer.readUInt32LE(offset) === 0x02014b50,
        "Invalid ZIP directory",
      );
      const method = buffer.readUInt16LE(offset + 10);
      const compressed = buffer.readUInt32LE(offset + 20);
      const uncompressed = buffer.readUInt32LE(offset + 24);
      const length = buffer.readUInt16LE(offset + 28);
      const extra = buffer.readUInt16LE(offset + 30);
      const comment = buffer.readUInt16LE(offset + 32);
      const local = buffer.readUInt32LE(offset + 42);
      const name = buffer
        .subarray(offset + 46, offset + 46 + length)
        .toString("utf8");
      if (name === "report.json") {
        requireThat(
          uncompressed <= MAX_ARTIFACT_BYTES &&
            compressed <= MAX_ARTIFACT_BYTES &&
            buffer.readUInt32LE(local) === 0x04034b50,
          "Invalid report entry",
        );
        const start =
          local +
          30 +
          buffer.readUInt16LE(local + 26) +
          buffer.readUInt16LE(local + 28);
        requireThat(start + compressed <= buffer.length, "Truncated artifact");
        const content = buffer.subarray(start, start + compressed);
        requireThat([0, 8].includes(method), "Unsupported ZIP compression");
        const result =
          method === 8
            ? inflateRawSync(content, { maxOutputLength: MAX_ARTIFACT_BYTES })
            : content;
        requireThat(result.length === uncompressed, "ZIP size mismatch");
        return result.toString("utf8");
      }
      offset += 46 + length + extra + comment;
    }
    break;
  }
  throw new Error("Artifact does not contain report.json");
}
