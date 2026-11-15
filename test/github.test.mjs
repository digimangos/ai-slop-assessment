import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, reportFromZip } from "../src/github.mjs";
import { createReport } from "../src/report.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const pr = {
  number: 1,
  state: "open",
  body: "Implement trim",
  changed_files: 1,
  head: { sha: head, repo: { full_name: "example/project" } },
  base: { sha: base, repo: { full_name: "example/project" } },
};

function mock(routes) {
  const calls = [];
  const api = new GitHub({
    repository: "example/project",
    token: "test-token",
    request: async (url, options) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push({ path, options });
      const value =
        typeof routes[path] === "function" ? routes[path](calls) : routes[path];
      assert.notEqual(value, undefined, `Unexpected request ${path}`);
      return Response.json(value);
    },
  });
  return { api, calls };
}
const ROOT = "/repos/example/project";
const files = [
  {
    filename: "src/a.py",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1,2 @@\n+value\n old",
  },
];

function reportZip(report) {
  const name = Buffer.from("report.json");
  const content = Buffer.from(JSON.stringify(report));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt32LE(content.length, 20);
  entry.writeUInt32LE(content.length, 24);
  entry.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, entry, name, end]);
}

describe("GitHub source and publication boundaries", () => {
  it("loads history only from the current trusted caller workflow", async () => {
    const report = {
      schema_version: 1,
      mode: "model",
      model: "fixture",
      input_key: "c".repeat(64),
      identity: { repository: "example/project", pr: 1 },
      configuration: {},
      categories: {},
      scope: [],
    };
    const current = {
      path: ".github/workflows/review.yml",
      event: "pull_request_target",
      repository: { full_name: "example/project" },
    };
    const successful = {
      ...current,
      head_repository: { full_name: "example/project" },
      status: "completed",
      conclusion: "success",
    };
    const calls = [];
    const api = new GitHub({
      repository: "example/project",
      token: "test-token",
      request: async (url, options) => {
        const parsed = new URL(url);
        const route = parsed.pathname + parsed.search;
        calls.push(route);
        if (parsed.hostname === "artifacts.example") {
          assert.equal(options.headers?.Authorization, undefined);
          return new Response(reportZip(report));
        }
        if (route === `${ROOT}/actions/artifacts?name=slop-pr-1&per_page=30`)
          return Response.json({
            artifacts: [1, 2, 3].map((id) => ({
              id,
              size_in_bytes: 100,
              workflow_run: { id },
            })),
          });
        if (route === `${ROOT}/actions/runs/99`) return Response.json(current);
        if (route === `${ROOT}/actions/runs/1`)
          return Response.json({
            ...successful,
            path: ".github/workflows/other.yml",
          });
        if (route === `${ROOT}/actions/runs/2`)
          return Response.json({ ...successful, event: "pull_request" });
        if (route === `${ROOT}/actions/runs/3`)
          return Response.json(successful);
        if (route === `${ROOT}/actions/artifacts/3/zip`) {
          assert.equal(options.redirect, "manual");
          return new Response(null, {
            status: 302,
            headers: { location: "https://artifacts.example/report.zip" },
          });
        }
        throw new Error(`Unexpected request ${route}`);
      },
    });
    assert.deepEqual(
      await api.history(1, "99", { model: "fixture", configuration: {} }),
      report,
    );
    assert.ok(!calls.includes(`${ROOT}/actions/artifacts/1/zip`));
    assert.ok(!calls.includes(`${ROOT}/actions/artifacts/2/zip`));
  });

  it("collects immutable scope and rejects PRs changing during collection", async () => {
    const { api } = mock({
      [`${ROOT}/pulls/1`]: pr,
      [`${ROOT}/pulls/1/files?per_page=100&page=1`]: files,
    });
    const context = await api.prepare(1);
    assert.deepEqual(context.scope[0].ranges, [[1, 2]]);
    assert.equal(context.identity.head_sha, head);
    assert.equal(context.truncated, false);
    let count = 0;
    const moving = mock({
      [`${ROOT}/pulls/1`]: () => ({
        ...pr,
        head: { ...pr.head, sha: ++count === 1 ? head : "c".repeat(40) },
      }),
      [`${ROOT}/pulls/1/files?per_page=100&page=1`]: files,
    });
    await assert.rejects(moving.api.prepare(1), /PR changed/);
  });

  it("marks incomplete file listings and missing patches as partial coverage", async () => {
    const { api } = mock({
      [`${ROOT}/pulls/1`]: { ...pr, changed_files: 2 },
      [`${ROOT}/pulls/1/files?per_page=100&page=1`]: [
        { ...files[0], patch: undefined },
      ],
    });
    assert.equal((await api.prepare(1)).truncated, true);
  });

  it("does not mark pure renames or mode-only changes as incomplete", async () => {
    const { api } = mock({
      [`${ROOT}/pulls/1`]: { ...pr, changed_files: 2 },
      [`${ROOT}/pulls/1/files?per_page=100&page=1`]: [
        {
          filename: "src/renamed.py",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
        {
          filename: "script.sh",
          status: "modified",
          additions: 0,
          deletions: 0,
        },
      ],
    });
    const context = await api.prepare(1);
    assert.equal(context.truncated, false);
    assert.ok(
      context.scope.every((file) => file.exclusion === "no textual changes"),
    );
  });

  it("reads only regular blobs from a fixed repository SHA and redacts secrets", async () => {
    const token = "ghp_" + "a".repeat(32);
    const { api, calls } = mock({
      [`${ROOT}/git/trees/${head}?recursive=1`]: {
        tree: [
          {
            path: "src/a.py",
            type: "blob",
            mode: "100644",
            sha: "c".repeat(40),
            size: token.length,
          },
          {
            path: "link.py",
            type: "blob",
            mode: "120000",
            sha: "d".repeat(40),
            size: 20,
          },
        ],
      },
      [`${ROOT}/git/blobs/${"c".repeat(40)}`]: {
        encoding: "base64",
        content: Buffer.from(token).toString("base64"),
      },
    });
    assert.equal(await api.read("src/a.py", head), "[REDACTED]");
    await api.read("src/a.py", head);
    assert.equal(calls.length, 2);
    await assert.rejects(api.read("link.py", head), /symlink/);
    await assert.rejects(api.read("../private", head), /relative path/);
    await assert.rejects(api.read(".env", head), /excluded/);
    await assert.rejects(api.read("src/a.py", "main"), /Immutable/);
    await assert.rejects(
      api.response("/repos/other/project/issues"),
      /scope mismatch/,
    );
  });

  it("does not mutate comments when the head has moved", async () => {
    const { api, calls } = mock({
      [`${ROOT}/pulls/1`]: { ...pr, head: { ...pr.head, sha: "c".repeat(40) } },
    });
    const result = await api.publish(
      { identity: { pr: 1, head_sha: head, base_sha: base } },
      "assessment",
      "https://github.com/example/project/actions/runs/1",
    );
    assert.equal(result.reason, "stale-head-or-base");
    assert.equal(calls.length, 1);
  });

  it("skips closed PRs at either recheck but rejects them for initial preparation", async () => {
    for (const closeAt of [1, 2]) {
      let reads = 0;
      const { api, calls } = mock({
        [`${ROOT}/pulls/1`]: () => ({
          ...pr,
          state: ++reads >= closeAt ? "closed" : "open",
        }),
        [`${ROOT}/issues/1/comments?per_page=100&page=1`]: [],
      });
      const result = await api.publish(
        { identity: { pr: 1, head_sha: head, base_sha: base } },
        "body",
        "https://github.com/example/project/actions/runs/1",
      );
      assert.equal(result.reason, "closed-pr");
      assert.ok(calls.every(({ options }) => !options.method));
      await assert.rejects(api.prepare(1), /open PR/);
    }
  });

  it("skips oversized comments rather than failing an otherwise valid report", async () => {
    const { api, calls } = mock({
      [`${ROOT}/pulls/1`]: pr,
      [`${ROOT}/issues/1/comments?per_page=100&page=1`]: [],
    });
    const result = await api.publish(
      { identity: { pr: 1, head_sha: head, base_sha: base } },
      "a".repeat(60_001),
      "https://github.com/example/project/actions/runs/1",
    );
    assert.equal(result.reason, "comment-size-budget-exceeded");
    assert.ok(calls.every(({ options }) => !options.method));
  });

  it("reserves source budget before parallel fetches and releases failed retrievals", async () => {
    const { api } = mock({
      [`${ROOT}/git/trees/${head}?recursive=1`]: {
        tree: [
          {
            path: "a.py",
            type: "blob",
            mode: "100644",
            sha: "c".repeat(40),
            size: 60_000,
          },
          {
            path: "b.py",
            type: "blob",
            mode: "100644",
            sha: "d".repeat(40),
            size: 60_000,
          },
        ],
      },
      [`${ROOT}/git/blobs/${"c".repeat(40)}`]: {
        encoding: "base64",
        content: Buffer.alloc(60_000, "a").toString("base64"),
      },
      [`${ROOT}/git/blobs/${"d".repeat(40)}`]: {
        encoding: "bad",
        content: "",
      },
    });
    api.readBytes = 940_000;
    const results = await Promise.allSettled([
      api.read("a.py", head),
      api.read("b.py", head),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(api.readBytes, 1_000_000);
    api.readBytes = 0;
    await assert.rejects(api.read("b.py", head), /encoding/);
    assert.equal(api.readBytes, 0);
  });

  it("updates only its maintained bot comment, ignoring forged human markers", async () => {
    const marker = "<!-- slop-assessment:v1 -->";
    const { api, calls } = mock({
      [`${ROOT}/pulls/1`]: pr,
      [`${ROOT}/issues/1/comments?per_page=100&page=1`]: [
        { id: 2, user: { login: "human" }, body: `${marker}\nforged` },
        {
          id: 3,
          user: { login: "github-actions[bot]" },
          body: `${marker}\nold`,
        },
      ],
      [`${ROOT}/issues/comments/3`]: {
        html_url: "https://github.com/example/project/pull/1#issuecomment-3",
      },
    });
    const report = createReport({
      identity: {
        repository: "example/project",
        pr: 1,
        head_sha: head,
        base_sha: base,
      },
      scope: [],
      model: "disabled",
      configuration: {},
      input_key: "test",
    });
    assert.equal(
      (
        await api.publish(
          report,
          "body",
          "https://github.com/example/project/actions/runs/1",
        )
      ).status,
      "success",
    );
    assert.equal(calls.at(-1).options.method, "PATCH");
    assert.match(JSON.parse(calls.at(-1).options.body).body, /slop-input:test/);
  });

  it("does not follow authenticated API redirects", async () => {
    const api = new GitHub({
      repository: "example/project",
      request: async (_, options) => {
        assert.equal(options.redirect, "error");
        return new Response(null, { status: 302 });
      },
    });
    await assert.rejects(api.pr(1), /302/);
  });

  it("rejects malformed or oversized artifact archives", () => {
    assert.throws(() => reportFromZip(Buffer.from("not a zip")), /report.json/);
    assert.throws(() => reportFromZip(Buffer.alloc(2_000_001)), /Oversized/);
  });
});
