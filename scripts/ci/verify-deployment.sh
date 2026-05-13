#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# verify-deployment.sh — Post-deploy validation: health polls + smoke tests.
# Called by the verify job in promote-and-deploy.yml.
# Dependency reachability is already confirmed by deploy-infra.sh (Step 6.8).
#
# Usage: verify-deployment.sh
# Env:   DOMAIN (required), VM_HOST (optional, for diagnostics on failure),
#        K8S_NAMESPACE (optional), SSH_DEPLOY_KEY (optional)

set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN is required}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"
SLEEP="${SLEEP:-15}"

# Node-app list comes from infra/catalog (CATALOG_IS_SSOT, docs/spec/ci-cd.md
# axiom 16). Adding/removing a node in catalog updates the health-poll set
# automatically. Replaces a previously-hardcoded operator/poly/resy iteration
# that was stale in both cogni and cogni-poly after the poly extraction
# (bug.5052).
_verify_deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/image-tags.sh
. "${_verify_deployment_dir}/lib/image-tags.sh"

if [[ "$DOMAIN" == *.*.* ]]; then
  NODE_JOIN="-"
else
  NODE_JOIN="."
fi

# Hostname convention (mirrors verify-buildsha.sh): operator → DOMAIN directly;
# every other node → ${node}${NODE_JOIN}${DOMAIN}.
url_for_node() {
  local node="$1"
  if [ "$node" = "operator" ]; then
    printf 'https://%s' "$DOMAIN"
  else
    printf 'https://%s%s%s' "$node" "$NODE_JOIN" "$DOMAIN"
  fi
}

# ── Health polls ─────────────────────────────────────────────────────────────

poll_health() {
  local name="$1"
  local url="$2"
  local attempt=1

  echo "Polling $name at $url/readyz ..."
  while [ $attempt -le $MAX_ATTEMPTS ]; do
    STATUS=$(curl -sk -o /dev/null -w '%{http_code}' "$url/readyz" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      echo "✅ $name healthy (attempt $attempt)"
      return 0
    fi
    echo "  $name: HTTP $STATUS (attempt $attempt/$MAX_ATTEMPTS)"
    sleep "$SLEEP"
    attempt=$((attempt + 1))
  done
  echo "❌ $name failed health check after $MAX_ATTEMPTS attempts"
  return 1
}

if [ "${#NODE_TARGETS[@]}" -eq 0 ]; then
  echo "ℹ️  No node-apps in catalog — skipping health polls."
  exit 0
fi

declare -a PIDS=()
declare -a NAMES=()
for node in "${NODE_TARGETS[@]}"; do
  url=$(url_for_node "$node")
  poll_health "$node" "$url" &
  PIDS+=("$!")
  NAMES+=("$node")
done

FAILED=0
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}" || { echo "❌ ${NAMES[$i]} failed"; FAILED=1; }
done

if [ $FAILED -ne 0 ]; then
  echo "❌ One or more nodes failed health checks"
  exit 1
fi
echo "✅ All nodes healthy"

# ── Smoke tests ──────────────────────────────────────────────────────────────

for node in "${NODE_TARGETS[@]}"; do
  url=$(url_for_node "$node")
  BODY=$(curl -sk "$url/livez" 2>/dev/null)
  echo "$url/livez → $BODY"
  if ! echo "$BODY" | grep -q '"status"'; then
    echo "❌ $url/livez did not return expected JSON"
    exit 1
  fi
done
echo "✅ Smoke tests passed"
