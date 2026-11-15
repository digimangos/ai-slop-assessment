import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { packRelease, verifyRelease } from "../scripts/release.mjs";

const root = resolve(`.release-test-${randomUUID()}`);
const source = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", ["-C", source, ...args]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let commit;
let tag;
let filename;
let original;
let manifest;

before(async () => {
  await mkdir(root);
  commit = git("rev-parse", "HEAD").toString().trim();
  const pkg = JSON.parse(git("show", `${commit}:package.json`).toString());
  tag = `v${pkg.version}`;
  filename = `ai-slop-rating-${tag}.tar.gz`;
  manifest = await packRelease({
    ref: commit,
    out: resolve(root, "first"),
    version: tag,
    repo: source,
  });
  original = await readFile(resolve(root, "first", filename));
});

after(async () => {
  // Only this test run's unique, project-local directory is removed.
  await rm(root, { recursive: true, force: true });
});

function headers(raw) {
  const entries = [];
  let offset = 0;
  while (raw[offset]) {
    const path = raw
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/s, "");
    const size = Number.parseInt(
      raw.subarray(offset + 124, offset + 136).toString(),
      8,
    );
    entries.push({ offset, path, size, data: offset + 512 });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function changeHeader(raw, entry, edit) {
  const header = raw.subarray(entry.offset, entry.offset + 512);
  edit(header);
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
}

async function verifyMutation(change, expected) {
  const out = resolve(root, randomUUID());
  await mkdir(out);
  const raw = gunzipSync(original);
  const changed = change(raw, headers(raw)) ?? raw;
  const bytes = gzipSync(changed);
  await writeFile(resolve(out, filename), bytes);
  await writeFile(
    resolve(out, "SHA256SUMS"),
    `${sha256(bytes)}  ${filename}\n`,
  );
  await assert.rejects(
    verifyRelease({
      archive: resolve(out, filename),
      checksums: resolve(out, "SHA256SUMS"),
      version: tag,
      commit,
    }),
    expected,
  );
}

it("packages and verifies the complete committed bundle reproducibly", async () => {
  const checked = await verifyRelease({
    archive: resolve(root, "first", filename),
    checksums: resolve(root, "first", "SHA256SUMS"),
    version: tag,
    commit,
  });
  assert.deepEqual(checked, manifest);
  const modules = git("ls-tree", "-r", "--name-only", commit, "--", "src")
    .toString()
    .trim()
    .split("\n");
  assert.deepEqual(
    manifest.files
      .filter((file) => file.path.startsWith("src/"))
      .map((file) => file.path),
    modules,
  );
  for (const file of manifest.files) {
    const bytes = git("show", `${commit}:${file.path}`);
    assert.equal(file.sha256, sha256(bytes));
    assert.equal(file.size, bytes.length);
  }
  const payload = headers(gunzipSync(original)).map((file) => file.path);
  assert.deepEqual(payload, [
    ...manifest.files.map((file) => file.path),
    "release-manifest.json",
  ]);
  assert.ok(payload.includes(".github/workflows/slop-review.md"));
  assert.ok(payload.includes(".github/workflows/slop-review.lock.yml"));
  assert.ok(payload.includes(".github/workflows/slop-inventory.yml"));
  assert.ok(payload.includes("LICENSE"));
  assert.ok(!payload.includes(".github/workflows/release.yml"));
  await packRelease({
    ref: commit,
    out: resolve(root, "second"),
    repo: source,
  });
  assert.deepEqual(await readFile(resolve(root, "second", filename)), original);
});

it("requires explicit refs and output paths, and refuses version mismatches", async () => {
  await assert.rejects(
    packRelease({ out: resolve(root, "no-ref") }),
    /explicit Git ref/,
  );
  await assert.rejects(packRelease({ ref: commit }), /explicit new output/);
  await assert.rejects(
    packRelease({
      ref: commit,
      repo: source,
      out: resolve(root, "bad-version"),
      version: "v999999.0.0",
    }),
    /does not match package.json/,
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(source, "scripts/release.mjs"),
      "pack",
      "--out",
      resolve(root, "cli-no-ref"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit Git ref/);
  assert.ok(!(await readdir(root)).includes("cli-no-ref"));
});

it("never clears or overwrites an existing output directory", async () => {
  const out = resolve(root, "existing");
  await mkdir(out);
  await writeFile(resolve(out, "keep"), "preserve");
  await assert.rejects(packRelease({ ref: commit, out, repo: source }), {
    code: "EEXIST",
  });
  assert.deepEqual(await readdir(out), ["keep"]);
  assert.equal(await readFile(resolve(out, "keep"), "utf8"), "preserve");
});

it("requires pinned version/commit and checks the compressed checksum", async () => {
  const options = {
    archive: resolve(root, "first", filename),
    checksums: resolve(root, "first", "SHA256SUMS"),
    version: tag,
    commit,
  };
  await assert.rejects(
    verifyRelease({ ...options, version: "v01.0.0" }),
    /MAJOR.MINOR.PATCH/,
  );
  await assert.rejects(
    verifyRelease({ ...options, version: "v999999.0.0" }),
    /filename/,
  );
  await assert.rejects(
    verifyRelease({ ...options, commit: "0".repeat(40) }),
    /Source commit mismatch/,
  );
  const checksums = resolve(root, "wrong-checksums");
  await writeFile(checksums, `${"0".repeat(64)}  ${filename}\n`);
  await assert.rejects(
    verifyRelease({ ...options, checksums }),
    /Archive SHA256 checksum mismatch/,
  );
});

it("checks payload hashes even when the compressed checksum matches", async () => {
  await verifyMutation((raw, entries) => {
    const file = entries.find((entry) => entry.path === "src/runtime.mjs");
    raw[file.data] ^= 1;
  }, /Payload checksum mismatch: src\/runtime.mjs/);
});

it("rejects path traversal, unknown files, links, duplicate paths and hidden tar prefixes", async () => {
  for (const path of [
    "../escape.mjs",
    "/absolute.mjs",
    "src/../escape.mjs",
    ".github/workflows/evil.yml",
  ]) {
    await verifyMutation((raw, entries) => {
      changeHeader(raw, entries[0], (header) => {
        header.fill(0, 0, 100);
        header.write(path);
      });
    }, /Unexpected archive path/);
  }
  await verifyMutation((raw, entries) => {
    changeHeader(raw, entries[0], (header) => {
      header[156] = 50;
    });
  }, /Non-regular archive entry/);
  await verifyMutation((raw, entries) => {
    changeHeader(raw, entries[0], (header) => {
      header.fill(0, 0, 100);
      header.write(entries[1].path);
    });
  }, /Duplicate archive path/);
  await verifyMutation((raw, entries) => {
    changeHeader(raw, entries[0], (header) => {
      header.write("hidden", 345);
    });
  }, /not canonical/);
});

it("rejects missing/unlisted payload, invalid headers, trailing data and manifest tampering", async () => {
  await verifyMutation((raw, entries) => {
    const entry = entries.find((file) => file.path === "src/runtime.mjs");
    const end = entry.offset + 512 + Math.ceil(entry.size / 512) * 512;
    return Buffer.concat([raw.subarray(0, entry.offset), raw.subarray(end)]);
  }, /Manifest file count mismatch/);
  await verifyMutation((raw, entries) => {
    changeHeader(
      raw,
      entries.find((file) => file.path === "src/runtime.mjs"),
      (header) => {
        header.fill(0, 0, 100);
        header.write("src/unlisted.mjs");
      },
    );
  }, /Payload checksum mismatch/);
  await verifyMutation((raw) => {
    raw[148] ^= 1;
  }, /not canonical/);
  await verifyMutation(
    (raw) => Buffer.concat([raw, Buffer.alloc(512)]),
    /not canonical/,
  );
  await verifyMutation((raw, entries) => {
    const entry = entries.find((file) => file.path === "release-manifest.json");
    const needle = Buffer.from(`"tag": "${tag}"`);
    const offset = raw.indexOf(needle, entry.data);
    assert.ok(offset >= entry.data && offset < entry.data + entry.size);
    raw[offset + needle.length - 2] = 120;
  }, /Invalid manifest tag/);
});
