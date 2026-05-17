#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/image-tags.sh — catalog v2 reader.
#
# CATALOG_IS_SSOT (docs/spec/ci-cd.md axiom 16). One deploy unit per catalog
# file; each deploy unit owns N images. This shim reads infra/catalog/*.yaml
# at source time and exposes the helpers downstream scripts iterate over.
#
# Intentionally no `set -euo pipefail` — meant to be sourced; caller owns
# error handling.

if ! command -v yq >/dev/null 2>&1; then
  echo "[ERROR] image-tags: yq is required (CATALOG_IS_SSOT). Install: bash scripts/bootstrap/install/install-yq.sh" >&2
  return 1 2>/dev/null || exit 1
fi

_image_tags_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_image_tags_repo_root="$(cd "${_image_tags_lib_dir}/../../.." && pwd)"
_image_tags_catalog_root="${COGNI_CATALOG_ROOT:-${_image_tags_repo_root}/infra/catalog}"

# ---------------------------------------------------------------------------
# Deploy unit indices
# ---------------------------------------------------------------------------

# Flat list of every deploy unit (== catalog filename minus .yaml).
# shellcheck disable=SC2034
mapfile -t DEPLOY_UNITS < <(yq -N '.name' "$_image_tags_catalog_root"/*.yaml)

# Deploy units of type node — replaces the legacy NODE_TARGETS export.
# shellcheck disable=SC2034
mapfile -t DEPLOY_UNITS_WITH_NODE_APPS < <(yq -N 'select(.type == "node") | .name' "$_image_tags_catalog_root"/*.yaml)

# ---------------------------------------------------------------------------
# Image indices
# ---------------------------------------------------------------------------

# Per-deploy-unit image-name cache: _images_for_unit_cache[<unit>] = "a b c"
declare -A _images_for_unit_cache=()
# Reverse map: _unit_for_image_cache[<image>] = "<unit>"
declare -A _unit_for_image_cache=()

for _u in "${DEPLOY_UNITS[@]}"; do
  _names=$(yq -N '.images[].name' "${_image_tags_catalog_root}/${_u}.yaml" | tr '\n' ' ')
  _images_for_unit_cache["$_u"]="${_names% }"
  for _n in ${_names}; do
    _unit_for_image_cache["$_n"]="$_u"
  done
done
unset _u _n _names

# Flat list of every image declared across all catalog files.
# shellcheck disable=SC2034
ALL_IMAGES=()
for _u in "${DEPLOY_UNITS[@]}"; do
  # shellcheck disable=SC2086
  for _img in ${_images_for_unit_cache[$_u]}; do
    ALL_IMAGES+=("$_img")
  done
done
unset _u _img

# ---------------------------------------------------------------------------
# Lookup helpers (image-keyed)
# ---------------------------------------------------------------------------

_yq_image_field() {
  local image="$1" field="$2" unit
  unit="${_unit_for_image_cache[$image]:-}"
  if [ -z "$unit" ]; then
    echo "[ERROR] image-tags: unknown image: $image" >&2
    return 1
  fi
  yq -N ".images[] | select(.name == \"${image}\") | ${field} // \"\"" \
    "${_image_tags_catalog_root}/${unit}.yaml"
}

deploy_unit_for_image() {
  local image="$1"
  if [ -z "${_unit_for_image_cache[$image]+x}" ]; then
    echo "[ERROR] image-tags: unknown image: $image" >&2
    return 1
  fi
  printf '%s' "${_unit_for_image_cache[$image]}"
}

dockerfile_for_image()     { _yq_image_field "$1" ".dockerfile"; }
image_name_for_image()     { _yq_image_field "$1" ".image_name"; }
image_tag_suffix_for_image() { _yq_image_field "$1" ".image_tag_suffix"; }
role_for_image()           { _yq_image_field "$1" ".role"; }

# build.* sub-fields
build_context_for_image()    { _yq_image_field "$1" ".build.context"; }
build_target_for_image()     { _yq_image_field "$1" ".build.target"; }
build_test_target_for_image() { _yq_image_field "$1" ".build.test_target"; }
build_cache_scope_for_image() { _yq_image_field "$1" ".build.cache_scope"; }

# path_prefix inheritance: image-level override OR parent deploy.path_prefix.
path_prefix_for_image() {
  local image="$1" override unit
  override=$(_yq_image_field "$image" ".path_prefix") || return 1
  if [ -n "$override" ] && [ "$override" != "null" ]; then
    printf '%s' "$override"
    return 0
  fi
  unit=$(deploy_unit_for_image "$image") || return 1
  yq -N ".deploy.path_prefix" "${_image_tags_catalog_root}/${unit}.yaml"
}

# Full tag for an image given a base tag (e.g. pr-{N}-{sha}).
# Returns <image_name>:<base_tag><image_tag_suffix>.
image_tag_for_image() {
  local image="$1" base_tag="$2" name suffix
  name=$(image_name_for_image "$image") || return 1
  suffix=$(image_tag_suffix_for_image "$image") || return 1
  printf '%s:%s%s' "$name" "$base_tag" "$suffix"
}

# ---------------------------------------------------------------------------
# Lookup helpers (deploy-unit-keyed)
# ---------------------------------------------------------------------------

# Echo the space-separated list of images for a given deploy unit.
# Usage: for image in $(images_for_deploy_unit poly); do ...; done
images_for_deploy_unit() {
  local unit="$1"
  if [ -z "${_images_for_unit_cache[$unit]+x}" ]; then
    echo "[ERROR] image-tags: unknown deploy unit: $unit" >&2
    return 1
  fi
  printf '%s' "${_images_for_unit_cache[$unit]}"
}

# bug.5002 — per-env public URL from catalog. Reads deploy.public_url under v2.
# Returns "" if the deploy unit has no public_url for this env (service-type
# units with no Ingress); callers treat "" as a skip.
public_url_for_deploy_unit() {
  local env="$1" unit="$2" url
  if [ -z "${_images_for_unit_cache[$unit]+x}" ]; then
    echo "[ERROR] image-tags: unknown deploy unit: $unit" >&2
    return 1
  fi
  url=$(yq -N ".deploy.public_url.\"${env}\" // \"\"" "${_image_tags_catalog_root}/${unit}.yaml")
  [ "$url" = "null" ] && url=""
  printf '%s' "$url"
}

# Resolve the role:app image's name for a given deploy unit. Used by callers
# that need the deploy unit's primary container image (verify-buildsha,
# promote-preview-seed, retag-on-merge — places where exactly one image
# represents the unit's "what does /version.buildSha report").
app_image_for_deploy_unit() {
  local unit="$1" img role
  if [ -z "${_images_for_unit_cache[$unit]+x}" ]; then
    echo "[ERROR] image-tags: unknown deploy unit: $unit" >&2
    return 1
  fi
  # shellcheck disable=SC2086
  for img in ${_images_for_unit_cache[$unit]}; do
    role=$(role_for_image "$img")
    if [ "$role" = "app" ]; then
      printf '%s' "$img"
      return 0
    fi
  done
  echo "[ERROR] image-tags: deploy unit ${unit} has no role:app image" >&2
  return 1
}
