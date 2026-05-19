#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# verify-buildsha.sh — image-native build-provenance gate (task.5006).
#
# Asserts that every promoted image of every node in $NODES has its
# `org.opencontainers.image.revision` OCI label baked at build time matching
# the SHA recorded in the source-sha-by-app map at promote time. Role-agnostic:
# the same loop covers node-apps, sidecars, migrators, scheduler-workers, and
# any future image type — they all carry the same label by way of
# build-and-push-images.sh.
#
# Read path (single, ROLE_AGNOSTIC_VERIFY): for each (node, image) pair,
#   1. read overlay digest from infra/k8s/overlays/$OVERLAY_ENV/$node/kustomization.yaml
#   2. read expected SHA from $SOURCE_SHA_MAP[image]
#   3. `crane config <ref>@<digest> | jq -r '.config.Labels["org.opencontainers.image.revision"]'`
#   4. assert label == expected (lowercased).
# No HTTP, no Ingress, no `kubectl exec`. The witness travels with the digest;
# deploy-branch overlays and app code cannot drift from it.
#
# TRANSITION_SAFE (task.5006): two flavors of "data not yet in shape" surface
# as visible warnings and pass that image, NOT hard fails:
#   - label-missing on a digest (image built before task.5006 landed)
#   - map-entry-missing for an image (next promote of that image populates it)
# Label-mismatch is ALWAYS a hard fail — that's the lying-overlay signal that
# PR #121's run 26079941364 needed to catch.
#
# Env:
#   NODES               (required CSV) deploy units to verify. Empty → no-op.
#   OVERLAY_ENV         (required)     candidate-a | preview | production.
#   SOURCE_SHA_MAP      (required)     path to .promote-state/source-sha-by-app.json
#                                       (per-image keyed; see promote-build-payload.sh).
#   OVERLAY_DIR         (optional)     path to the deploy-branch checkout that
#                                       contains infra/k8s/overlays/$OVERLAY_ENV/.
#                                       Defaults to cwd.
#   MARKER_DIR          (optional)     when set, write `verified-<node>.txt = true`
#                                       per deploy unit whose images all pass (or
#                                       are warn-skipped). Consumed by
#                                       aggregate-decide-outcome.sh (Axiom 19).
#   CRANE_CMD           (optional)     override crane invocation (default: `crane`).
#                                       Tests inject a fake on $PATH; CI runners
#                                       use imjasonh/setup-crane@v0.4.
#
# Compatibility shim:
#   DEPLOY_ENVIRONMENT  → if set and OVERLAY_ENV unset, used as OVERLAY_ENV.
#                         Both workflow callers set OVERLAY_ENV explicitly;
#                         this shim only protects laptop CLI runs.

set -euo pipefail

OVERLAY_ENV="${OVERLAY_ENV:-${DEPLOY_ENVIRONMENT:-}}"
if [ -z "$OVERLAY_ENV" ]; then
  echo "::error::OVERLAY_ENV (or DEPLOY_ENVIRONMENT) required" >&2
  exit 1
fi

SOURCE_SHA_MAP="${SOURCE_SHA_MAP:?SOURCE_SHA_MAP required (per-image source-sha-by-app.json)}"
OVERLAY_DIR="${OVERLAY_DIR:-$PWD}"
MARKER_DIR="${MARKER_DIR:-}"
CRANE_CMD="${CRANE_CMD:-crane}"
NODES_INPUT="${NODES:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "${SCRIPT_DIR}/lib/image-tags.sh"
# shellcheck source=./lib/overlay-digest.sh
. "${SCRIPT_DIR}/lib/overlay-digest.sh"

if [ -z "$NODES_INPUT" ]; then
  echo "ℹ️  NODES is empty — no apps promoted in this run, skipping buildSha check."
  exit 0
fi

if [ ! -f "$SOURCE_SHA_MAP" ]; then
  echo "::warning::SOURCE_SHA_MAP=${SOURCE_SHA_MAP} missing — first deploy with task.5006 keying; nothing to verify"
  exit 0
fi

# Load image → expected_sha entries from the per-image map.
declare -A EXPECTED_BY_IMAGE=()
while IFS=$'\t' read -r img sha; do
  [ -z "$img" ] && continue
  EXPECTED_BY_IMAGE["$img"]=$(printf '%s' "$sha" | tr '[:upper:]' '[:lower:]')
done < <(python3 - "$SOURCE_SHA_MAP" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as h:
        data = json.load(h)
except (OSError, json.JSONDecodeError):
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
for k, v in sorted(data.items()):
    if isinstance(v, str) and v:
        print(f"{k}\t{v}")
PY
)

# Read the revision label off a digest-pinned image ref via two distinct
# steps so the caller can distinguish three states:
#   - crane succeeds + label present      → label echoed to stdout
#   - crane succeeds + label absent       → empty stdout, exit 0 (TRANSITION_SAFE)
#   - crane fails (auth, network, 404)    → empty stdout, exit non-zero (HARD FAIL —
#                                           an unreadable registry is an infra fault,
#                                           NOT a green skip; without this, a runner
#                                           that lost its docker-login would silently
#                                           pass every image.)
# CRANE_CMD is intentionally word-split so tests can inject `bash /path/fake.sh`.
read_revision_label() {
  local ref="$1" config rc
  config=$(${CRANE_CMD} config "$ref" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s' "$config" >&2
    return "$rc"
  fi
  printf '%s' "$config" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("config",{}).get("Labels") or {}).get("org.opencontainers.image.revision",""))'
}

FAILED=0
ANY_VERIFIED=0
IFS=',' read -r -a NODE_ARR <<<"$NODES_INPUT"

for node in "${NODE_ARR[@]}"; do
  node=$(printf '%s' "$node" | tr -d '[:space:]')
  [ -z "$node" ] && continue

  if [ -z "${_images_for_unit_cache[$node]+x}" ]; then
    echo "::warning::verify-buildsha: NODES includes unknown deploy unit '${node}' — catalog has no such entry, skipping"
    continue
  fi

  overlay_file="${OVERLAY_DIR}/infra/k8s/overlays/${OVERLAY_ENV}/${node}/kustomization.yaml"
  if [ ! -f "$overlay_file" ]; then
    echo "::warning::verify-buildsha: ${overlay_file} missing — deploy unit ${node} has no overlay in ${OVERLAY_ENV}, skipping"
    continue
  fi

  # image_name → "image_name@sha256:..." (or tag form if not yet digest-pinned).
  # `unset` first: `declare -A var=()` reset semantics are bash-version-
  # fragile; explicit unset guarantees no carryover when NODES is a CSV.
  unset OVERLAY_REF_BY_IMAGE_NAME
  declare -A OVERLAY_REF_BY_IMAGE_NAME=()
  while IFS=$'\t' read -r image_name ref; do
    [ -z "$image_name" ] && continue
    OVERLAY_REF_BY_IMAGE_NAME["$image_name"]="$ref"
  done < <(cd "$OVERLAY_DIR" && extract_overlay_image_refs_all "$OVERLAY_ENV" "$node")

  node_failed=0
  node_checks=0
  for image in ${_images_for_unit_cache[$node]}; do
    image_name=$(image_name_for_image "$image")
    overlay_ref="${OVERLAY_REF_BY_IMAGE_NAME[$image_name]:-}"

    if [ -z "$overlay_ref" ]; then
      echo "  ↷ ${node}/${image}: not in ${OVERLAY_ENV} overlay (e.g. sidecar absent from production) — skipping"
      continue
    fi
    # Not digest-pinned yet (newTag placeholder, never promoted). The deploy
    # never advanced for this image; nothing to verify against, and a warn
    # is enough — promote-build-payload will write the digest on first build.
    if [[ "$overlay_ref" != *"@sha256:"* ]]; then
      echo "::warning::${node}/${image}: overlay carries tag pin '${overlay_ref}' (not digest) — first promote pending, skipping"
      continue
    fi

    expected="${EXPECTED_BY_IMAGE[$image]:-}"
    if [ -z "$expected" ]; then
      # TRANSITION_SAFE: per-image map entry not yet written (pre-task.5006
      # promote, or this image just not promoted recently). Surface but pass.
      echo "::warning::${node}/${image}: source-sha-map has no entry — transition (task.5006); next promote populates"
      continue
    fi

    node_checks=$((node_checks + 1))
    set +e
    label=$(read_revision_label "$overlay_ref" 2>/dev/null)
    crane_rc=$?
    set -e
    label=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]')

    if [ "$crane_rc" -ne 0 ]; then
      # Registry unreachable for this digest — auth, network, 404, GHCR
      # outage. NOT TRANSITION_SAFE; an unreadable witness is fail-closed
      # so a docker-login regression cannot silently green the pipeline.
      echo "  ❌ ${node}/${image}: ${overlay_ref} — crane could not read image config (rc=${crane_rc}); check GHCR auth + network"
      node_failed=1
      FAILED=1
      continue
    fi

    if [ -z "$label" ]; then
      echo "::warning::${node}/${image}: ${overlay_ref} has no org.opencontainers.image.revision label (image built pre-task.5006) — TRANSITION_SAFE skip"
      continue
    fi

    if [ "$label" = "$expected" ]; then
      echo "  ✅ ${node}/${image}: revision=${label:0:12} matches expected ${expected:0:12}"
      ANY_VERIFIED=1
    else
      echo "  ❌ ${node}/${image}: revision=${label:0:12} != expected ${expected:0:12} (ref=${overlay_ref})"
      node_failed=1
      FAILED=1
    fi
  done

  # MARKER_DIR: per-deploy-unit cell-verify-<node> artifact (Axiom 19,
  # aggregate-decide-outcome.sh). Written when no image in this unit
  # produced a hard mismatch — warn-skips are acceptable during transition.
  if [ -n "$MARKER_DIR" ] && [ "$node_failed" = "0" ]; then
    mkdir -p "$MARKER_DIR"
    printf 'true' > "${MARKER_DIR}/verified-${node}.txt"
    if [ "$node_checks" = "0" ]; then
      echo "  ✅ ${node}: no images had both an overlay digest AND a map entry (transition / no-op) — marker written"
    fi
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "❌ image revision-label mismatch — at least one image's overlay digest carries a SHA that disagrees with the source-sha-by-app map."
  echo "   This means the overlay was advanced for an image without recording its actual build SHA, OR the build label was set wrong."
  echo "   Inspect the failing image:digest above; cross-check infra/k8s/overlays/${OVERLAY_ENV}/<node>/kustomization.yaml against the deploy-branch's .promote-state/source-sha-by-app.json."
  exit 1
fi

if [ "$ANY_VERIFIED" = "0" ]; then
  echo "ℹ️  verify-buildsha: no images had both an overlay digest and a map entry to check (transition / no-op)."
else
  echo "✅ all probed images carry the expected revision label"
fi
