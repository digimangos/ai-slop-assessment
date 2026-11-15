# Exact-version releases

This is a **vendored gh-aw workflow bundle**, not a standalone GitHub Action.
`uses: digimangos/ai-slop-assessment@v0.1.0` is not an installation.
Each release contains:

- the gh-aw Markdown source and compiled `slop-review.lock.yml`;
- the companion deterministic `slop-inventory.yml`;
- **all** `src/**/*.mjs` helpers, preserving their paths;
- `package.json`, optional `.github/aw/actions-lock.json`, and
  `release-manifest.json` with the exact source commit and per-file SHA256 hashes.

Archives made from commits containing `LICENSE` include the ISC licence.
Earlier archives without that file remain verifiable.

The only published assets are `ai-slop-rating-vMAJOR.MINOR.PATCH.tar.gz` and
`SHA256SUMS`. The archive contains regular files only: no dependencies, repository
history, tests, release workflow, installer, or local working-tree changes.
Requires Node.js 24 and Git for packaging; verification needs only Node.js 24.
No npm install is needed.

## Publishing

Before the first release, a repository administrator must enable **immutable
releases** in repository settings. Protect `v*` tags with a ruleset restricting
creation to release maintainers and preventing updates/deletions. Enable required
CI on the default branch. The release workflow checks that the tagged commit is
on default-branch history; only tag trusted, reviewed commits with passing CI.

1. Update `package.json` to an exact `MAJOR.MINOR.PATCH` version, and update its
   lockfile. Use patch for compatible fixes, minor for compatible additions, and
   major for breaking workflow/helper/report contracts.
2. Run the normal CI checks, compile with the pinned gh-aw compiler, and merge
   the complete release preparation into the trusted default branch.
3. From that reviewed commit, create and push the matching annotated tag:

   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0" <REVIEWED_COMMIT_SHA>
   git push origin refs/tags/v0.1.0
   ```

`release.yml` accepts only `vMAJOR.MINOR.PATCH` tag pushes, without leading zeroes,
prerelease suffixes, or build metadata. It tests the packaging, requires the tag
to match the committed package version, and packages only that Git snapshot.
The read-only packaging job passes assets to a separate publisher: only that job
has `contents: write`. It uses the standard `GITHUB_TOKEN`, not a release PAT.
It creates a draft with both assets, publishes it, then checks GitHub's immutable
release flag. It never replaces existing assets, reuses a release, or moves `v1`
or other major tags. Already-created releases fail rather than being overwritten.

GitHub's immutability setting is an **administrative prerequisite**: the workflow
cannot enable/read that repository setting with a contents-only token. Its
post-publication check fails if the setting was omitted, but a mutable release
will already exist in that case. Stop distribution, enable the setting, and
publish a new patch version; never silently replace the old version.
If publication fails while still a draft, inspect it manually; retries do not
delete or overwrite drafts.

## Package and validate locally

Run the packaging tool from a trusted checkout. Both the Git ref and a **new**
output directory are mandatory. The output's parent directory must exist.

```sh
mkdir -p dist
node scripts/release.mjs pack --ref refs/tags/v0.1.0 --out dist/v0.1.0
node scripts/release.mjs verify \
  --archive dist/v0.1.0/ai-slop-rating-v0.1.0.tar.gz \
  --checksums dist/v0.1.0/SHA256SUMS \
  --version v0.1.0 --commit <REVIEWED_COMMIT_SHA>
```

An explicit commit or branch ref also works for local packaging. Add
`--version v0.1.0` to require its package version to match an expected release.
Omitting `--ref` is an error; there is no implicit `HEAD`. Output creation is exclusive; nothing is deleted or
overwritten. The same ref produces byte-identical archives. Verification checks
the compressed checksum, exact expected version/optional commit, required files,
package metadata, the manifest's complete payload hashes, and the canonical
archive structure. Unknown paths, duplicates, links, traversal, extra archives,
invalid tar headers, and oversized archives are rejected.

## Pin and install in another repository

Choose an **exact** published version, not `latest`, a branch, or a moving major
tag. Use a trusted checkout of that release's source for the verifier; do not
execute a verifier or any other code extracted from an unverified archive.
Record the reviewed 40-character source commit independently of the downloaded
manifest. For example, from a trusted source checkout:

```sh
mkdir release-download
gh release download v0.1.0 --repo digimangos/ai-slop-assessment \
  --pattern ai-slop-rating-v0.1.0.tar.gz --pattern SHA256SUMS \
  --dir release-download
node scripts/release.mjs verify \
  --archive release-download/ai-slop-rating-v0.1.0.tar.gz \
  --checksums release-download/SHA256SUMS \
  --version v0.1.0 --commit <REVIEWED_COMMIT_SHA>
mkdir release-download/unpacked
tar -xzf release-download/ai-slop-rating-v0.1.0.tar.gz \
  -C release-download/unpacked
```

After verification, manually copy **only** the three assessment workflow files,
all `src/` modules, and optional `.github/aw/actions-lock.json` into the adopting
repository at those same relative paths. Do not copy upstream `package.json`
over the consumer's package manifest. Retain the bundled `LICENSE` notice when
redistributing the files. Keep `release-manifest.json` as a pin
record (for example `.github/slop-release-manifest.json`). Inspect existing files
and path collisions before copying; there is deliberately no overwrite installer
or install hook, and extraction does not execute bundled code.

Review the vendored changes in a PR, then merge **helpers and workflows together
onto the trusted default branch before running assessments**. Do not change the
default-branch checkouts to a PR head, execute proposed PR code, or add
`pull_request_target` bootstrap logic. A Markdown-only `gh aw add ...@v0.1.0`
does not install the companion workflow or helpers and is insufficient.

The compiled lock is included; compilation is only needed if customising its
Markdown source, using the repository's pinned gh-aw compiler/action revision.
Follow the main README for configuration and optional model authentication;
release installation/publication itself needs no PAT, while optional model
authentication is a separate concern.

Upgrade by repeating verification and reviewing the complete new bundle. Retain
the exact tag/commit/manifest in the consumer's history; rollback by restoring
the prior complete bundle. Never mix helpers and workflows from different
releases. SHA256 detects corruption, not publisher identity: trust the repository,
reviewed commit, immutable release origin, and downloaded verifier separately.
