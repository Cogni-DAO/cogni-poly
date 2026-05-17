#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/promote-preview-seed-main.sh
# Purpose: After Flight Preview (retag) succeeds, refresh `main` preview overlay
#   digest pins in one working-tree pass. Catalog v2 — iterates every image of
#   every deploy unit so sidecars and migrators get seeded alongside the app.
#
# Tri-state per image (affected-only merges):
#   1) If `<image_name>:preview-{mergeSha}{suffix}` resolves in GHCR → use it.
#   2) Else retain current pin from kustomization; verify it still resolves.
#   3) Else fail (broken overlay) — unless the overlay legitimately omits the
#      image (e.g. paper-sidecar absent from production-style overlays); in
#      that case promote-k8s-image returns exit 2 and we move on.
#
# Does not commit or push — caller owns git. Exit 0 when there is nothing
# to change.
#
# Env:
#   MERGE_SHA  (required) 40-char lowercase git SHA on main (merge commit).
#
set -euo pipefail

MERGE_SHA="${MERGE_SHA:?MERGE_SHA required}"
MERGE_SHA=$(printf '%s' "$MERGE_SHA" | tr '[:upper:]' '[:lower:]')
if ! printf '%s' "$MERGE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  echo "[ERROR] MERGE_SHA must be a 40-char hex SHA" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
# shellcheck source=./lib/overlay-digest.sh
. "$SCRIPT_DIR/lib/overlay-digest.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[ERROR] docker buildx is required" >&2
  exit 1
fi

BASE_TAG="preview-${MERGE_SHA}"

resolve_digest_ref() {
  local tag="$1" digest
  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    return 1
  fi
  local repo="${tag%@*}"
  repo="${repo%%:*}"
  printf '%s@%s' "$repo" "$digest"
}

# Look up an image's current digest pin in the preview overlay (by image_name
# match in the images[] block). Returns "" if no entry, or "<image_name>@<digest>"
# if the existing entry has a digest.
overlay_pinned_digest_for_image() {
  local unit="$1" image_name="$2"
  local overlay="infra/k8s/overlays/preview/${unit}/kustomization.yaml"
  [ -f "$overlay" ] || return 0
  python3 - "$overlay" "$image_name" <<'PY'
import re, sys
overlay_path, target = sys.argv[1:3]
with open(overlay_path, "r", encoding="utf-8") as h:
    text = h.read()
m = re.search(r'(?ms)^images:\s*\n((?:[ \t]+.*\n)+)', text)
if not m: sys.exit(0)
entry_pat = re.compile(r'(?m)^([ \t]+)-\s+name:\s*(\S+)\s*\n((?:\1[ \t]+.*\n)*)')
for em in entry_pat.finditer(m.group(1)):
    if em.group(2) != target: continue
    body = em.group(3)
    dm = re.search(r'digest:\s*"?(sha256:[a-f0-9]+)"?', body)
    nm = re.search(r'newName:\s*(\S+)', body)
    if dm and nm:
        print(f"{nm.group(1)}@{dm.group(1)}")
    break
PY
}

desired_digest_for_image() {
  local image="$1" current
  local full_tag image_name digest_ref
  full_tag=$(image_tag_for_image "$image" "$BASE_TAG") || return 1
  image_name=$(image_name_for_image "$image")

  if digest_ref=$(resolve_digest_ref "$full_tag"); then
    printf '%s' "$digest_ref"
    return 0
  fi
  # Retain path: read current overlay pin, verify it still resolves in GHCR.
  current=$(overlay_pinned_digest_for_image "$(deploy_unit_for_image "$image")" "$image_name")
  if [ -z "$current" ]; then
    # Overlay legitimately omits this image (e.g. sidecar absent from prod).
    # Emit empty so the caller skips this image — promote-k8s-image's exit-2
    # path also handles this end-state safely.
    return 0
  fi
  if digest_ref=$(resolve_digest_ref "$current"); then
    printf '%s' "$digest_ref"
    return 0
  fi
  echo "[ERROR] retain path: could not resolve current ref ${current} for image ${image}" >&2
  return 1
}

promote_if_changed() {
  local unit="$1" image_name="$2" digest="$3"
  local file="infra/k8s/overlays/preview/${unit}/kustomization.yaml"
  local before after rc
  before=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
  set +e
  bash "$SCRIPT_DIR/promote-k8s-image.sh" --no-commit \
    --env preview --app "$unit" --image-name "$image_name" --digest "$digest"
  rc=$?
  set -e
  case "$rc" in
    0)
      after=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
      if [ "$before" != "$after" ]; then
        echo "  updated: ${unit}/${image_name##*/}"
      else
        echo "  unchanged: ${unit}/${image_name##*/}"
      fi
      ;;
    2)
      echo "  skip: ${unit}/${image_name##*/} (no images[] entry — overlay omits)"
      ;;
    *)
      echo "[ERROR] promote-k8s-image failed unit=${unit} image_name=${image_name} rc=${rc}" >&2
      return 1
      ;;
  esac
}

echo "ℹ️  promote-preview-seed-main: MERGE_SHA=${MERGE_SHA:0:12} BASE_TAG=${BASE_TAG}"

for image in "${ALL_IMAGES[@]}"; do
  unit=$(deploy_unit_for_image "$image")
  image_name=$(image_name_for_image "$image")
  digest=$(desired_digest_for_image "$image") || exit 1
  if [ -z "$digest" ]; then
    echo "  skip: ${unit}/${image_name##*/} (no preview tag + no retainable pin)"
    continue
  fi
  promote_if_changed "$unit" "$image_name" "$digest"
done

if git diff --quiet infra/k8s/overlays/preview/; then
  echo "ℹ️  No overlay diff — seed already matches GHCR / retain pins."
  exit 0
fi

echo "ℹ️  Overlay diff present — caller should commit and push."
exit 0
