# Releases

The product is the reusable workflows `.github/workflows/assess.yml` and
`.github/workflows/assess-org.yml` and the files they load from the same Git commit.
Consumers should pin the workflow to the full commit SHA associated with an
exact release, as shown in the [installation guide](../README.md#install-the-reusable-workflow).
No vendored bundle or separate installer is required.

## Publishing

A maintainer starts the **Publish exact-version release** workflow manually;
merging a change or pushing a tag does not publish a release. Before running it:

1. Enable immutable releases in the repository settings and protect release
   tags against modification or deletion. Restrict who can trigger releases.
2. Set `package.json` and `package-lock.json` to the intended exact semantic
   version and merge the reviewed changes to the default branch.
3. Check that the default branch has passing CI. From the Actions tab, run the
   workflow on the default branch with the matching tag, for example `v1.1.0`,
   and confirm that immutable releases are enabled. Alternatively:

   ```sh
   gh workflow run release.yml --ref main -f tag=v1.1.0 -f immutable_confirmed=true
   ```

The workflow validates the tag, version and branch; runs offline checks and
verifies the compiled workflow; then rechecks the default-branch head. A separate
write-enabled job creates an annotated tag at that exact commit, verifies it,
and publishes a GitHub release. Existing tags are never moved or overwritten.
After publication it verifies GitHub reports the release as immutable.

The immutability confirmation is an administrative prerequisite, not a
programmatic preflight: the Actions token may not have permission to read that
repository setting. If immutability is disabled, a mutable release can already
exist when the final check fails. Stop distribution, enable the setting and
publish a new version; never silently replace the existing release.

If publication fails after creating the tag, inspect the tag and any draft
release before taking further action. A rerun will not overwrite the tag.
Consumers should independently verify the release commit before pinning it;
do not use a moving branch or tag as a substitute for an immutable SHA.
