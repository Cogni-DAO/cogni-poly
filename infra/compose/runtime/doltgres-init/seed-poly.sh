#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Module: infra/compose/doltgres-init/seed-poly.sh
# Purpose: Apply seed-poly.sql to knowledge_poly and stamp a named Dolt commit.
#   Tolerates only the idempotent "nothing to commit" case on re-runs; any
#   other error propagates. Mirrors the migrate-poly.sh error-handling pattern.
# Scope: Executed by doltgres-seed-poly compose service (bootstrap profile).
# Side-effects: IO (psql commands against Doltgres server)
# Links: nodes/poly/app/schema/README.md

DG_HOST="${DOLTGRES_HOST:-doltgres}"
DG_PORT="${DOLTGRES_PORT:-5432}"
DG_PASS="${DOLTGRES_PASSWORD:-doltgres}"
DB="${DOLTGRES_DB:-knowledge_poly}"
SEED_FILE="${SEED_FILE:-/seed.sql}"

echo "🌱 Seeding $DB from $SEED_FILE..."
PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
  -v ON_ERROR_STOP=1 -f "$SEED_FILE"

# Stamp a named Dolt commit. Tolerate only "nothing to commit" — any other
# error (permissions, function missing, etc.) must propagate.
COMMIT_LOG=$(mktemp)
if PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
      -v ON_ERROR_STOP=1 -c "SELECT dolt_commit('-Am', 'seed: poly protocol facts v0')" \
      >"$COMMIT_LOG" 2>&1; then
  cat "$COMMIT_LOG"
elif grep -qi "nothing to commit" "$COMMIT_LOG"; then
  echo "   (dolt_commit: nothing to commit — seeds already applied)"
else
  cat "$COMMIT_LOG"
  echo "❌ dolt_commit for poly seed failed"
  rm -f "$COMMIT_LOG"
  exit 1
fi
rm -f "$COMMIT_LOG"

echo "✅ Poly seed complete."
