#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/wait-for-in-cluster-services.test.sh
#
# Verifies the catalog-driven deployment-name derivation. Replaces the prior
# hardcoded `case "$node"` allowlist that required a script edit for every
# new Shape A service (caught by infratest-shape-a onboarding, May 2026).
#
# Cases:
#   1. type=node    catalog entry → resolves to `<name>-node-app`
#   2. type=service catalog entry → resolves to `<name>`
#   3. CSV mixing both types → both resolve independently in one run
#   4. Missing catalog file → hard-fail with explicit error
#   5. Catalog with type=other → hard-fail with explicit error
#
# SSH + kubectl are stubbed via a fake `ssh` binary on PATH that just echoes
# its arguments — sufficient to assert the script reaches each gate with the
# correct service name without needing a real VM. Rollout-status output is
# stubbed to look successful so the script doesn't loop.
#
# Run: bash scripts/ci/tests/wait-for-in-cluster-services.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${CI_DIR}/wait-for-in-cluster-services.sh"

if [ ! -f "$TARGET" ]; then
  echo "[FAIL] $TARGET not found" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

FAILED=0

# Fake `ssh` on PATH. Logs every invocation to a file so the test can assert
# which kubectl commands the script issued. Returns a fixed "success" output
# for both `rollout status` and the endpoint-count probe.
make_fake_ssh() {
  local bin_dir="${WORKDIR}/bin-${RANDOM}"
  local log_file="$1"
  mkdir -p "$bin_dir"
  cat >"${bin_dir}/ssh" <<EOF
#!/usr/bin/env bash
# Log the last arg (the remote command).
remote_cmd="\${@: -1}"
echo "\$remote_cmd" >> "${log_file}"
case "\$remote_cmd" in
  *"rollout status"*)
    echo "deployment \"\$(echo \$remote_cmd | sed -n 's/.*deployment\\///; s/ .*//p')\" successfully rolled out"
    exit 0
    ;;
  *"jsonpath='{.spec.replicas}'"*)
    echo "1"
    ;;
  *"jsonpath='{range .subsets"*)
    # Real remote pipes through `tr -cd '.' | wc -c` — emit the final integer.
    echo "1"
    ;;
  *)
    echo ""
    ;;
esac
exit 0
EOF
  chmod +x "${bin_dir}/ssh"
  printf '%s' "$bin_dir"
}

stage_catalog() {
  local case_dir="$1"
  mkdir -p "${case_dir}/infra/catalog"
  cp "${CI_DIR}/../../infra/catalog/_schema.json" "${case_dir}/infra/catalog/" 2>/dev/null || true
}

write_catalog_entry() {
  local case_dir="$1" name="$2" type="$3"
  cat >"${case_dir}/infra/catalog/${name}.yaml" <<EOF
schema_version: 2
name: ${name}
type: ${type}
deploy:
  candidate_a_branch: deploy/candidate-a-${name}
  preview_branch: deploy/preview-${name}
  production_branch: deploy/production-${name}
  path_prefix: services/${name}/
  port: 9000
images:
  - name: ${name}
    role: app
    dockerfile: services/${name}/Dockerfile
    image_name: ghcr.io/cogni-dao/${name}
    image_tag_suffix: ""
    build:
      cache_scope: build-${name}
EOF
}

run_case() {
  local label="$1" promoted_apps="$2" expected_exit="$3" expected_substrings="$4" case_dir="$5"
  local log_file="${WORKDIR}/ssh-log-${label}.txt"
  : >"$log_file"
  local bin_dir
  bin_dir=$(make_fake_ssh "$log_file")

  set +e
  PATH="${bin_dir}:${PATH}" \
    VM_HOST="test.example" \
    DEPLOY_ENVIRONMENT="candidate-a" \
    SSH_KEY="/dev/null" \
    ROLLOUT_TIMEOUT="5" \
    ENDPOINT_CUTOVER_TIMEOUT="3" \
    PROMOTED_APPS="$promoted_apps" \
    COGNI_CATALOG_ROOT="${case_dir}/infra/catalog" \
    bash "$TARGET" >"${WORKDIR}/out-${label}.log" 2>&1
  local actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "[FAIL] ${label}: expected exit ${expected_exit}, got ${actual_exit}"
    echo "--- stdout/stderr ---"
    cat "${WORKDIR}/out-${label}.log"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if [ -n "$expected_substrings" ]; then
    while IFS= read -r needle; do
      [ -z "$needle" ] && continue
      if ! grep -qF "$needle" "${WORKDIR}/out-${label}.log" "$log_file" 2>/dev/null; then
        echo "[FAIL] ${label}: expected substring '${needle}' not found in output or ssh log"
        echo "--- output ---"
        cat "${WORKDIR}/out-${label}.log"
        echo "--- ssh log ---"
        cat "$log_file"
        FAILED=$((FAILED + 1))
        return 1
      fi
    done <<< "$expected_substrings"
  fi
  echo "[PASS] ${label}"
}

# --- Case 1: type=node → <name>-node-app ---
C1="${WORKDIR}/case1"; stage_catalog "$C1"
write_catalog_entry "$C1" "alphanode" "node"
run_case "type-node-derives-node-app-suffix" "alphanode" 0 \
  "rollout status deployment/alphanode-node-app" "$C1"

# --- Case 2: type=service → <name> ---
C2="${WORKDIR}/case2"; stage_catalog "$C2"
write_catalog_entry "$C2" "betaworker" "service"
run_case "type-service-derives-bare-name" "betaworker" 0 \
  "rollout status deployment/betaworker" "$C2"

# --- Case 3: CSV mixes both types in one run ---
C3="${WORKDIR}/case3"; stage_catalog "$C3"
write_catalog_entry "$C3" "alphanode" "node"
write_catalog_entry "$C3" "betaworker" "service"
expected_c3=$'rollout status deployment/alphanode-node-app\nrollout status deployment/betaworker'
run_case "csv-mixed-types-each-derives-correctly" "alphanode,betaworker" 0 "$expected_c3" "$C3"

# --- Case 4: missing catalog → hard fail with explicit error ---
C4="${WORKDIR}/case4"; stage_catalog "$C4"
run_case "missing-catalog-hard-fails" "ghost-unit" 1 \
  "no catalog entry for deploy unit 'ghost-unit'" "$C4"

# --- Case 5: invalid type → hard fail ---
C5="${WORKDIR}/case5"; stage_catalog "$C5"
cat >"${C5}/infra/catalog/weird-unit.yaml" <<EOF
schema_version: 2
name: weird-unit
type: cron
EOF
run_case "invalid-type-hard-fails" "weird-unit" 1 \
  "unsupported type='cron'" "$C5"

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED case(s) failed"
  exit 1
fi
echo "✅ wait-for-in-cluster-services.test.sh — all cases passed"
