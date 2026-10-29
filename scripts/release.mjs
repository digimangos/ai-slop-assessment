import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const NAME = "ai-slop-rating";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST = "release-manifest.json";
const REQUIRED = [
  "package.json",
  ".github/workflows/slop-review.md",
  ".github/workflows/slop-review.lock.yml",
  ".github/workflows/slop-inventory.yml",
  "src/runtime.mjs",
];
const OPTIONAL = ".github/aw/actions-lock.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function allowedPath(path) {
  return (
    REQUIRED.includes(path) ||
    path === OPTIONAL ||
    (/^src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs$/.test(path) &&
      !path.split("/").some((part) => part === "." || part === ".."))
  );
}

function releaseTag(version) {
  check(
    typeof version === "string" && VERSION.test(version),
    "Expected MAJOR.MINOR.PATCH without prerelease/build metadata",
  );
  return `v${version}`;
}

function archiveName(tag) {
  return `${NAME}-${tag}.tar.gz`;
}

// A deliberately small canonical ustar subset: regular files only, no links,
// extended headers, ownership, timestamps, or platform-dependent tar options.
function tar(files) {
  const chunks = [];
  for (const { path, content } of files) {
    check(
      /^[\x20-\x7e]+$/.test(path) && Buffer.byteLength(path) <= 100,
      `Unsupported archive path: ${path}`,
    );
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "ascii");
    const octal = (value, offset, length) =>
      header.write(
        `${value.toString(8).padStart(length - 1, "0")}\0`,
        offset,
        length,
        "ascii",
      );
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(chunks);
  check(bytes.length <= MAX_BYTES, "Release archive exceeds size limit");
  return bytes;
}

function untar(bytes) {
  check(
    bytes.length <= MAX_BYTES && bytes.length % 512 === 0,
    "Invalid archive size",
  );
  const files = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = header
      .subarray(0, 100)
      .toString("ascii")
      .replace(/\0.*$/s, "");
    const sizeField = header.subarray(124, 136).toString("ascii");
    check(/^[0-7]{11}\0$/.test(sizeField), "Invalid tar size");
    const size = Number.parseInt(sizeField, 8);
    check(
      path === MANIFEST || allowedPath(path),
      `Unexpected archive path: ${path}`,
    );
    check(!seen.has(path), `Duplicate archive path: ${path}`);
    check(header[156] === 48, `Non-regular archive entry: ${path}`);
    check(offset + 512 + size <= bytes.length, "Truncated archive");
    seen.add(path);
    files.push({
      path,
      content: bytes.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  // Re-encoding rejects checksum mismatches, hidden prefix/link fields,
  // nonzero padding, trailing archives, and other extractor ambiguities.
  check(tar(files).equals(bytes), "Archive is not canonical");
  return files;
}

function validateFiles(files, { version, commit } = {}) {
  const manifestFile = files.find((file) => file.path === MANIFEST);
  check(manifestFile, "Missing release manifest");
  const manifest = JSON.parse(manifestFile.content.toString("utf8"));
  check(
    manifest.schema_version === 1 && manifest.name === NAME,
    "Unsupported release manifest",
  );
  check(manifest.tag === releaseTag(manifest.version), "Invalid manifest tag");
  check(/^[a-f0-9]{40}$/.test(manifest.commit), "Invalid source commit");
  if (version) check(manifest.tag === version, "Release version mismatch");
  if (commit) check(manifest.commit === commit, "Source commit mismatch");
  check(
    Array.isArray(manifest.files) && manifest.files.length === files.length - 1,
    "Manifest file count mismatch",
  );
  const payload = new Map(
    files
      .filter((file) => file.path !== MANIFEST)
      .map((file) => [file.path, file.content]),
  );
  const listed = new Set();
  for (const entry of manifest.files) {
    check(
      allowedPath(entry.path) && !listed.has(entry.path),
      "Invalid manifest path",
    );
    const content = payload.get(entry.path);
    check(
      content &&
        content.length === entry.size &&
        hash(content) === entry.sha256,
      `Payload checksum mismatch: ${entry.path}`,
    );
    listed.add(entry.path);
  }
  for (const path of REQUIRED)
    check(payload.has(path), `Missing required payload: ${path}`);
  const pkg = JSON.parse(payload.get("package.json").toString("utf8"));
  check(
    pkg.name === NAME && pkg.version === manifest.version,
    "Package metadata mismatch",
  );
  return manifest;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function packRelease({ ref, out, version, repo = process.cwd() }) {
  check(
    typeof ref === "string" && ref.length > 0 && !ref.startsWith("-"),
    "An explicit Git ref is required",
  );
  check(
    typeof out === "string" && out.length > 0,
    "An explicit new output directory is required",
  );
  const commit = git(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ])
    .toString()
    .trim();
  const entries = git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    "--",
    "package.json",
    ".github/workflows/slop-review.md",
    ".github/workflows/slop-review.lock.yml",
    ".github/workflows/slop-inventory.yml",
    "src",
    OPTIONAL,
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  const files = entries
    .map((entry) => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      check(
        match && allowedPath(match[2]),
        `Unsupported release tree entry: ${entry}`,
      );
      return {
        path: match[2],
        content: git(repo, ["cat-file", "blob", match[1]]),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const path of REQUIRED)
    check(
      files.some((file) => file.path === path),
      `Missing required payload: ${path}`,
    );
  const pkg = JSON.parse(
    files.find((file) => file.path === "package.json").content.toString("utf8"),
  );
  const tag = releaseTag(pkg.version);
  check(pkg.name === NAME, "Unexpected package name");
  const refTag = ref.replace(/^refs\/tags\//, "");
  if (ref.startsWith("refs/tags/") || /^v\d/.test(refTag))
    check(refTag === tag, "Git tag does not match package.json version");
  if (version)
    check(version === tag, "Git tag does not match package.json version");
  const manifest = {
    schema_version: 1,
    name: NAME,
    version: pkg.version,
    tag,
    commit,
    files: files.map(({ path, content }) => ({
      path,
      size: content.length,
      sha256: hash(content),
    })),
  };
  files.push({
    path: MANIFEST,
    content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  validateFiles(files, { version: tag, commit });
  const archive = gzipSync(tar(files), { level: 9 });
  // Output is create-only. Never clear or replace a caller-supplied directory.
  await mkdir(resolve(out));
  const filename = archiveName(tag);
  await writeFile(resolve(out, filename), archive, { flag: "wx" });
  await writeFile(
    resolve(out, "SHA256SUMS"),
    `${hash(archive)}  ${filename}\n`,
    { flag: "wx" },
  );
  return manifest;
}

export async function verifyRelease({ archive, checksums, version, commit }) {
  check(
    typeof version === "string" &&
      version.startsWith("v") &&
      releaseTag(version.slice(1)) === version,
    "An exact vMAJOR.MINOR.PATCH is required",
  );
  check(
    basename(archive) === archiveName(version),
    "Unexpected archive filename",
  );
  check(
    (await stat(archive)).size <= MAX_BYTES,
    "Compressed archive exceeds size limit",
  );
  check((await stat(checksums)).size <= 1024, "Unexpected checksum file size");
  const bytes = await readFile(archive);
  const expected = `${hash(bytes)}  ${archiveName(version)}\n`;
  check(
    (await readFile(checksums, "utf8")) === expected,
    "Archive SHA256 checksum mismatch",
  );
  const files = untar(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }));
  return validateFiles(files, { version, commit });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const allowed =
    command === "pack"
      ? ["ref", "out", "version"]
      : command === "verify"
        ? ["archive", "checksums", "version", "commit"]
        : [];
  check(
    allowed.length > 0 && args.length % 2 === 0,
    "Usage: release.mjs pack --ref REF --out NEW_DIR [--version vX.Y.Z] | verify --archive FILE --checksums FILE --version vX.Y.Z [--commit SHA]",
  );
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, "");
    check(
      args[index].startsWith("--") &&
        allowed.includes(key) &&
        !(key in options) &&
        args[index + 1],
      `Invalid option: ${args[index]}`,
    );
    options[key] = args[index + 1];
  }
  const manifest = await (command === "pack"
    ? packRelease(options)
    : verifyRelease(options));
  console.log(`${manifest.name} ${manifest.tag} (${manifest.commit})`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
