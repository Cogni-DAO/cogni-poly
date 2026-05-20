#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/report-candidate-status.test.sh
#
# Locks the GitHub commit-status 140-char description limit. The clamp
# regressed during infratest-shape-a onboarding (May 2026) when a long
# matrix-JSON description 422'd the GitHub API and failed the flight at
# the final reporting step. Cases:
#
#   1. short description (≤140) → passes through unchanged
#   2. exactly 140 chars → passes through unchanged
#   3. 141 chars → truncated to 137 + "..."
#   4. very long string → truncated to 137 + "..."
#
# `gh` is stubbed by a fake binary that captures all argv to a file; the
# test reads back the `-f description=...` value and asserts length + suffix.
#
# Run: bash scripts/ci/tests/report-candidate-status.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${CI_DIR}/report-candidate-status.sh"

if [ ! -f "$TARGET" ]; then
  echo "[FAIL] $TARGET not found" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

FAILED=0

# Fake `gh` on PATH: writes each invocation's argv (newline-separated) to a
# log file. The script's `gh api ...` call lands here; the test inspects the
# `-f description=...` arg.
make_fake_gh() {
  local bin_dir="${WORKDIR}/bin-${RANDOM}"
  local log_file="$1"
  mkdir -p "$bin_dir"
  cat >"${bin_dir}/gh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "${log_file}"
EOF
  chmod +x "${bin_dir}/gh"
  printf '%s' "$bin_dir"
}

# Extract the description argv arg from the gh log. Returns the value after `description=`.
extract_description() {
  grep '^-f$' -A 1 "$1" | grep '^description=' | head -1 | sed 's/^description=//'
}

run_case() {
  local label="$1" description="$2" expect_len="$3" expect_suffix="$4"
  local log_file="${WORKDIR}/gh-log-${label}.txt"
  local bin_dir
  bin_dir=$(make_fake_gh "$log_file")

  set +e
  PATH="${bin_dir}:${PATH}" \
    REPOSITORY="owner/repo" \
    SHA="deadbeef" \
    STATE="success" \
    DESCRIPTION="$description" \
    bash "$TARGET" >"${WORKDIR}/out-${label}.log" 2>&1
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    echo "[FAIL] ${label}: script exit ${rc}"
    cat "${WORKDIR}/out-${label}.log"
    FAILED=$((FAILED + 1))
    return 1
  fi

  local got_desc
  got_desc=$(extract_description "$log_file")
  local got_len="${#got_desc}"

  if [ "$got_len" -ne "$expect_len" ]; then
    echo "[FAIL] ${label}: expected description length ${expect_len}, got ${got_len}"
    echo "  description sent: '${got_desc}'"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if [ -n "$expect_suffix" ]; then
    if [ "${got_desc: -3}" != "$expect_suffix" ]; then
      echo "[FAIL] ${label}: expected trailing '${expect_suffix}', got '${got_desc: -3}'"
      FAILED=$((FAILED + 1))
      return 1
    fi
  fi

  echo "[PASS] ${label} (len=${got_len})"
}

SHORT="Candidate flight passed"
EXACT_140=$(printf 'x%.0s' $(seq 1 140))
ONE_OVER=$(printf 'x%.0s' $(seq 1 141))
WAY_OVER=$(printf 'Candidate flight passed (matrix: %s)' "$(printf 'a%.0s' $(seq 1 500))")

run_case "short-unchanged" "$SHORT" "${#SHORT}" ""
run_case "exact-140-unchanged" "$EXACT_140" 140 ""
run_case "one-over-truncated" "$ONE_OVER" 140 "..."
run_case "way-over-truncated" "$WAY_OVER" 140 "..."

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED case(s) failed"
  exit 1
fi
echo "✅ report-candidate-status.test.sh — all cases passed"
