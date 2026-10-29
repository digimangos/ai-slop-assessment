import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, reportFromZip } from "../src/github.mjs";
import { deterministicReport } from "../src/report.mjs";

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

describe("GitHub source and publication boundaries", () => {
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
    const report = deterministicReport({
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
