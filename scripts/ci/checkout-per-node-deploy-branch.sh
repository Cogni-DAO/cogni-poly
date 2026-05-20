#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Clone the repo's per-node deploy branch into TARGET_DIR. If
# `deploy/<env>-<node>` is missing on origin (a brand-new service's first
# leg in this env), bootstrap from `deploy/<env>` instead of hard-failing.
#
# Shared by candidate-flight.yml and promote-and-deploy.yml so the
# candidate-a → preview → production chain is homogeneous. Spec:
# work/items/task.5013 (BOOTSTRAP_PROMOTE_AND_DEPLOY_COLD_START).
#
# Required env: GH_TOKEN, GH_REPO (owner/repo), OVERLAY_ENV
#               (candidate-a|preview|production), NODE
# Optional env: TARGET_DIR (default: deploy-branch), GIT_USER_NAME,
#               GIT_USER_EMAIL

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN required}"
: "${GH_REPO:?GH_REPO required (owner/repo)}"
: "${OVERLAY_ENV:?OVERLAY_ENV required (candidate-a|preview|production)}"
: "${NODE:?NODE required}"

TARGET_DIR="${TARGET_DIR:-deploy-branch}"
PER_NODE_BRANCH="deploy/${OVERLAY_ENV}-${NODE}"
WHOLE_SLOT_BRANCH="deploy/${OVERLAY_ENV}"

git clone "https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git" "$TARGET_DIR"
cd "$TARGET_DIR"
git fetch origin "+refs/heads/deploy/*:refs/remotes/origin/deploy/*"

if git rev-parse --verify --quiet "refs/remotes/origin/${PER_NODE_BRANCH}" >/dev/null; then
  git checkout -B "${PER_NODE_BRANCH}" "origin/${PER_NODE_BRANCH}"
else
  echo "::warning::Per-node branch ${PER_NODE_BRANCH} missing — bootstrapping from ${WHOLE_SLOT_BRANCH}"
  if ! git rev-parse --verify --quiet "refs/remotes/origin/${WHOLE_SLOT_BRANCH}" >/dev/null; then
    echo "::error::Whole-slot branch ${WHOLE_SLOT_BRANCH} missing on origin — cannot bootstrap ${PER_NODE_BRANCH}"
    exit 1
  fi
  git checkout -B "${PER_NODE_BRANCH}" "origin/${WHOLE_SLOT_BRANCH}"
fi

git config user.name "${GIT_USER_NAME:-github-actions[bot]}"
git config user.email "${GIT_USER_EMAIL:-github-actions[bot]@users.noreply.github.com}"
