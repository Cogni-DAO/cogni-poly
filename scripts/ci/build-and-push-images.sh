#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/build-and-push-images.sh
# Purpose: Build and push the selected images to GHCR, emit a per-leg JSON
#          fragment for downstream workflows.
#
# Catalog v2: TARGETS is a CSV of catalog image.name entries. Every per-image
# build setting (dockerfile, image_name, tag_suffix, build.target,
# build.test_target, build.context, build.cache_scope) is read from the
# catalog — no inline case statements per image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

TARGETS=${TARGETS:-}
IMAGE_TAG=${IMAGE_TAG:-}
PLATFORM=${PLATFORM:-linux/amd64}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/build-images.json}

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ -z "$IMAGE_TAG" ]; then
  log_error "IMAGE_TAG is required"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

trimmed_targets=$(printf "%s" "$TARGETS" | tr -d '[:space:]')
if [ -z "$trimmed_targets" ]; then
  printf '{\n  "image_tag": "%s",\n  "platform": "%s",\n  "targets": []\n}\n' \
    "$IMAGE_TAG" "$PLATFORM" > "$OUTPUT_FILE"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "build_output_file=$OUTPUT_FILE"
      echo "built_targets="
      echo "has_images=false"
    } >> "$GITHUB_OUTPUT"
  fi

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## Built PR Images"
      echo ""
      echo "- Image tag: \`$IMAGE_TAG\`"
      echo "- Targets: none"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  log_info "No images selected; wrote empty payload to $OUTPUT_FILE"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  log_error "docker is required"
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  log_error "docker buildx is required"
  exit 1
fi

if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USERNAME:-}" ]; then
  log_info "Logging into GHCR as ${GHCR_USERNAME}"
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
fi

git_sha="${BUILD_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}}"
build_timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Smoke (pre-push) build for catalog-declared build.test_target. Runs without
# --push so a smoke failure aborts the leg before the production image lands
# in GHCR. Absorbs what build-poly-paper-sidecar.yml's "Build + run smoke test"
# step used to do.
smoke_build() {
  local image="$1" dockerfile="$2" context="$3" test_target="$4" cache_scope="$5"
  log_info "Smoke-building ${image} target=${test_target} (no push)"
  docker buildx build \
    --platform "$PLATFORM" \
    --file "$dockerfile" \
    --target "$test_target" \
    --cache-from "type=gha,scope=${cache_scope}" \
    --cache-to "type=gha,mode=max,scope=${cache_scope}" \
    "$context"
}

build_push() {
  local image="$1" dockerfile="$2" context="$3" target="$4" cache_scope="$5" full_tag="$6"
  local target_args=()
  [ -n "$target" ] && target_args+=(--target "$target")

  docker buildx build \
    --platform "$PLATFORM" \
    --file "$dockerfile" \
    "${target_args[@]}" \
    --build-arg "BUILD_SHA=${git_sha}" \
    --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-cogni-dao/cogni-poly}" \
    --label "org.opencontainers.image.revision=${git_sha}" \
    --label "org.opencontainers.image.created=${build_timestamp}" \
    --cache-from "type=gha,scope=${cache_scope}" \
    --cache-to "type=gha,mode=max,scope=${cache_scope}" \
    --tag "$full_tag" \
    --push \
    "$context"
}

resolve_digest_ref() {
  local tag="$1" digest
  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    log_error "Failed to resolve pushed digest for ${tag}"
    exit 1
  fi
  printf '%s@%s' "${tag%%:*}" "$digest"
}

json_items=()
built_targets=()
IFS=',' read -r -a requested_images <<< "$trimmed_targets"

for image in "${requested_images[@]}"; do
  [ -z "$image" ] && continue

  # Validate catalog membership.
  unit=$(deploy_unit_for_image "$image") || { log_error "Unknown image: $image"; exit 1; }
  dockerfile=$(dockerfile_for_image "$image")
  image_name=$(image_name_for_image "$image")
  role=$(role_for_image "$image")
  context=$(build_context_for_image "$image")
  target=$(build_target_for_image "$image")
  test_target=$(build_test_target_for_image "$image")
  cache_scope=$(build_cache_scope_for_image "$image")
  [ -z "$context" ] && context="."
  [ -z "$cache_scope" ] && cache_scope="build-${image}"

  full_tag=$(image_tag_for_image "$image" "$IMAGE_TAG")
  log_info "Building ${image} → ${full_tag} (role=${role}, unit=${unit})"

  if [ -n "$test_target" ]; then
    smoke_build "$image" "$dockerfile" "$context" "$test_target" "$cache_scope"
  fi

  build_push "$image" "$dockerfile" "$context" "$target" "$cache_scope" "$full_tag"
  digest_ref=$(resolve_digest_ref "$full_tag")
  log_info "Resolved ${image} digest: ${digest_ref}"

  json_items+=("    {\n      \"target\": \"${image}\",\n      \"deploy_unit\": \"${unit}\",\n      \"image_name\": \"${image_name}\",\n      \"role\": \"${role}\",\n      \"tag\": \"${full_tag}\",\n      \"digest\": \"${digest_ref}\"\n    }")
  built_targets+=("$image")
done

json_body=""
if [ ${#json_items[@]} -gt 0 ]; then
  json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "image_tag": "${IMAGE_TAG}",
  "platform": "${PLATFORM}",
  "targets": [
${json_body}
  ]
}
EOF

built_targets_csv=$(IFS=,; echo "${built_targets[*]}")

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "build_output_file=$OUTPUT_FILE"
    echo "built_targets=$built_targets_csv"
    echo "has_images=true"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Built PR Images"
    echo ""
    echo "- Image tag: \`${IMAGE_TAG}\`"
    echo "- Built: \`${built_targets_csv}\`"
    echo ""
    echo "| Image | Image-name | Role | Digest |"
    echo "| --- | --- | --- | --- |"
    for image in "${built_targets[@]}"; do
      digest_ref=$(python3 - "$OUTPUT_FILE" "$image" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
for item in payload["targets"]:
    if item["target"] == sys.argv[2]:
        print(item["digest"])
        break
PY
)
      name=$(image_name_for_image "$image")
      role=$(role_for_image "$image")
      echo "| \`${image}\` | \`${name}\` | \`${role}\` | \`${digest_ref}\` |"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi

log_info "Wrote build payload to $OUTPUT_FILE"
