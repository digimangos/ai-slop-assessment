#!/usr/bin/env bash
set -euo pipefail

test "$(gh api "repos/$GH_REPO/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha)" = "$COMMIT"
TAG_OBJECT="$(gh api "repos/$GH_REPO/git/tags" \
  -f tag="$TAG" -f message="Release $TAG" -f object="$COMMIT" -f type=commit \
  -f 'tagger[name]=github-actions[bot]' \
  -f 'tagger[email]=41898282+github-actions[bot]@users.noreply.github.com' \
  --jq .sha)"
gh api "repos/$GH_REPO/git/refs" -f ref="refs/tags/$TAG" -f sha="$TAG_OBJECT"
test "$(gh api "repos/$GH_REPO/commits/$TAG" --jq .sha)" = "$COMMIT"
gh release create "$TAG" --verify-tag --title "$TAG" --generate-notes --draft
gh release edit "$TAG" --draft=false
if test "$(gh api "repos/$GH_REPO/releases/tags/$TAG" --jq .immutable)" != true; then
  echo "::error::Release immutability is not enabled. Enable it before further releases; do not reuse this version."
  exit 1
fi
