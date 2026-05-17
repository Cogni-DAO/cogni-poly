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
#   RESTORE_MODE    (optional) `always` (default) or `only-when-placeholder`.
#     - `always`: replay every digest pin from snapshot, overwriting whatever
#       the current overlay holds. Correct for candidate-a where rsync is
#       from PR-branch (advisory per task.0373) → snapshot always wins.
#     - `only-when-placeholder`: replay snapshot digest ONLY when current
#       overlay holds a tag pin (placeholder). Correct for preview/production
#       where rsync is from main (canonical per Axiom 17) → main wins on real
#       digests, snapshot fills placeholder holes. Closes bug.5012.
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
RESTORE_MODE=${RESTORE_MODE:-always}
PROMOTE_SCRIPT=${PROMOTE_SCRIPT:-${SCRIPT_DIR}/promote-k8s-image.sh}

case "$RESTORE_MODE" in
  always|only-when-placeholder) ;;
  *)
    echo "[ERROR] RESTORE_MODE must be 'always' or 'only-when-placeholder' (got: ${RESTORE_MODE})" >&2
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

# Returns 0 if current overlay value for (unit, image_name) is a tag pin
# (placeholder) or missing → safe to restore from snapshot. Returns 1 if
# it's already a digest pin → keep the current value (main wins).
current_is_placeholder() {
  local unit="$1" image_name="$2" current
  current=$(extract_overlay_image_refs_all "$OVERLAY_ENV" "$unit" 2>/dev/null \
    | awk -F'\t' -v n="$image_name" '$1==n {print $2; exit}')
  # Missing entry counts as placeholder — promote-k8s-image will rc=2 and
  # we skip cleanly per the existing case below.
  [[ "$current" != *"@sha256:"* ]]
}

if [ ! -s "$SNAPSHOT_FILE" ]; then
  echo "ℹ️  No snapshot rows (cold-start) — nothing to restore"
  exit 0
fi

restored=0
skipped_non_digest=0
skipped_main_wins=0
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
  # `only-when-placeholder` mode (preview/production): if main's rsync
  # brought a real digest, keep it — Axiom 17 INFRA_K8S_MAIN_DERIVED says
  # main is canonical. Only fill placeholder holes from snapshot.
  if [ "$RESTORE_MODE" = "only-when-placeholder" ] && ! current_is_placeholder "$unit" "$image_name"; then
    skipped_main_wins=$((skipped_main_wins + 1))
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

echo "Restored ${restored} digest pin(s); skipped ${skipped_non_digest} non-digest row(s), ${skipped_main_wins} main-wins row(s), ${skipped_removed} removed-image row(s) (mode=${RESTORE_MODE})"
