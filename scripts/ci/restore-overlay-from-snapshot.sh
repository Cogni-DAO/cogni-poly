#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/restore-overlay-from-snapshot.sh
# Purpose: Replay a deploy-branch overlay snapshot (3-col TSV from
#   snapshot-overlay-digests.sh) back into the working tree, one
#   promote-k8s-image call per image entry. Catalog v2 — multi-image safe.
#
# Order contract: this runs AFTER the rsync-from-main step and BEFORE the
# promote step. Rsync clobbers overlay digests with whatever main pinned
# (typically `<env>-placeholder-*` newTags for sidecars main never
# promotes). Restoring the snapshot first returns every image to its
# prior live digest; the subsequent promote step then overwrites just
# the PR-affected images with new digests.
#
# Why not "skip the units being promoted": PROMOTED_APPS is per-deploy-
# unit, while clobber happens per-image. A PR touching one image of a
# multi-image unit (e.g. paper-sidecar of poly) would skip the whole
# unit and leave sibling sidecars on the post-rsync placeholder →
# ImagePullBackOff. Restoring everything and letting promote overwrite
# is the simple correct shape.
#
# Env:
#   SNAPSHOT_FILE   (required) TSV path produced by snapshot-overlay-
#                              digests.sh. 3 cols: deploy_unit\timage_name\tref
#   OVERLAY_ENV     (required) overlay env (e.g. candidate-a)
#   RESTORE_MODE    (REQUIRED — no default; per design-review of bug.5012,
#                    every caller must declare intent so a future YAML edit
#                    that drops the env line hard-fails instead of silently
#                    flipping safety). Only valid value: `always`.
#     - `always`: replay every digest pin from snapshot, overwriting whatever
#       the current overlay holds. The deploy branch's prior digest is
#       authoritative for live images; rsync sources (PR branch for
#       candidate-flight, main for promote-and-deploy) are cold-start seeds
#       only — see bug.5013 for why main is not trustworthy as a digest
#       source for live images.
#     The legacy `only-when-placeholder` mode (which let main's stale digests
#     override the snapshot) was removed in bug.5013 after live evidence that
#     main's digest pins regress unaffected sidecars on every promote.
#   OVERLAY_DIGEST_LIB (optional) path to lib/overlay-digest.sh (default:
#       resolved from PROMOTE_SCRIPT or SCRIPT_DIR siblings).
#   PROMOTE_SCRIPT  (optional) path to promote-k8s-image.sh
#
# cwd: deploy-branch checkout root (so promote-k8s-image resolves
#      infra/k8s/overlays/${OVERLAY_ENV}/${unit}/kustomization.yaml).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SNAPSHOT_FILE=${SNAPSHOT_FILE:?SNAPSHOT_FILE required}
OVERLAY_ENV=${OVERLAY_ENV:?OVERLAY_ENV required}
# No default — every caller must declare intent. Keeps the safety-axiom
# from bug.5012 design-review B1: a future YAML edit that drops the env
# line hard-fails instead of silently flipping behavior.
RESTORE_MODE=${RESTORE_MODE:?RESTORE_MODE required (always)}
PROMOTE_SCRIPT=${PROMOTE_SCRIPT:-${SCRIPT_DIR}/promote-k8s-image.sh}

case "$RESTORE_MODE" in
  always) ;;
  *)
    echo "[ERROR] RESTORE_MODE must be 'always' (got: ${RESTORE_MODE}). The 'only-when-placeholder' mode was removed in bug.5013." >&2
    exit 1
    ;;
esac

# When invoked from candidate-flight.yml / promote-and-deploy.yml the script
# lives in the app-src checkout while cwd is deploy-branch — accept either
# layout for both PROMOTE_SCRIPT and the overlay-digest lib.
if [ ! -x "$PROMOTE_SCRIPT" ] && [ -f "../app-src/scripts/ci/promote-k8s-image.sh" ]; then
  PROMOTE_SCRIPT="../app-src/scripts/ci/promote-k8s-image.sh"
fi
if [ ! -x "$PROMOTE_SCRIPT" ] && [ -f "../ci-src/scripts/ci/promote-k8s-image.sh" ]; then
  PROMOTE_SCRIPT="../ci-src/scripts/ci/promote-k8s-image.sh"
fi

OVERLAY_DIGEST_LIB=${OVERLAY_DIGEST_LIB:-"$(dirname "$PROMOTE_SCRIPT")/lib/overlay-digest.sh"}
if [ ! -f "$OVERLAY_DIGEST_LIB" ] && [ -f "${SCRIPT_DIR}/lib/overlay-digest.sh" ]; then
  OVERLAY_DIGEST_LIB="${SCRIPT_DIR}/lib/overlay-digest.sh"
fi
# shellcheck source=./lib/overlay-digest.sh disable=SC1090
. "$OVERLAY_DIGEST_LIB"

if [ ! -s "$SNAPSHOT_FILE" ]; then
  echo "ℹ️  No snapshot rows (cold-start) — nothing to restore"
  exit 0
fi

restored=0
skipped_non_digest=0
skipped_removed=0
while IFS=$'\t' read -r unit image_name ref; do
  [ -z "$unit" ] && continue
  # Tag pins (placeholders) had no real image to begin with; leave the
  # rsync'd value in place so promote can write a real digest (or
  # legitimately skip via rc=2). Only digest pins are safe to replay.
  if [[ "$ref" != *"@sha256:"* ]]; then
    skipped_non_digest=$((skipped_non_digest + 1))
    continue
  fi
  # promote-k8s-image exit codes (contract):
  #   0 → wrote digest (or no-op because already current)
  #   2 → no matching images[] entry in overlay → legitimate skip
  #       (e.g. an image was removed from main's overlay between flights;
  #       restoring a phantom entry would re-introduce drift)
  #   1 → real error → propagate
  set +e
  bash "$PROMOTE_SCRIPT" --no-commit \
    --env "$OVERLAY_ENV" --app "$unit" \
    --image-name "$image_name" --digest "$ref"
  rc=$?
  set -e
  case "$rc" in
    0)
      restored=$((restored + 1))
      ;;
    2)
      echo "::notice::Snapshot row for ${unit}/${image_name} has no matching overlay entry (image removed from main?) — skipping"
      skipped_removed=$((skipped_removed + 1))
      ;;
    *)
      echo "::error::promote-k8s-image failed during restore (rc=${rc}) for ${unit}/${image_name}" >&2
      exit "$rc"
      ;;
  esac
done < "$SNAPSHOT_FILE"

echo "Restored ${restored} digest pin(s); skipped ${skipped_non_digest} non-digest row(s), ${skipped_removed} removed-image row(s)"
