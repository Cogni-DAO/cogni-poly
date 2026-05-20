#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/checkout-per-node-deploy-branch.test.sh
#
# Cases:
#   1. Per-node branch exists → checked out at its tip.
#   2. Per-node branch missing → bootstrapped from deploy/<env> tip
#      (task.5013 cold-start fix).
#   3. Whole-slot branch also missing → script exits non-zero.
#
# Uses a local bare-repo fixture as "origin" so we never touch the network.
# Run: bash scripts/ci/tests/checkout-per-node-deploy-branch.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHECKOUT="${CI_DIR}/checkout-per-node-deploy-branch.sh"

if [ ! -x "$CHECKOUT" ]; then
  echo "[FAIL] $CHECKOUT not executable" >&2
  exit 1
fi

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local name="$1" expected="$2" got="$3"
  if [ "$expected" = "$got" ]; then
    echo "[PASS] $name"
    PASS=$((PASS+1))
  else
    echo "[FAIL] $name"
    echo "  expected: $expected"
    echo "  got:      $got"
    FAIL=$((FAIL+1))
  fi
}

assert_neq_exit_zero() {
  local name="$1"
  if [ "$2" -ne 0 ]; then
    echo "[PASS] $name"
    PASS=$((PASS+1))
  else
    echo "[FAIL] $name (expected non-zero exit, got 0)"
    FAIL=$((FAIL+1))
  fi
}

# Build a fake origin bare repo with seeded branches. The script clones via
# `https://x-access-token:$GH_TOKEN@github.com/$GH_REPO.git` — we monkey-patch
# `git` so the first `clone` call rewrites the URL to our local bare path.
# Simpler: intercept by setting GH_REPO to a path-shaped value and use a
# git wrapper on PATH.

setup_origin() {
  local origin_dir="$1"; shift
  local include_per_node="$1"; shift  # "yes" | "no"
  local include_whole_slot="$1"; shift  # "yes" | "no"
  local env="$1"; shift
  local node="$1"; shift

  rm -rf "$origin_dir"
  git init --bare --initial-branch=main "$origin_dir" >/dev/null

  local work="$TMPROOT/work-$$-$RANDOM"
  git clone "$origin_dir" "$work" >/dev/null 2>&1
  (
    cd "$work"
    git config user.name "test"
    git config user.email "test@test"
    echo seed > seed.txt
    git add seed.txt
    git commit -q -m "seed main"
    git push -q origin main

    if [ "$include_whole_slot" = "yes" ]; then
      git checkout -q -B "deploy/${env}"
      echo "whole-slot" > whole-slot-marker.txt
      git add whole-slot-marker.txt
      git commit -q -m "deploy/${env} tip"
      git push -q origin "deploy/${env}"
    fi

    if [ "$include_per_node" = "yes" ]; then
      git checkout -q -B "deploy/${env}-${node}"
      echo "per-node" > per-node-marker.txt
      git add per-node-marker.txt
      git commit -q -m "deploy/${env}-${node} tip"
      git push -q origin "deploy/${env}-${node}"
    fi
  )
  rm -rf "$work"
}

# Wrap `git` so the first `git clone` redirects HTTPS → local bare path.
make_git_wrapper() {
  local bin_dir="$1"
  local origin_dir="$2"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/git" <<EOF
#!/usr/bin/env bash
# Intercept clone of the fake HTTPS URL and redirect to the local bare repo.
if [ "\${1:-}" = "clone" ]; then
  args=()
  for a in "\$@"; do
    case "\$a" in
      https://x-access-token:*@github.com/*)
        args+=("$origin_dir")
        ;;
      *)
        args+=("\$a")
        ;;
    esac
  done
  exec /usr/bin/env -u PATH PATH="$REAL_PATH" git "\${args[@]}"
fi
exec /usr/bin/env -u PATH PATH="$REAL_PATH" git "\$@"
EOF
  chmod +x "$bin_dir/git"
}

REAL_PATH="$PATH"

run_script() {
  local env="$1" node="$2" target="$3" origin="$4"
  local bin_dir="$TMPROOT/bin-$$-$RANDOM"
  make_git_wrapper "$bin_dir" "$origin"
  (
    cd "$TMPROOT"
    PATH="$bin_dir:$REAL_PATH" \
    GH_TOKEN="dummy" \
    GH_REPO="cogni-dao/test-fixture" \
    OVERLAY_ENV="$env" \
    NODE="$node" \
    TARGET_DIR="$target" \
    bash "$CHECKOUT"
  )
}

# ── Case 1: per-node branch exists
ORIGIN1="$TMPROOT/origin1.git"
setup_origin "$ORIGIN1" yes yes preview foo
TARGET1="case1-deploy-branch"
rm -rf "${TMPROOT:?}/$TARGET1"
run_script preview foo "$TARGET1" "$ORIGIN1" >/dev/null 2>&1
branch=$(git -C "$TMPROOT/$TARGET1" rev-parse --abbrev-ref HEAD)
assert_eq "case 1: per-node branch checked out" "deploy/preview-foo" "$branch"
has_per_node=$(test -f "$TMPROOT/$TARGET1/per-node-marker.txt" && echo yes || echo no)
assert_eq "case 1: per-node tip content present" "yes" "$has_per_node"

# ── Case 2: per-node missing → bootstrap from deploy/<env>
ORIGIN2="$TMPROOT/origin2.git"
setup_origin "$ORIGIN2" no yes preview bar
TARGET2="case2-deploy-branch"
rm -rf "${TMPROOT:?}/$TARGET2"
log=$(run_script preview bar "$TARGET2" "$ORIGIN2" 2>&1)
branch=$(git -C "$TMPROOT/$TARGET2" rev-parse --abbrev-ref HEAD)
assert_eq "case 2: per-node branch created locally" "deploy/preview-bar" "$branch"
has_whole_slot=$(test -f "$TMPROOT/$TARGET2/whole-slot-marker.txt" && echo yes || echo no)
assert_eq "case 2: bootstrapped from whole-slot tip" "yes" "$has_whole_slot"
case "$log" in
  *"bootstrapping from deploy/preview"*) bootstrap_warned=yes ;;
  *) bootstrap_warned=no ;;
esac
assert_eq "case 2: bootstrap warning emitted" "yes" "$bootstrap_warned"

# ── Case 3: whole-slot also missing → hard fail
ORIGIN3="$TMPROOT/origin3.git"
setup_origin "$ORIGIN3" no no preview baz
TARGET3="case3-deploy-branch"
rm -rf "${TMPROOT:?}/$TARGET3"
set +e
run_script preview baz "$TARGET3" "$ORIGIN3" >/dev/null 2>&1
rc=$?
set -e
assert_neq_exit_zero "case 3: missing whole-slot is a hard error" "$rc"

echo
echo "── checkout-per-node-deploy-branch test summary: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
