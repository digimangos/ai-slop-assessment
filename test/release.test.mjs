import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { releaseIdentity } from "../scripts/release.mjs";

const input = {
  tag: "v1.0.0",
  version: "1.0.0",
  ref: "refs/heads/main",
  defaultBranch: "main",
  commit: "a".repeat(40),
};

it("accepts an exact version on the default-branch commit", () => {
  assert.deepEqual(releaseIdentity(input), {
    tag: "v1.0.0",
    commit: input.commit,
  });
});

it("rejects mismatched or non-exact release versions", () => {
  for (const tag of ["v0.1.0", "1.0.0", "v1.0.0-rc.1", "v1.0.0\nbad"]) {
    assert.throws(() => releaseIdentity({ ...input, tag }));
  }
  for (const version of ["01.0.0", "1.0.0+build", "1.0", "v1.0.0"]) {
    assert.throws(() => releaseIdentity({ ...input, version }));
  }
});

it("rejects non-default branches and malformed commit identities", () => {
  assert.throws(() => releaseIdentity({ ...input, ref: "refs/heads/feature" }));
  assert.throws(() => releaseIdentity({ ...input, commit: "abc" }));
  assert.throws(() => releaseIdentity({ ...input, commit: "F".repeat(40) }));
});

async function runPublisher(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slop-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, "calls");
  await writeFile(
    path.join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
const endpoint = args[1] || "";
if (endpoint.endsWith("/git/ref/heads/main")) console.log(process.env.TEST_TIP);
else if (endpoint.endsWith("/git/tags")) console.log("b".repeat(40));
else if (endpoint.endsWith("/git/refs") && process.env.TEST_CONFLICT === "true") process.exit(1);
else if (endpoint.endsWith("/commits/v1.0.0")) console.log(process.env.TEST_TAG_COMMIT);
else if (endpoint.endsWith("/releases/tags/v1.0.0")) console.log(process.env.TEST_IMMUTABLE);
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["scripts/publish-release.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      CALL_LOG: log,
      GH_REPO: "example/project",
      DEFAULT_BRANCH: "main",
      TAG: input.tag,
      COMMIT: input.commit,
      TEST_TIP: input.commit,
      TEST_TAG_COMMIT: input.commit,
      TEST_IMMUTABLE: "true",
      ...overrides,
    },
  });
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, calls };
}

it("creates an annotated tag at the validated commit before publishing", async (t) => {
  const { result, calls } = await runPublisher(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["api", "repos/example/project/git/ref/heads/main"],
      ["api", "repos/example/project/git/tags"],
      ["api", "repos/example/project/git/refs"],
      ["api", "repos/example/project/commits/v1.0.0"],
      ["release", "create"],
      ["release", "edit"],
      ["api", "repos/example/project/releases/tags/v1.0.0"],
    ],
  );
  assert.ok(calls[1].includes(`object=${input.commit}`));
  assert.ok(calls[2].includes("ref=refs/tags/v1.0.0"));
  assert.ok(calls[2].includes(`sha=${"b".repeat(40)}`));
  assert.ok(calls[4].includes("--verify-tag"));
  assert.ok(calls[4].includes("--draft"));
});

it("does not publish when the branch moves, the tag exists, or the tag points elsewhere", async (t) => {
  for (const overrides of [
    { TEST_TIP: "c".repeat(40) },
    { TEST_CONFLICT: "true" },
    { TEST_TAG_COMMIT: "d".repeat(40) },
  ]) {
    const { result, calls } = await runPublisher(t, overrides);
    assert.notEqual(result.status, 0);
    assert.ok(!calls.some((args) => args[0] === "release"));
  }
});

it("reports an immutable-release failure instead of claiming success", async (t) => {
  const { result } = await runPublisher(t, { TEST_IMMUTABLE: "false" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /immutability is not enabled/);
});
