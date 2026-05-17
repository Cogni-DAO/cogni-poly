#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/promote-build-payload.sh
# Purpose: Apply a resolved per-image payload to a deploy-unit's overlay via
#   promote-k8s-image.sh. Runs from the deploy-branch checkout.
#
# Catalog v2: iterates `images_for_deploy_unit($NODE)`. Hardcoded
# operator|poly|resy|scheduler-worker case-guard is gone — adding an image to
# a node's images[] array makes promote-build-payload promote it automatically.
#
# Side-effects:
#   - Writes overlay digest fields under infra/k8s/overlays/{OVERLAY_ENV}/.
#     One promote-k8s-image call per image of the deploy unit.
#   - Emits $GITHUB_OUTPUT.promoted_apps = CSV. Contains the DEPLOY-UNIT
#     name (not per-image names) so downstream verify-buildsha + release-slot
#     gates keep their existing deploy-unit semantics. Empty when no overlay
#     write actually happened for any image of this unit (legitimate skip).
#   - Merges {deploy-unit → source_sha} into .promote-state/source-sha-by-app.json
#     (one entry per unit; source_sha is the payload's top-level build SHA).
#
# Per-image exit codes from promote-k8s-image.sh:
#   0 → digest written → image counted as promoted
#   2 → no matching images[] entry in overlay (e.g. paper-sidecar not in
#       production) → legitimate skip, NOT counted
#   1 → error → script fails
#
# An overlay write for any image of the unit means the unit's source_sha map
# entry advances. Empty promoted-image set → unit is treated as a no-op.
#
# Env:
#   PAYLOAD_FILE    (required) path to resolved-pr-images.json (v2 shape)
#   OVERLAY_ENV     (required) candidate-a | preview | production
#   NODE            (required) deploy unit name (catalog file name) being
#                              promoted in this matrix leg
#   MAP_FILE        (optional) .promote-state/source-sha-by-app.json path
#   PROMOTE_SCRIPT  (optional) path to promote-k8s-image.sh
#   MAP_SCRIPT      (optional) path to update-source-sha-map.sh

set -euo pipefail

SCRIPT_DIR_BUILTIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PAYLOAD_FILE=${PAYLOAD_FILE:-}
OVERLAY_ENV=${OVERLAY_ENV:-}
NODE=${NODE:-}
PROMOTE_SCRIPT=${PROMOTE_SCRIPT:-${SCRIPT_DIR_BUILTIN}/promote-k8s-image.sh}
MAP_SCRIPT=${MAP_SCRIPT:-${SCRIPT_DIR_BUILTIN}/update-source-sha-map.sh}
MAP_FILE=${MAP_FILE:-.promote-state/source-sha-by-app.json}

# Callers under the deploy-branch checkout (candidate-flight, promote-and-
# deploy) pass PROMOTE_SCRIPT via env pointing at the app-src copy. Keep
# back-compat with that path so the existing workflows don't need a
# simultaneous edit.
if [ ! -x "$PROMOTE_SCRIPT" ] && [ -f "../app-src/scripts/ci/promote-k8s-image.sh" ]; then
  PROMOTE_SCRIPT="../app-src/scripts/ci/promote-k8s-image.sh"
fi
if [ ! -x "$MAP_SCRIPT" ] && [ -f "../app-src/scripts/ci/update-source-sha-map.sh" ]; then
  MAP_SCRIPT="../app-src/scripts/ci/update-source-sha-map.sh"
fi

# Locate image-tags.sh — prefer the one next to promote-k8s-image.sh (its
# canonical home in the app-src tree under CI workflows).
IMAGE_TAGS_LIB="$(dirname "$PROMOTE_SCRIPT")/lib/image-tags.sh"
if [ ! -f "$IMAGE_TAGS_LIB" ] && [ -f "${SCRIPT_DIR_BUILTIN}/lib/image-tags.sh" ]; then
  IMAGE_TAGS_LIB="${SCRIPT_DIR_BUILTIN}/lib/image-tags.sh"
fi
# shellcheck source=./lib/image-tags.sh disable=SC1090
. "$IMAGE_TAGS_LIB"

if [ -z "$PAYLOAD_FILE" ] || [ ! -f "$PAYLOAD_FILE" ]; then
  echo "[ERROR] PAYLOAD_FILE is required and must exist" >&2
  exit 1
fi
if [ -z "$OVERLAY_ENV" ]; then
  echo "[ERROR] OVERLAY_ENV is required" >&2
  exit 1
fi
if [ -z "$NODE" ]; then
  echo "[ERROR] NODE is required (deploy unit name)" >&2
  exit 1
fi

# Top-level source_sha from the payload envelope. Same purpose as v1:
# feeds the source-sha-by-app map for cross-env contract verification.
source_sha=$(python3 - "$PAYLOAD_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload.get("source_sha", ""))
PY
)

# Track whether any image of this NODE got a real overlay write — drives
# both promoted_apps (deploy-unit CSV) and the source-sha-map decision.
PROMOTED_ANY=0

emit_promoted_apps() {
  local csv=""
  if [ "$PROMOTED_ANY" -eq 1 ]; then
    csv="$NODE"
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "promoted_apps=${csv}" >> "$GITHUB_OUTPUT"
  fi
}

# bug.0328: EXIT trap guarantees promoted_apps is written even on abort.
trap emit_promoted_apps EXIT

extract_image_entry() {
  local image="$1"
  python3 - "$PAYLOAD_FILE" "$image" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
for item in payload["targets"]:
    if item["target"] == sys.argv[2]:
        print("{}\t{}".format(item.get("image_name", ""), item.get("digest", "")))
        break
PY
}

# Get the list of images owned by this deploy unit.
unit_images=$(images_for_deploy_unit "$NODE") || {
  echo "[ERROR] unknown deploy unit: $NODE" >&2
  exit 1
}

# Per-image promotion loop.
promoted_images=()
for image in $unit_images; do
  entry=$(extract_image_entry "$image")
  image_name=$(printf '%s' "$entry" | cut -f1)
  digest=$(printf '%s' "$entry" | cut -f2)

  if [ -z "$digest" ]; then
    echo "::notice::No digest for image '${image}' in payload — image not in this build (affected-only CI skipped it)"
    continue
  fi
  if [ -z "$image_name" ]; then
    # Fallback: derive image_name from catalog rather than the payload — keeps
    # us aligned with the overlay's images[] entry name even if the payload
    # producer is older.
    image_name=$(image_name_for_image "$image")
  fi

  echo "Promoting image '${image}' (${image_name}) into ${OVERLAY_ENV}/${NODE} overlay"

  set +e
  bash "$PROMOTE_SCRIPT" --no-commit \
    --env "$OVERLAY_ENV" --app "$NODE" \
    --image-name "$image_name" --digest "$digest"
  rc=$?
  set -e

  case "$rc" in
    0)
      promoted_images+=("$image")
      PROMOTED_ANY=1
      emit_promoted_apps
      ;;
    2)
      echo "::notice::Overlay ${OVERLAY_ENV}/${NODE} has no images[] entry for ${image_name} — intentional skip (e.g. sidecar absent from production)"
      ;;
    *)
      echo "::error::promote-k8s-image failed for image=${image} rc=${rc}" >&2
      exit 1
      ;;
  esac
done

# Source-sha-map pass: one entry per DEPLOY UNIT (not per image). Map key is
# the deploy-unit name so verify-buildsha (which probes /version on the
# unit's public_url) reads back the right SHA.
MAP_FAILURE=0
if [ "$PROMOTED_ANY" -eq 1 ]; then
  if [ -z "$source_sha" ]; then
    echo "::warning::source_sha missing from payload — skipping map update for ${NODE}"
    MAP_FAILURE=1
  elif ! APP="$NODE" SOURCE_SHA="$source_sha" MAP_FILE="$MAP_FILE" bash "$MAP_SCRIPT"; then
    echo "::warning::source-sha-map write failed for ${NODE} — overlay already promoted, provenance side-car not updated"
    MAP_FAILURE=1
  fi
fi

emit_promoted_apps
if [ "$PROMOTED_ANY" -eq 0 ]; then
  echo "Promoted images: none (deploy unit ${NODE} had nothing to write)"
else
  echo "Promoted images for ${NODE}: $(IFS=,; echo "${promoted_images[*]}")"
fi

# Hard break: source-sha map dead → fail loudly so humans investigate rather
# than letting provenance decay silently.
if [ "$PROMOTED_ANY" -eq 1 ] && [ "$MAP_FAILURE" -eq 1 ]; then
  echo "::error::source-sha-map write failed for ${NODE} — provenance side-car is dead (check MAP_SCRIPT=${MAP_SCRIPT} and payload source_sha)"
  exit 1
fi
