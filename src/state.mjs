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

export async function reserveSourceBytes(directory, bytes) {
  requireThat(
    Number.isSafeInteger(bytes) && bytes >= 0,
    "Invalid source byte reservation",
  );
  await updateState(directory, "budget", { bytes: 0 }, (state) => {
    requireThat(
      Number.isSafeInteger(state.bytes) &&
        state.bytes >= 0 &&
        state.bytes + bytes <= 1_000_000,
      "Source byte budget exhausted",
    );
    state.bytes += bytes;
  });
  let released = false;
  return async () => {
    if (released) return;
    await updateState(directory, "budget", { bytes: 0 }, (state) => {
      requireThat(state.bytes >= bytes, "Invalid source budget state");
      state.bytes -= bytes;
    });
    released = true;
  };
}
