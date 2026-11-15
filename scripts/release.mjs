import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseIdentity({ tag, version, ref, defaultBranch, commit }) {
  if (typeof version !== "string" || !SEMVER.test(version))
    throw new Error("package.json must contain an exact MAJOR.MINOR.PATCH");
  if (tag !== `v${version}`)
    throw new Error("Release tag must match the package version");
  if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`)
    throw new Error("Release must run on the default branch");
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("Release commit must be a full Git SHA");
  return { tag, commit };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const result = releaseIdentity({
      tag: process.env.RELEASE_TAG,
      version: pkg.version,
      ref: process.env.GITHUB_REF,
      defaultBranch: process.env.DEFAULT_BRANCH,
      commit: process.env.GITHUB_SHA,
    });
    console.log(`tag=${result.tag}\ncommit=${result.commit}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
