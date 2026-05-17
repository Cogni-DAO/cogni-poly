#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/detect-affected.sh
# Purpose: Compute buildable images affected by the current SCM scope.
# Scope: PR image builds (catalog v2 — one matrix leg per affected image,
#        not per affected deploy unit).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
EXPLICIT_SCOPE=false
UPSTREAM_REF=${TURBO_SCM_BASE:-}
HEAD_REF=${TURBO_SCM_HEAD:-HEAD}

if [ -n "${TURBO_SCM_BASE:-}" ] || [ -n "${TURBO_SCM_HEAD:-}" ]; then
  EXPLICIT_SCOPE=true
fi

if [ -z "$UPSTREAM_REF" ]; then
  UPSTREAM_REF=$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || true)
fi

if [ -z "$UPSTREAM_REF" ] && git show-ref --verify --quiet refs/remotes/origin/main; then
  UPSTREAM_REF="origin/main"
fi

use_affected=false
if [ "$EXPLICIT_SCOPE" = true ]; then
  use_affected=true
elif [ -n "$UPSTREAM_REF" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  use_affected=true
fi

scope_mode="full"
scope_base=""
selection_reason="default-full-scope"
changed_paths=""

# CHANGED_PATHS_FILE: callers may pre-compute the authoritative changed-paths
# list (e.g. from the GitHub PR `files` API) and pass it here. Preferred over
# `git diff <base>...HEAD` for PR-flight workflows.
if [ -n "${CHANGED_PATHS_FILE:-}" ] && [ -f "${CHANGED_PATHS_FILE}" ]; then
  scope_mode="affected"
  scope_base="pr-files"
  selection_reason="pr-files-api"
  changed_paths=$(tr -d '\r' < "${CHANGED_PATHS_FILE}")
elif [ "$use_affected" = true ]; then
  scope_mode="affected"
  scope_base="$UPSTREAM_REF"
  selection_reason="affected-scope"
  changed_paths=$(git diff --name-only "${scope_base}...${HEAD_REF}" | tr -d '\r')
fi

selected_images=()

has_image() {
  local needle="$1"
  local existing
  for existing in "${selected_images[@]}"; do
    [ "$existing" = "$needle" ] && return 0
  done
  return 1
}

add_image() {
  local image="$1"
  if ! has_image "$image"; then
    selected_images+=("$image")
  fi
}

add_all_images() {
  local image
  for image in "${ALL_IMAGES[@]}"; do
    add_image "$image"
  done
}

is_global_build_input() {
  local path="$1"
  case "$path" in
    .dockerignore | \
    package.json | \
    pnpm-lock.yaml | \
    pnpm-workspace.yaml | \
    turbo.json | \
    tsconfig.json | \
    tsconfig.base.json | \
    tsconfig.app.json | \
    tsconfig.scripts.json | \
    config/* | \
    infra/catalog/* | \
    scripts/ci/build-and-push-images.sh | \
    scripts/ci/detect-affected.sh | \
    scripts/ci/lib/image-tags.sh | \
    scripts/ci/write-build-manifest.sh)
      return 0
      ;;
  esac
  return 1
}

if [ "$scope_mode" = "full" ]; then
  add_all_images
else
  # Precompute per-image path_prefix + parent deploy unit.
  declare -A image_prefix=()
  declare -A image_unit=()
  for image in "${ALL_IMAGES[@]}"; do
    image_prefix["$image"]=$(path_prefix_for_image "$image")
    image_unit["$image"]=$(deploy_unit_for_image "$image")
  done

  while IFS= read -r path; do
    [ -z "$path" ] && continue

    if is_global_build_input "$path"; then
      add_all_images
      selection_reason="global-build-input:${path}"
      break
    fi

    case "$path" in
      .github/workflows/pr-build.yml)
        add_all_images
        selection_reason="workflow-build-change:${path}"
        break
        ;;
      packages/*)
        add_all_images
        selection_reason="shared-package-change:${path}"
        break
        ;;
      *)
        for image in "${ALL_IMAGES[@]}"; do
          prefix="${image_prefix[$image]}"
          unit="${image_unit[$image]}"
          case "$path" in
            # Image path_prefix (image override OR parent deploy.path_prefix).
            "${prefix}"*) add_image "$image" ;;
            # Per-deploy-unit overlay/base changes light up every image in that unit.
            "infra/k8s/overlays/"*"/${unit}/"*) add_image "$image" ;;
            "infra/k8s/base/${unit}/"*) add_image "$image" ;;
          esac
        done
        ;;
    esac
  done <<< "$changed_paths"
fi

# Preserve canonical ordering — iterate ALL_IMAGES.
ordered_images=()
for image in "${ALL_IMAGES[@]}"; do
  if has_image "$image"; then
    ordered_images+=("$image")
  fi
done

images_csv=""
images_json="[]"
if [ ${#ordered_images[@]} -gt 0 ]; then
  images_csv=$(IFS=,; echo "${ordered_images[*]}")
  images_json=$(printf '%s\n' "${ordered_images[@]}" \
    | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))')
fi

changed_paths_count=0
if [ -n "$changed_paths" ]; then
  changed_paths_count=$(printf "%s\n" "$changed_paths" | sed '/^$/d' | wc -l | tr -d ' ')
fi

has_targets=false
if [ ${#ordered_images[@]} -gt 0 ]; then
  has_targets=true
fi

# Output names retain the legacy "targets" key for downstream-workflow stability
# (pr-build's matrix consumes `targets_json`). Under v2 a "target" is an image
# name, not a deploy-unit name — that's the only semantic shift.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "scope_mode=$scope_mode"
    echo "scope_base=$scope_base"
    echo "scope_head=$HEAD_REF"
    echo "selection_reason=$selection_reason"
    echo "changed_paths_count=$changed_paths_count"
    echo "has_targets=$has_targets"
    echo "targets=$images_csv"
    echo "targets_json=$images_json"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Affected Images"
    echo ""
    echo "- Scope: \`$scope_mode\`"
    if [ -n "$scope_base" ]; then
      echo "- Diff: \`${scope_base}...${HEAD_REF}\`"
    fi
    echo "- Reason: \`$selection_reason\`"
    echo "- Changed paths: \`$changed_paths_count\`"
    if [ "$has_targets" = true ]; then
      echo "- Images: \`$images_csv\`"
    else
      echo "- Images: none"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Image build scope: ${scope_mode}"
if [ -n "$scope_base" ]; then
  echo "SCM range: ${scope_base}...${HEAD_REF}"
fi
echo "Selection reason: ${selection_reason}"
echo "Changed paths: ${changed_paths_count}"
if [ "$has_targets" = true ]; then
  echo "Images: ${images_csv}"
else
  echo "Images: none"
fi
