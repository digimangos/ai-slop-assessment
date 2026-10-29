import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("compiles only the bounded source tools and validated publication output", async () => {
  const lock = await readFile(
    new URL("../.github/workflows/slop-review.lock.yml", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(lock.match(/^# gh-aw-manifest: (.+)$/m)[1]);
  assert.deepEqual(manifest.mcp_servers.map((server) => server.name).sort(), [
    "mcpscripts",
    "safeoutputs",
  ]);
  assert.deepEqual(
    manifest.mcp_servers.find((server) => server.name === "mcpscripts").tools,
    ["list-sources", "read-source", "review-context"],
  );
  const outputs = manifest.mcp_servers.find(
    (server) => server.name === "safeoutputs",
  ).tools;
  assert.ok(outputs.includes("publish_assessment"));
  for (const forbidden of [
    "assign_to_agent",
    "create_agent_session",
    "merge_pull_request",
    "add_comment",
  ])
    assert.ok(!outputs.includes(forbidden));
  assert.equal(manifest.threat_detection.mode, "enabled");
  assert.ok(
    manifest.actions.every((action) => /^[a-f0-9]{40}$/.test(action.sha)),
  );
});
