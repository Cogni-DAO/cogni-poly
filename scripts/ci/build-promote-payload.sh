#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/build-promote-payload.sh
# Purpose: Catalog v2 payload-builder for promote-and-deploy.yml's promote-k8s
#          matrix. Given a deploy unit (NODE), build a payload JSON that
#          promote-build-payload.sh can consume — one entry per image of the
#          deploy unit.
#
# Two resolution modes:
#   GHCR mode (default)         — look up each image's `preview-${HEAD_SHA}`
#                                 tag in GHCR, resolve to digest.
#   Preview-forward (production) — read each image's digest from the
#                                  preview-src deploy branch's overlay file
#                                  (preserves the affected-only mixed-SHA
#                                  state preview has already proven).
#
# Env:
#   NODE              (required) deploy unit name
#   OUTPUT_FILE       (required) where to write the payload JSON
#   HEAD_SHA          (required for GHCR mode) merge SHA for `preview-<sha>`
#   PREVIEW_FORWARD   "true" to use preview-forward mode (default: GHCR)
#   PREVIEW_SRC_DIR   (required when PREVIEW_FORWARD=true) path to the
#                     deploy/preview-<NODE> checkout root
#   BUILD_SHA         (optional) override for source_sha when GHCR mode
#                     (default: HEAD_SHA — promote-build-payload's source_sha
#                     is the SHA baked into /version.buildSha)
#
# Outputs on $GITHUB_OUTPUT:
#   payload_file=<path>
#   has_payload=true|false
#   resolved_images=<csv of image names that found a digest>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

NODE=${NODE:?NODE required}
OUTPUT_FILE=${OUTPUT_FILE:?OUTPUT_FILE required}
PREVIEW_FORWARD=${PREVIEW_FORWARD:-false}

if [ "$PREVIEW_FORWARD" = "true" ]; then
  PREVIEW_SRC_DIR=${PREVIEW_SRC_DIR:?PREVIEW_SRC_DIR required in preview-forward mode}
else
  HEAD_SHA=${HEAD_SHA:?HEAD_SHA required in GHCR mode}
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Resolve image's digest from a preview overlay file by image_name match.
read_overlay_digest_for_image() {
  local overlay_file="$1" target_name="$2"
  python3 - "$overlay_file" "$target_name" <<'PY'
import re, sys
overlay_path, target = sys.argv[1:3]
try:
    with open(overlay_path, "r", encoding="utf-8") as handle:
        text = handle.read()
except FileNotFoundError:
    sys.exit(0)

m = re.search(r'(?ms)^images:\s*\n((?:[ \t]+.*\n)+)', text)
if not m:
    sys.exit(0)
block = m.group(1)
entry_pat = re.compile(r'(?m)^([ \t]+)-\s+name:\s*(\S+)\s*\n((?:\1[ \t]+.*\n)*)')
for em in entry_pat.finditer(block):
    if em.group(2) != target:
        continue
    body = em.group(3)
    dm = re.search(r'digest:\s*"?(sha256:[a-f0-9]+)"?', body)
    nm = re.search(r'newName:\s*(\S+)', body)
    if dm and nm:
        print(f"{nm.group(1)}@{dm.group(1)}")
    break
PY
}

# Resolve image's digest from GHCR by tag.
resolve_ghcr_digest() {
  local full_tag="$1" digest_hash=""
  digest_hash=$(docker buildx imagetools inspect "$full_tag" --raw 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('digest',''))" 2>/dev/null || true)
  if [ -z "$digest_hash" ]; then
    digest_hash=$(docker buildx imagetools inspect "$full_tag" 2>/dev/null \
      | grep -oP 'Digest:\s+\Ksha256:[a-f0-9]+' | head -1 || true)
  fi
  if [ -z "$digest_hash" ]; then
    return 1
  fi
  printf '%s@%s' "${full_tag%%:*}" "$digest_hash"
}

unit_images=$(images_for_deploy_unit "$NODE") || { echo "[ERROR] unknown deploy unit: $NODE" >&2; exit 1; }

items=()
resolved=()
for image in $unit_images; do
  image_name=$(image_name_for_image "$image")
  role=$(role_for_image "$image")
  digest=""

  if [ "$PREVIEW_FORWARD" = "true" ]; then
    overlay="${PREVIEW_SRC_DIR}/infra/k8s/overlays/preview/${NODE}/kustomization.yaml"
    digest=$(read_overlay_digest_for_image "$overlay" "$image_name")
    if [ -z "$digest" ]; then
      echo "::notice::preview-forward: no digest for image '${image}' (${image_name}) in ${overlay} — overlay may not carry this image in preview"
      continue
    fi
  else
    full_tag=$(image_tag_for_image "$image" "preview-${HEAD_SHA}")
    if ! digest=$(resolve_ghcr_digest "$full_tag"); then
      echo "::notice::no GHCR digest for image '${image}' tag=${full_tag} (not built this run)"
      continue
    fi
  fi

  items+=("    {\n      \"target\": \"${image}\",\n      \"deploy_unit\": \"${NODE}\",\n      \"image_name\": \"${image_name}\",\n      \"role\": \"${role}\",\n      \"tag\": \"\",\n      \"digest\": \"${digest}\"\n    }")
  resolved+=("$image")
done

# source_sha: in preview-forward mode, read from preview's per-app map.
# In GHCR mode, the SHA baked into images is HEAD_SHA (the merge SHA).
if [ "$PREVIEW_FORWARD" = "true" ]; then
  source_sha=$(jq -r --arg k "$NODE" '.[$k] // ""' "${PREVIEW_SRC_DIR}/.promote-state/source-sha-by-app.json" 2>/dev/null || echo "")
else
  source_sha="${BUILD_SHA:-$HEAD_SHA}"
fi

body=""
if [ ${#items[@]} -gt 0 ]; then
  body=$(printf '%b' "$(IFS=$',\n'; echo "${items[*]}")")
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "image_tag": "${HEAD_SHA:-preview-forward}",
  "source_sha": "${source_sha}",
  "targets": [
${body}
  ]
}
EOF

resolved_csv=""
[ ${#resolved[@]} -gt 0 ] && resolved_csv=$(IFS=,; echo "${resolved[*]}")
has_payload=false
[ ${#resolved[@]} -gt 0 ] && has_payload=true

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "payload_file=$OUTPUT_FILE"
    echo "has_payload=$has_payload"
    echo "resolved_images=$resolved_csv"
  } >> "$GITHUB_OUTPUT"
fi

echo "build-promote-payload: NODE=${NODE} resolved=${resolved_csv:-none} preview_forward=${PREVIEW_FORWARD}"
