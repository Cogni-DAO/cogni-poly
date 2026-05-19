#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# report-candidate-status.sh — post a GitHub commit-status check on a SHA.
# Used by candidate-flight.yml to mark the PR head with pending/success/
# failure so reviewers see the flight outcome inline on the PR.
#
# GitHub commit-status descriptions have a hard 140-character limit
# (https://docs.github.com/en/rest/commits/statuses). Longer descriptions
# 422 from the API. Clamp on entry so callers (workflow YAML) can pass
# rich strings — e.g. matrix JSON — without each caller learning the limit.

set -euo pipefail

REPOSITORY=${REPOSITORY:-${GITHUB_REPOSITORY:-}}
SHA=${SHA:-}
STATE=${STATE:-}
DESCRIPTION=${DESCRIPTION:-}
TARGET_URL=${TARGET_URL:-}
CONTEXT=${CONTEXT:-candidate-flight}

if [ -z "$REPOSITORY" ] || [ -z "$SHA" ] || [ -z "$STATE" ] || [ -z "$DESCRIPTION" ]; then
  echo "[ERROR] REPOSITORY, SHA, STATE, and DESCRIPTION are required" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[ERROR] gh CLI is required" >&2
  exit 1
fi

# Clamp DESCRIPTION to GitHub's 140-char status-description limit. 137 + "..."
# preserves the limit exactly and signals truncation to the human reader.
if [ "${#DESCRIPTION}" -gt 140 ]; then
  DESCRIPTION="${DESCRIPTION:0:137}..."
fi

args=(
  "repos/${REPOSITORY}/statuses/${SHA}"
  -f "state=${STATE}"
  -f "context=${CONTEXT}"
  -f "description=${DESCRIPTION}"
)

if [ -n "$TARGET_URL" ]; then
  args+=(-f "target_url=${TARGET_URL}")
fi

gh api "${args[@]}" >/dev/null
echo "Reported ${CONTEXT}=${STATE} for ${SHA}"
