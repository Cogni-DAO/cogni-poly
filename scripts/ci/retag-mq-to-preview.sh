#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/retag-mq-to-preview.sh
# Purpose: For each image actually built by pr-build's merge_group leg
#   (RESOLVED_TARGETS), retag the GHCR `mq-{N}-{HEAD_SHA}` image as
#   `preview-{HEAD_SHA}` so promote-and-deploy can resolve the preview
#   tag without a rebuild (bug.0412 + task.0349). One docker buildx
#   imagetools create per image.
#
# Iterates RESOLVED_TARGETS DIRECTLY (CSV). Earlier inline-YAML logic
# iterated ALL_IMAGES and filtered with `grep -qw "$image"` against
# the CSV — that grep produced false positives via word-boundary
# matching (e.g. `grep -qw poly` matched `poly-test-worker` because
# `-` is a non-word char), causing retag attempts on images that were
# never built and failing the auto-flight-preview. Direct iteration
# eliminates the bug class.
#
# Env:
#   RESOLVED_TARGETS  (required) CSV of catalog image names from
#                                resolve-pr-build-images.sh
#   PR_IMAGE_TAG      (required) source tag base, e.g. mq-82-{sha}
#   PREVIEW_TAG       (required) destination tag base, e.g. preview-{sha}
#
# Side effects: GHCR write (manifest-list retag). No rebuilds.
# Idempotent: re-running with the same inputs is a no-op on GHCR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

RESOLVED_TARGETS=${RESOLVED_TARGETS:?RESOLVED_TARGETS required}
PR_IMAGE_TAG=${PR_IMAGE_TAG:?PR_IMAGE_TAG required}
PREVIEW_TAG=${PREVIEW_TAG:?PREVIEW_TAG required}

retagged=0
IFS=',' read -r -a targets <<< "$RESOLVED_TARGETS"
for image in "${targets[@]}"; do
  # Defensive trim — CSV may have stray whitespace from upstream emitters.
  image="${image## }"
  image="${image%% }"
  [ -z "$image" ] && continue
  src=$(image_tag_for_image "$image" "$PR_IMAGE_TAG")
  dst=$(image_tag_for_image "$image" "$PREVIEW_TAG")
  echo "Re-tagging ${image}: ${src##*/} → ${dst##*/}"
  docker buildx imagetools create --tag "$dst" "$src"
  retagged=$((retagged + 1))
done

echo "✅ Re-tag complete for ${PREVIEW_TAG} (${retagged} image(s))"
