import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { requireThat } from "./report.mjs";

export async function updateState(directory, name, initial, update) {
  await mkdir(directory, { recursive: true });
  const lock = `${directory}/${name}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      requireThat(Date.now() < deadline, "Assessment state lock timed out");
      await setTimeout(10);
    }
  }
  try {
    let state;
    try {
      state = JSON.parse(await readFile(`${directory}/${name}.json`, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = structuredClone(initial);
    }
    const result = await update(state);
    const temporary = `${directory}/${name}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, `${directory}/${name}.json`);
    return result;
  } finally {
    await rmdir(lock);
  }
}

export async function reserveSourceBytes(
  directory,
  bytes,
  key,
  name = "budget",
) {
  requireThat(
    Number.isSafeInteger(bytes) &&
      bytes >= 0 &&
      typeof key === "string" &&
      key.length > 0 &&
      key.length <= 600,
    "Invalid source byte reservation",
  );
  const initial = { bytes: 0, sources: {} };
  await updateState(directory, name, initial, (state) => {
    requireThat(
      Number.isSafeInteger(state.bytes) && state.bytes >= 0 && state.sources,
      "Invalid source budget state",
    );
    const existing = Object.hasOwn(state.sources, key)
      ? state.sources[key]
      : null;
    if (existing) {
      requireThat(existing.bytes === bytes, "Source size changed");
      existing.pending++;
    } else {
      requireThat(
        state.bytes + bytes <= 1_000_000,
        "Source byte budget exhausted",
      );
      state.sources[key] = { bytes, pending: 1, complete: false };
      state.bytes += bytes;
    }
  });
  let settled = false;
  const settle = async (success) => {
    if (settled) return;
    await updateState(directory, name, initial, (state) => {
      const source = state.sources[key];
      requireThat(source?.pending > 0, "Invalid source budget state");
      source.pending--;
      if (success) source.complete = true;
      if (!source.pending && !source.complete) {
        state.bytes -= source.bytes;
        delete state.sources[key];
      }
    });
    settled = true;
  };
  return {
    commit: () => settle(true),
    release: () => settle(false),
  };
}
