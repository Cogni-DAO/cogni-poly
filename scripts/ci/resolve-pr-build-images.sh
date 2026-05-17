#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/resolve-pr-build-images.sh
# Purpose: Resolve pushed per-image digests from GHCR for the `pr-{N}-{sha}` /
#          `mq-{N}-{sha}` tag convention. Emits a JSON payload consumed by
#          promote-build-payload.sh.
#
# Catalog v2: iterates every image declared in infra/catalog/*.yaml (flat
# across deploy units). The payload's `targets[]` entries are image-keyed
# (entry.target == catalog images[].name).
#
# Envelope shape (written to $OUTPUT_FILE):
#   {
#     image_tag: "<base-tag>",                  # pr-{N}-{sha} or mq-{N}-{sha}
#     source_sha: "<40-char-hex>",              # BUILD_SHA baked into images
#     targets: [
#       {
#         target:      "<image.name>",          # catalog images[].name
#         deploy_unit: "<deploy-unit name>",    # which catalog file owns it
#         image_name:  "<ghcr.io/...>",         # catalog images[].image_name
#         role:        "app|migrator|sidecar",
#         tag:         "<image_name>:<base-tag><suffix>",
#         digest:      "<image_name>@sha256:..."
#       },
#       ...
#     ]
#   }
#
# Outputs on $GITHUB_OUTPUT:
#   resolved_file, resolved_targets (CSV), has_images (bool)
#
# Env:
#   IMAGE_TAG    (required) the pr-{N}-{sha} / mq-{N}-{sha} tag
#   SOURCE_SHA   (optional) PR head SHA — overrides IMAGE_TAG parse
#   OUTPUT_FILE  (default $RUNNER_TEMP/resolved-pr-images.json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

IMAGE_TAG=${IMAGE_TAG:-}
SOURCE_SHA=${SOURCE_SHA:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/resolved-pr-images.json}

if [ -z "$IMAGE_TAG" ]; then
  echo "[ERROR] IMAGE_TAG is required" >&2
  exit 1
fi

# Derive SOURCE_SHA from IMAGE_TAG when not passed. Two tag namespaces:
#   pr-{N}-{X}  — pull_request build, X = original PR head SHA
#   mq-{N}-{Y}  — merge_group build, Y = queue/rebased commit
if [ -z "$SOURCE_SHA" ]; then
  SOURCE_SHA=$(printf '%s' "$IMAGE_TAG" | sed -E 's/^(pr|mq)-[0-9]+-//')
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[ERROR] docker buildx is required" >&2
  exit 1
fi

resolve_digest_ref() {
  local tag="$1" digest
  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    return 1
  fi
  printf '%s@%s' "${tag%%:*}" "$digest"
}

mkdir -p "$(dirname "$OUTPUT_FILE")"

json_items=()
resolved_targets=()

for image in "${ALL_IMAGES[@]}"; do
  unit=$(deploy_unit_for_image "$image")
  image_name=$(image_name_for_image "$image")
  role=$(role_for_image "$image")
  full_tag=$(image_tag_for_image "$image" "$IMAGE_TAG")

  if digest_ref=$(resolve_digest_ref "$full_tag"); then
    json_items+=("    {\n      \"target\": \"${image}\",\n      \"deploy_unit\": \"${unit}\",\n      \"image_name\": \"${image_name}\",\n      \"role\": \"${role}\",\n      \"tag\": \"${full_tag}\",\n      \"digest\": \"${digest_ref}\"\n    }")
    resolved_targets+=("$image")
  fi
done

json_body=""
if [ ${#json_items[@]} -gt 0 ]; then
  json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "image_tag": "${IMAGE_TAG}",
  "source_sha": "${SOURCE_SHA}",
  "targets": [
${json_body}
  ]
}
EOF

resolved_targets_csv=""
if [ ${#resolved_targets[@]} -gt 0 ]; then
  resolved_targets_csv=$(IFS=,; echo "${resolved_targets[*]}")
fi

has_images=false
if [ ${#resolved_targets[@]} -gt 0 ]; then
  has_images=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "resolved_file=$OUTPUT_FILE"
    echo "resolved_targets=$resolved_targets_csv"
    echo "has_images=$has_images"
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved PR images: ${resolved_targets_csv:-none}"
