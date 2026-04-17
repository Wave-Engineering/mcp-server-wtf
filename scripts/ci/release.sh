#!/usr/bin/env bash
set -euo pipefail

# Create a GitHub Release and attach all artifacts.
# Usage: release.sh <tag>
# Called by the release workflow after binaries are built.

TAG="${1:?Usage: release.sh <tag>}"

echo "=== Creating release ${TAG} ==="

# Collect binaries from the download-artifact step.
mkdir -p release-assets
find artifacts -type f -name 'wtf-server-*' -exec cp {} release-assets/ \;
find release-assets -type f -name 'wtf-server-*' -exec chmod +x {} \;

# Copy hook and installer into release assets.
cp scripts/hooks/wtf-post-tool-use.sh release-assets/
cp scripts/install-remote.sh release-assets/

# Create the release (or upload to an existing one).
if gh release view "$TAG" &>/dev/null; then
    echo "Release ${TAG} already exists — uploading assets"
    gh release upload "$TAG" release-assets/* --clobber
else
    gh release create "$TAG" release-assets/* \
        --title "$TAG" \
        --generate-notes
fi

echo "=== Release ${TAG} created ==="
