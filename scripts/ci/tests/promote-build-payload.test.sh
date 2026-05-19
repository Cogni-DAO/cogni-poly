#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/promote-build-payload.test.sh
#
# Catalog v2 regression suite for promote-build-payload.sh. Exercises:
#   1. Happy path           — NODE=poly + payload with poly + poly-paper-sidecar
#                             → both overlay entries written, promoted_apps=poly,
#                             source-sha map updated.
#   2. Sidecar absent       — NODE=poly + OVERLAY_ENV=production (production
#                             overlay deliberately omits paper-sidecar) → app
#                             promoted, sidecar exit-2 skip, promoted_apps=poly.
#   3. Affected-only miss   — NODE=poly + payload contains only scheduler-worker
#                             entries → promoted_apps='', no overlay writes,
#                             no map update.
#   4. MAP_SCRIPT failing   — NODE=poly + full payload + MAP=/bin/false →
#                             overlay writes happen, promoted_apps=poly, but
#                             script exits 1 (total provenance loss is hard fail).
#
# Run: bash scripts/ci/tests/promote-build-payload.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CI_DIR}/../.." && pwd)"
PROMOTE_BUILD_PAYLOAD="${CI_DIR}/promote-build-payload.sh"
PROMOTE_K8S="${CI_DIR}/promote-k8s-image.sh"
UPDATE_MAP="${CI_DIR}/update-source-sha-map.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FAILED=0

make_payload() {
  local out="$1" source_sha="$2" targets_json="$3"
  cat >"$out" <<JSON
{"image_tag":"pr-61-test","source_sha":"${source_sha}","targets":${targets_json}}
JSON
}

# Stage a deploy-branch checkout with real overlays from the repo so promote-
# k8s-image.sh rewrites them image-name-aware against actual YAML.
stage_deploy_branch() {
  local case_dir="$1" overlay_env="$2"
  mkdir -p "$case_dir/deploy-branch/infra/k8s/overlays/${overlay_env}/poly"
  mkdir -p "$case_dir/deploy-branch/infra/k8s/overlays/${overlay_env}/scheduler-worker"
  mkdir -p "$case_dir/deploy-branch/.promote-state"
  cp "${REPO_ROOT}/infra/k8s/overlays/${overlay_env}/poly/kustomization.yaml" \
     "$case_dir/deploy-branch/infra/k8s/overlays/${overlay_env}/poly/"
  cp "${REPO_ROOT}/infra/k8s/overlays/${overlay_env}/scheduler-worker/kustomization.yaml" \
     "$case_dir/deploy-branch/infra/k8s/overlays/${overlay_env}/scheduler-worker/"
}

run_case() {
  local name="$1" node="$2" overlay_env="$3" payload_targets="$4"
  local map_script="$5" expect_promoted="$6" expect_map_keys="$7" expect_rc="${8:-0}"

  local case_dir="$WORKDIR/$name"
  mkdir -p "$case_dir"
  stage_deploy_branch "$case_dir" "$overlay_env"
  make_payload "$case_dir/payload.json" "abcdef1234567890abcdef1234567890abcdef12" "$payload_targets"
  : >"$case_dir/github_output.txt"

  local rc=0
  ( cd "$case_dir/deploy-branch" && \
    PAYLOAD_FILE="$case_dir/payload.json" \
    OVERLAY_ENV="$overlay_env" \
    NODE="$node" \
    PROMOTE_SCRIPT="$PROMOTE_K8S" \
    MAP_SCRIPT="$map_script" \
    MAP_FILE=".promote-state/source-sha-by-app.json" \
    GITHUB_OUTPUT="$case_dir/github_output.txt" \
    bash "$PROMOTE_BUILD_PAYLOAD" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log" ) \
    || rc=$?

  local got
  got="$(grep '^promoted_apps=' "$case_dir/github_output.txt" | tail -1 | sed 's/^promoted_apps=//' || true)"

  local map_keys=""
  if [ -f "$case_dir/deploy-branch/.promote-state/source-sha-by-app.json" ]; then
    map_keys=$(python3 -c 'import json,sys; print(",".join(sorted(json.load(open(sys.argv[1])).keys())))' \
      "$case_dir/deploy-branch/.promote-state/source-sha-by-app.json")
  fi

  local ok=1
  if [ "$got" != "$expect_promoted" ]; then
    echo "[FAIL] case=$name expected promoted_apps='$expect_promoted' got='$got' (rc=$rc)"
    echo "  stdout: $case_dir/stdout.log"
    echo "  stderr: $case_dir/stderr.log"
    ok=0
  fi
  if [ "$map_keys" != "$expect_map_keys" ]; then
    echo "[FAIL] case=$name expected map_keys='$expect_map_keys' got='$map_keys'"
    ok=0
  fi
  if [ "$rc" != "$expect_rc" ]; then
    echo "[FAIL] case=$name expected rc=$expect_rc got=$rc"
    ok=0
  fi
  if [ "$ok" = "1" ]; then
    echo "[PASS] case=$name promoted_apps='$got' map_keys='$map_keys' rc=$rc"
  else
    FAILED=$((FAILED + 1))
  fi
}

POLY_FULL='[
  {"target":"poly","deploy_unit":"poly","image_name":"ghcr.io/cogni-dao/cogni-poly","role":"app","tag":"","digest":"ghcr.io/cogni-dao/cogni-poly@sha256:aa01000000000000000000000000000000000000000000000000000000000000"},
  {"target":"poly-paper-sidecar","deploy_unit":"poly","image_name":"ghcr.io/cogni-dao/poly-paper-sidecar","role":"sidecar","tag":"","digest":"ghcr.io/cogni-dao/poly-paper-sidecar@sha256:bb01000000000000000000000000000000000000000000000000000000000000"},
  {"target":"scheduler-worker","deploy_unit":"scheduler-worker","image_name":"ghcr.io/cogni-dao/cogni-poly","role":"app","tag":"","digest":"ghcr.io/cogni-dao/cogni-poly@sha256:cc01000000000000000000000000000000000000000000000000000000000000"}
]'

SW_ONLY='[
  {"target":"scheduler-worker","deploy_unit":"scheduler-worker","image_name":"ghcr.io/cogni-dao/cogni-poly","role":"app","tag":"","digest":"ghcr.io/cogni-dao/cogni-poly@sha256:cc01000000000000000000000000000000000000000000000000000000000000"}
]'

# 1. Happy path — NODE=poly, candidate-a overlay, full payload. Map keys are
#    per-image (task.5006): poly + poly-paper-sidecar both promoted.
run_case "poly-candidate-a-happy" "poly" "candidate-a" "$POLY_FULL" "$UPDATE_MAP" "poly" "poly,poly-paper-sidecar" 0

# 2. Sidecar absent — NODE=poly, production overlay. App promoted, sidecar exit-2
#    skipped → no sidecar map entry written.
run_case "poly-production-sidecar-absent" "poly" "production" "$POLY_FULL" "$UPDATE_MAP" "poly" "poly" 0

# 3. Affected-only miss — NODE=poly, payload only has scheduler-worker image.
run_case "poly-affected-only-miss" "poly" "candidate-a" "$SW_ONLY" "$UPDATE_MAP" "" "" 0

# 4. MAP_SCRIPT failing — overlay writes happen, but provenance dead → rc=1.
#    /bin/false never writes the map file.
run_case "poly-map-failing" "poly" "candidate-a" "$POLY_FULL" "/bin/false" "poly" "" 1

cd "$REPO_ROOT"
if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED case(s) failed"
  exit 1
fi
echo ""
echo "all cases passed"
