#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/verify-buildsha.test.sh — task.5006 image-native witness.
#
# Verifies the post-task.5006 verify-buildsha.sh contract:
#   - reads org.opencontainers.image.revision via crane config off the
#     overlay-pinned digest
#   - label == map[image]            → pass
#   - label-missing on a digest      → TRANSITION_SAFE warn-skip (pass)
#   - map-entry-missing for image    → TRANSITION_SAFE warn-skip (pass)
#   - label-mismatch                 → hard fail (the PR #121 lying-overlay case)
#   - unknown node / missing overlay → warn-skip, pass
#   - MARKER_DIR receives verified-<node>.txt for non-failing nodes
#
# Crane is faked via a script on PATH that reads stub configs out of a fixture
# dir keyed by the requested image ref. No network, no docker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CI_DIR}/../.." && pwd)"
VERIFY_SCRIPT="${CI_DIR}/verify-buildsha.sh"

if [ ! -f "$VERIFY_SCRIPT" ]; then
  echo "[FAIL] verify-buildsha.sh not found at $VERIFY_SCRIPT" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

EXPECTED="abcdef0123456789abcdef0123456789abcdef01"
WRONG="0000000000000000000000000000000000000000"

# Real overlay digests in candidate-a/poly/kustomization.yaml as of task.5006.
POLY_REF="ghcr.io/cogni-dao/cogni-poly@sha256:bae514810c27ce38d0602a560fe798f4037f0b033fb2362d4a53eabefc6e793d"
SIDECAR_REF="ghcr.io/cogni-dao/poly-paper-sidecar@sha256:e96106e8aae2478a8ee506d3f837024ac2e7a415b0cc6491bee6f4d9f541d014"

stage_overlay() {
  local case_dir="$1"
  mkdir -p "$case_dir/infra/k8s/overlays/candidate-a/poly"
  cp "${REPO_ROOT}/infra/k8s/overlays/candidate-a/poly/kustomization.yaml" \
    "$case_dir/infra/k8s/overlays/candidate-a/poly/"
}

write_map() {
  local path="$1"; shift
  mkdir -p "$(dirname "$path")"
  python3 - "$path" "$@" <<'PY'
import json, sys
path = sys.argv[1]
pairs = sys.argv[2:]
data = {pairs[i]: pairs[i+1] for i in range(0, len(pairs), 2)}
with open(path, "w") as h:
    json.dump(data, h)
PY
}

# Fake crane on PATH. `crane config <ref>` resolves fixtures keyed by ref.
# <ref>.json    → emit that as the image config.
# <ref>.missing → emit an empty `{"config":{}}` (label-absent).
# neither       → exit non-zero (simulates network/auth failure).
make_fake_crane() {
  local fixture_dir="$1"
  local bin_dir="${WORKDIR}/bin-${RANDOM}"
  mkdir -p "$bin_dir"
  cat >"${bin_dir}/crane" <<EOF
#!/usr/bin/env bash
if [ "\$1" != "config" ]; then
  echo "fake-crane: unsupported subcommand: \$1" >&2
  exit 2
fi
ref="\$2"
safe=\$(printf '%s' "\$ref" | tr '/:@' '___')
fixture="${fixture_dir}/\${safe}.json"
missing_marker="${fixture_dir}/\${safe}.missing"
if [ -f "\$missing_marker" ]; then
  printf '{"config":{}}'
  exit 0
fi
if [ -f "\$fixture" ]; then
  cat "\$fixture"
  exit 0
fi
echo "fake-crane: no fixture for ref=\$ref" >&2
exit 1
EOF
  chmod +x "${bin_dir}/crane"
  printf '%s' "$bin_dir"
}

make_crane_fixture() {
  local fixture_dir="$1" ref="$2" sha="${3:-}"
  mkdir -p "$fixture_dir"
  local safe
  safe=$(printf '%s' "$ref" | tr '/:@' '___')
  if [ -z "$sha" ]; then
    : >"${fixture_dir}/${safe}.missing"
    return
  fi
  python3 - "${fixture_dir}/${safe}.json" "$sha" <<'PY'
import json, sys
path, sha = sys.argv[1], sys.argv[2]
with open(path, "w") as h:
    json.dump({"config": {"Labels": {"org.opencontainers.image.revision": sha}}}, h)
PY
}

FAILED=0

run_case() {
  local label="$1" expected_exit="$2" case_dir="$3" map_path="$4" fixture_dir="$5" marker_dir="${6:-}"
  local bin_dir
  bin_dir=$(make_fake_crane "$fixture_dir")

  set +e
  ( cd "$case_dir" && \
    PATH="${bin_dir}:${PATH}" \
    OVERLAY_ENV="candidate-a" \
    NODES="poly" \
    SOURCE_SHA_MAP="$map_path" \
    MARKER_DIR="$marker_dir" \
    bash "$VERIFY_SCRIPT" ) >"${WORKDIR}/out-${label}.log" 2>&1
  local actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "[FAIL] ${label}: expected exit ${expected_exit}, got ${actual_exit}"
    echo "--- output ---"
    cat "${WORKDIR}/out-${label}.log"
    FAILED=$((FAILED + 1))
    return 1
  fi
  echo "[PASS] ${label}"
}

# --- Case 1: both images labeled, both match map → pass ---
C1="${WORKDIR}/case1"; stage_overlay "$C1"
write_map "${C1}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F1="${WORKDIR}/fix1"
make_crane_fixture "$F1" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F1" "$SIDECAR_REF" "$EXPECTED"
run_case "both-images-match" 0 "$C1" "${C1}/map.json" "$F1"
grep -q "poly/poly: revision=" "${WORKDIR}/out-both-images-match.log" || { echo "[FAIL] expected poly revision line"; FAILED=$((FAILED+1)); }
grep -q "poly/poly-paper-sidecar: revision=" "${WORKDIR}/out-both-images-match.log" || { echo "[FAIL] expected sidecar revision line"; FAILED=$((FAILED+1)); }

# --- Case 2: sidecar label mismatches map → hard fail ---
C2="${WORKDIR}/case2"; stage_overlay "$C2"
write_map "${C2}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F2="${WORKDIR}/fix2"
make_crane_fixture "$F2" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F2" "$SIDECAR_REF" "$WRONG"
run_case "sidecar-mismatch-hard-fails" 1 "$C2" "${C2}/map.json" "$F2"
grep -q "revision-label mismatch" "${WORKDIR}/out-sidecar-mismatch-hard-fails.log" || { echo "[FAIL] expected mismatch error text"; FAILED=$((FAILED+1)); }

# --- Case 3: sidecar label MISSING → TRANSITION_SAFE warn-skip (pass) ---
C3="${WORKDIR}/case3"; stage_overlay "$C3"
write_map "${C3}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F3="${WORKDIR}/fix3"
make_crane_fixture "$F3" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F3" "$SIDECAR_REF" ""
run_case "label-missing-warn-skip" 0 "$C3" "${C3}/map.json" "$F3"
grep -q "no org.opencontainers.image.revision label" "${WORKDIR}/out-label-missing-warn-skip.log" || { echo "[FAIL] expected label-missing warn"; FAILED=$((FAILED+1)); }

# --- Case 4: map-entry MISSING for sidecar → TRANSITION_SAFE warn-skip (pass) ---
C4="${WORKDIR}/case4"; stage_overlay "$C4"
write_map "${C4}/map.json" poly "$EXPECTED"
F4="${WORKDIR}/fix4"
make_crane_fixture "$F4" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F4" "$SIDECAR_REF" "$EXPECTED"
run_case "map-entry-missing-warn-skip" 0 "$C4" "${C4}/map.json" "$F4"
grep -q "source-sha-map has no entry" "${WORKDIR}/out-map-entry-missing-warn-skip.log" || { echo "[FAIL] expected map-missing warn"; FAILED=$((FAILED+1)); }

# --- Case 5: SOURCE_SHA_MAP file missing entirely → warn + pass (first-deploy) ---
C5="${WORKDIR}/case5"; stage_overlay "$C5"
F5="${WORKDIR}/fix5"
make_crane_fixture "$F5" "$POLY_REF" "$EXPECTED"
run_case "map-file-missing-warns-passes" 0 "$C5" "${C5}/does-not-exist.json" "$F5"

# --- Case 6: MARKER_DIR receives verified-poly.txt on a clean pass ---
C6="${WORKDIR}/case6"; stage_overlay "$C6"
write_map "${C6}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F6="${WORKDIR}/fix6"
make_crane_fixture "$F6" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F6" "$SIDECAR_REF" "$EXPECTED"
M6="${C6}/markers"
run_case "marker-dir-written" 0 "$C6" "${C6}/map.json" "$F6" "$M6"
if [ ! -f "${M6}/verified-poly.txt" ]; then
  echo "[FAIL] marker-dir-written: expected ${M6}/verified-poly.txt"
  FAILED=$((FAILED + 1))
fi

# --- Case 7: MARKER_DIR NOT written when an image hard-fails ---
C7="${WORKDIR}/case7"; stage_overlay "$C7"
write_map "${C7}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F7="${WORKDIR}/fix7"
make_crane_fixture "$F7" "$POLY_REF" "$WRONG"
make_crane_fixture "$F7" "$SIDECAR_REF" "$EXPECTED"
M7="${C7}/markers"
run_case "marker-not-written-on-failure" 1 "$C7" "${C7}/map.json" "$F7" "$M7"
if [ -f "${M7}/verified-poly.txt" ]; then
  echo "[FAIL] marker-not-written-on-failure: marker should NOT exist after hard fail"
  FAILED=$((FAILED + 1))
fi

# --- Case 8: NODES includes unknown deploy unit → warn-skip, pass ---
C8="${WORKDIR}/case8"; stage_overlay "$C8"
write_map "${C8}/map.json" poly "$EXPECTED"
F8="${WORKDIR}/fix8"
make_crane_fixture "$F8" "$POLY_REF" "$EXPECTED"
set +e
( cd "$C8" && \
  PATH="$(make_fake_crane "$F8"):${PATH}" \
  OVERLAY_ENV="candidate-a" \
  NODES="poly,ghostnode" \
  SOURCE_SHA_MAP="${C8}/map.json" \
  bash "$VERIFY_SCRIPT" ) >"${WORKDIR}/out-unknown-node.log" 2>&1
ex8=$?
set -e
if [ "$ex8" -ne 0 ]; then
  echo "[FAIL] unknown-node: expected exit 0, got ${ex8}"
  cat "${WORKDIR}/out-unknown-node.log"
  FAILED=$((FAILED + 1))
else
  grep -q "unknown deploy unit 'ghostnode'" "${WORKDIR}/out-unknown-node.log" || {
    echo "[FAIL] unknown-node: missing warn text"
    FAILED=$((FAILED + 1))
  }
  echo "[PASS] unknown-node-warns-and-passes"
fi

# --- Case 9: crane FAILS to read a digest → hard fail (NOT warn-skip) ---
# Simulates a docker-login regression or GHCR outage. The verifier must NOT
# silently green: an unreadable witness is fail-closed.
C9b="${WORKDIR}/case9b"; stage_overlay "$C9b"
write_map "${C9b}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED"
F9b="${WORKDIR}/fix9b"
make_crane_fixture "$F9b" "$POLY_REF" "$EXPECTED"
# No fixture written for SIDECAR_REF → fake-crane exits 1 (simulates auth/network/404).
M9b="${C9b}/markers"
run_case "crane-failure-hard-fails" 1 "$C9b" "${C9b}/map.json" "$F9b" "$M9b"
grep -q "crane could not read image config" "${WORKDIR}/out-crane-failure-hard-fails.log" || { echo "[FAIL] expected crane-failure error text"; FAILED=$((FAILED+1)); }
if [ -f "${M9b}/verified-poly.txt" ]; then
  echo "[FAIL] crane-failure-hard-fails: marker should NOT exist after hard fail"
  FAILED=$((FAILED + 1))
fi

# --- Case 10: multi-node NODES — each node verified independently, no
# cross-node leakage of overlay-ref state across loop iterations. Stage two
# real overlays (poly + scheduler-worker) and assert both nodes pass cleanly.
C10="${WORKDIR}/case10"
mkdir -p "${C10}/infra/k8s/overlays/candidate-a/poly" "${C10}/infra/k8s/overlays/candidate-a/scheduler-worker"
cp "${REPO_ROOT}/infra/k8s/overlays/candidate-a/poly/kustomization.yaml" "${C10}/infra/k8s/overlays/candidate-a/poly/"
cp "${REPO_ROOT}/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml" "${C10}/infra/k8s/overlays/candidate-a/scheduler-worker/"
# Read scheduler-worker's current overlay digest dynamically — overlay can drift.
SW_REF=$(python3 -c '
import re,sys
text=open(sys.argv[1]).read()
m=re.search(r"name:\s*(ghcr\.io/cogni-dao/cogni-poly).*?digest:\s*\"(sha256:[0-9a-f]+)\"",text,re.S)
if m: print(f"{m.group(1)}@{m.group(2)}")
' "${C10}/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml")
write_map "${C10}/map.json" poly "$EXPECTED" poly-paper-sidecar "$EXPECTED" scheduler-worker "$EXPECTED"
F10="${WORKDIR}/fix10"
make_crane_fixture "$F10" "$POLY_REF" "$EXPECTED"
make_crane_fixture "$F10" "$SIDECAR_REF" "$EXPECTED"
[ -n "$SW_REF" ] && make_crane_fixture "$F10" "$SW_REF" "$EXPECTED"
M10="${C10}/markers"
set +e
( cd "$C10" && \
  PATH="$(make_fake_crane "$F10"):${PATH}" \
  OVERLAY_ENV="candidate-a" \
  NODES="poly,scheduler-worker" \
  SOURCE_SHA_MAP="${C10}/map.json" \
  MARKER_DIR="$M10" \
  bash "$VERIFY_SCRIPT" ) >"${WORKDIR}/out-multi-node.log" 2>&1
ex10=$?
set -e
if [ "$ex10" -ne 0 ]; then
  echo "[FAIL] multi-node: expected exit 0, got ${ex10}"
  cat "${WORKDIR}/out-multi-node.log"
  FAILED=$((FAILED + 1))
elif [ ! -f "${M10}/verified-poly.txt" ] || [ ! -f "${M10}/verified-scheduler-worker.txt" ]; then
  echo "[FAIL] multi-node: missing per-node markers"
  ls "$M10" 2>&1
  FAILED=$((FAILED + 1))
else
  echo "[PASS] multi-node-csv-each-verified-independently"
fi

C9="${WORKDIR}/case11-empty"; stage_overlay "$C9"
write_map "${C9}/map.json" poly "$EXPECTED"
set +e
( cd "$C9" && \
  PATH="$(make_fake_crane "${WORKDIR}/fix-empty"):${PATH}" \
  OVERLAY_ENV="candidate-a" \
  NODES="" \
  SOURCE_SHA_MAP="${C9}/map.json" \
  bash "$VERIFY_SCRIPT" ) >"${WORKDIR}/out-empty-nodes.log" 2>&1
ex9=$?
set -e
if [ "$ex9" -ne 0 ]; then
  echo "[FAIL] empty-NODES: expected exit 0, got ${ex9}"
  cat "${WORKDIR}/out-empty-nodes.log"
  FAILED=$((FAILED + 1))
else
  echo "[PASS] empty-NODES-noop"
fi

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED case(s) failed"
  exit 1
fi
echo "✅ verify-buildsha.test.sh — all cases passed"
