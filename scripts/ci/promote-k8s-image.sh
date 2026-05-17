#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/promote-k8s-image.sh
# Purpose: Update a single image entry in a deploy-unit's overlay with a new
#          digest. Image-name-aware: rewrites ONLY the images[] entry whose
#          name: matches --image-name. v1's first-newTag-wins / first-digest-wins
#          sed has been retired — that fragility was the original sin behind
#          create-service.md's "digest:-only" rule for sidecars.
#
# Invariants:
#   - IMAGE_IMMUTABILITY: Uses @sha256: digest, never mutable tags.
#   - MANIFEST_DRIVEN_DEPLOY: Promotion = overlay change → Argo CD syncs.
#
# Exit codes:
#   0  overlay updated (digest written or already-current no-op).
#   1  error (bad args, missing overlay, malformed digest, sed failure).
#   2  no images[] entry matched --image-name in the overlay (legitimate
#      no-op when an env's overlay deliberately omits an image, e.g.
#      production doesn't carry the paper-sidecar). Caller distinguishes
#      "real promotion" from "intentional skip" by inspecting this code.
#
# Usage:
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app poly \
#     --image-name ghcr.io/cogni-dao/cogni-poly \
#     --digest ghcr.io/cogni-dao/cogni-poly@sha256:abc...
#
# --app names the DEPLOY UNIT (catalog file name); the overlay file path is
# derived from it: infra/k8s/overlays/${ENV}/${APP}/kustomization.yaml.
# --image-name selects which images[] entry inside that overlay to rewrite.
#
# By default, auto-commits and pushes when running in CI (GITHUB_SHA set).
# Pass --no-commit to update the file only — caller manages git operations.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

APP=""
DIGEST=""
ENV=""
IMAGE_NAME=""
DEPLOY_BRANCH=""
NO_COMMIT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --app)           APP="$2"; shift 2 ;;
    --digest)        DIGEST="$2"; shift 2 ;;
    --env)           ENV="$2"; shift 2 ;;
    --image-name)    IMAGE_NAME="$2"; shift 2 ;;
    --deploy-branch) DEPLOY_BRANCH="$2"; shift 2 ;;
    --no-commit)     NO_COMMIT=true; shift ;;
    *) log_error "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$APP" || -z "$DIGEST" || -z "$ENV" ]]; then
  log_error "Usage: promote-k8s-image.sh --env <overlay> --app <deploy-unit> [--image-name <ghcr.io/...>] --digest <image@sha256:...>"
  exit 1
fi

if [[ "$DIGEST" != *"@sha256:"* ]]; then
  log_error "DIGEST must contain @sha256:, got: $DIGEST"
  exit 1
fi

# Derive --image-name from --digest's left-hand side when caller didn't pass
# it explicitly. (Back-compat with single-image callers.)
DIGEST_IMAGE_NAME="${DIGEST%%@*}"
DIGEST_HASH="${DIGEST#*@}"
if [ -z "$IMAGE_NAME" ]; then
  IMAGE_NAME="$DIGEST_IMAGE_NAME"
fi

OVERLAY_FILE="infra/k8s/overlays/${ENV}/${APP}/kustomization.yaml"

if [[ ! -f "$OVERLAY_FILE" ]]; then
  log_error "Overlay file not found: $OVERLAY_FILE"
  exit 1
fi

log_info "Promoting image ${IMAGE_NAME} in ${ENV}/${APP} overlay → digest ${DIGEST_HASH:0:19}..."

# Image-name-aware rewrite. Locate the images[] entry whose name: matches
# IMAGE_NAME and rewrite that entry's newName/newTag/digest. Other entries
# are untouched, so sidecar + host + migrator can coexist without the
# first-{newTag,digest}-wins fragility.
python3 - "$OVERLAY_FILE" "$IMAGE_NAME" "$DIGEST_IMAGE_NAME" "$DIGEST_HASH" <<'PY'
import re, sys

overlay_path, target_name, new_name, new_digest = sys.argv[1:5]

with open(overlay_path, "r", encoding="utf-8") as handle:
    text = handle.read()

# Find the images: block — top-level YAML key followed by an indented sequence.
images_m = re.search(r'(?m)^images:\s*\n((?:[ \t]+.*\n)+)', text)
if not images_m:
    print(f"NO_IMAGES_BLOCK", file=sys.stderr)
    sys.exit(2)

block_start = images_m.start(1)
block_end = images_m.end(1)
block = images_m.group(1)

# Split block into entries (each entry starts with `  - name:`).
entry_pat = re.compile(r'(?m)^([ \t]+)-\s+name:\s*(\S+)\s*\n((?:\1[ \t]+.*\n)*)')
entries = list(entry_pat.finditer(block))
if not entries:
    print("NO_IMAGE_ENTRIES", file=sys.stderr)
    sys.exit(2)

target_entry = None
for e in entries:
    if e.group(2) == target_name:
        target_entry = e
        break

if target_entry is None:
    print(f"NO_MATCH:{target_name}", file=sys.stderr)
    sys.exit(2)

# Build the rewritten entry body. Preserve indentation from the matched entry.
indent = target_entry.group(1)
body = target_entry.group(3)

# Drop any existing newTag / digest / newName lines from the body — we'll write
# canonical newName + digest. (Other fields like `name` stay; we matched on it.)
keep_lines = []
for line in body.splitlines(keepends=True):
    stripped = line.lstrip()
    if stripped.startswith(("newTag:", "digest:", "newName:")):
        continue
    keep_lines.append(line)

new_body = "".join(keep_lines)
new_body += f"{indent}  newName: {new_name}\n"
new_body += f'{indent}  digest: "{new_digest}"\n'

# Reassemble the entry text.
entry_start_in_block = target_entry.start()
entry_end_in_block = target_entry.end()
new_entry = f"{indent}- name: {target_name}\n{new_body}"

new_block = block[:entry_start_in_block] + new_entry + block[entry_end_in_block:]
new_text = text[:block_start] + new_block + text[block_end:]

if new_text == text:
    print("NO_CHANGE", file=sys.stderr)
    sys.exit(0)

with open(overlay_path, "w", encoding="utf-8") as handle:
    handle.write(new_text)
print("UPDATED")
PY
rc=$?

case "$rc" in
  0)
    log_info "Updated $OVERLAY_FILE"
    ;;
  2)
    log_warn "No images[] entry matched ${IMAGE_NAME} in ${OVERLAY_FILE} — overlay intentionally omits this image (e.g. paper-sidecar absent from production). No-op."
    exit 2
    ;;
  *)
    log_error "promote-k8s-image: overlay rewrite failed (rc=${rc})"
    exit 1
    ;;
esac

if [[ "$NO_COMMIT" == "true" ]]; then
  log_info "Skipping commit (--no-commit). Caller manages git operations."
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  if [[ -z "$DEPLOY_BRANCH" ]]; then
    log_error "--deploy-branch is required when commit/push mode is enabled"
    exit 1
  fi
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
  git add "$OVERLAY_FILE"

  if git diff --cached --quiet; then
    log_info "No changes to commit (digest unchanged)"
  else
    git commit -m "chore(cd): promote ${APP}/${IMAGE_NAME##*/} to ${DIGEST_HASH:0:19}... [skip ci]"
    git push origin "HEAD:${DEPLOY_BRANCH}"
    log_info "Committed and pushed digest update to $DEPLOY_BRANCH"
  fi
else
  log_info "Not in CI — skipping commit. Review changes manually:"
  git diff "$OVERLAY_FILE" || true
fi
