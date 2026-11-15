import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { reserveSourceBytes } from "../src/state.mjs";

const execute = promisify(execFile);
const moduleUrl = new URL("../src/state.mjs", import.meta.url).href;

it("preserves source ranges and byte reservations across concurrent MCP processes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slop-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    const { updateState, reserveSourceBytes } = await import(process.argv[1]);
    const directory = process.argv[2];
    const index = Number(process.argv[3]);
    await updateState(directory, "reads", {}, (ledger) => {
      ledger["src/main.js"] ??= { total_lines: 12, ranges: [] };
      ledger["src/main.js"].ranges.push([index, index]);
    });
    try {
      const reservation = await reserveSourceBytes(directory, 100000, "source-" + index);
      await reservation.commit();
      console.log("reserved");
    } catch (error) {
      if (!error.message.includes("budget exhausted")) throw error;
      console.log("exhausted");
    }
  `;
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      execute(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        moduleUrl,
        directory,
        String(index + 1),
      ]),
    ),
  );
  const reads = JSON.parse(await readFile(`${directory}/reads.json`, "utf8"));
  assert.equal(reads["src/main.js"].ranges.length, 12);
  assert.deepEqual(
    reads["src/main.js"].ranges.map(([line]) => line).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(
    results.filter(({ stdout }) => stdout.trim() === "reserved").length,
    10,
  );
  assert.equal(
    results.filter(({ stdout }) => stdout.trim() === "exhausted").length,
    2,
  );
  assert.equal(
    JSON.parse(await readFile(`${directory}/budget.json`, "utf8")).bytes,
    1_000_000,
  );
});

it("releases a failed retrieval reservation so another process can use the budget", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slop-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = await reserveSourceBytes(directory, 1_000_000, "source");
  await assert.rejects(
    reserveSourceBytes(directory, 1, "other"),
    /budget exhausted/,
  );
  await reservation.release();
  await reservation.release();
  await reserveSourceBytes(directory, 1_000_000, "other");
});

it("charges repeated concurrent reads once and isolates inventory from model review", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slop-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inventory = await reserveSourceBytes(
    directory,
    1_000_000,
    "inventory-file",
    "inventory-budget",
  );
  await inventory.commit();
  const reservations = await Promise.all(
    Array.from({ length: 20 }, () =>
      reserveSourceBytes(directory, 60_000, "same-snapshot-file"),
    ),
  );
  await Promise.all(
    reservations.map((reservation, index) =>
      index === 0 ? reservation.commit() : reservation.release(),
    ),
  );
  const repeated = await reserveSourceBytes(
    directory,
    60_000,
    "same-snapshot-file",
  );
  await repeated.commit();
  const script = `
    const { reserveSourceBytes } = await import(process.argv[1]);
    const reservation = await reserveSourceBytes(process.argv[2], 60000, "same-snapshot-file");
    await reservation.commit();
  `;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      execute(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        moduleUrl,
        directory,
      ]),
    ),
  );
  assert.equal(
    JSON.parse(await readFile(`${directory}/budget.json`, "utf8")).bytes,
    60_000,
  );
});
