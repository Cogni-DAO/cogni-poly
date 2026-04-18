#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Module: infra/compose/doltgres-init/migrate-poly.sh
# Purpose: Apply drizzle-kit-generated migrations to knowledge_poly and stamp
#   each with a named Dolt commit so `dolt_log` is an auditable migration trail.
# Scope: Executed by doltgres-migrate-poly compose service (bootstrap profile).
# Invariants: Idempotent for the v0 initial migration via catch-and-match on
#   "already exists". Once the schema evolves, switch to a __drizzle_migrations__
#   tracking table or IF NOT EXISTS guards — do NOT weaken error handling.
# Side-effects: IO (psql commands against Doltgres server)
# Links: nodes/poly/app/schema/README.md
#   Dolt guidance: https://www.dolthub.com/blog/2022-07-20-schema-migrations/
#   DDL autocommit gotcha: https://github.com/dolthub/dolt/issues/4843

DG_HOST="${DOLTGRES_HOST:-doltgres}"
DG_PORT="${DOLTGRES_PORT:-5432}"
DG_PASS="${DOLTGRES_PASSWORD:-doltgres}"
DB="${DOLTGRES_DB:-knowledge_poly}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

echo "⏳ Waiting for Doltgres at $DG_HOST:$DG_PORT (db=$DB)..."
ELAPSED=0
TIMEOUT=60
until PGPASSWORD="$DG_PASS" pg_isready -h "$DG_HOST" -p "$DG_PORT" -U postgres >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "❌ Timed out waiting for Doltgres after ${TIMEOUT}s"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "✅ Doltgres ready."

# Apply each .sql file in order. drizzle-kit prefixes files with a version
# number (0000_, 0001_, ...); lexical sort = apply order.
shopt -s nullglob
MIGRATIONS=("$MIGRATIONS_DIR"/*.sql)
if [ ${#MIGRATIONS[@]} -eq 0 ]; then
  echo "⚠ No migration files found in $MIGRATIONS_DIR — nothing to do"
  exit 0
fi

# Per migration file:
#   1. psql -f with ON_ERROR_STOP=1 (strict — so real errors surface)
#   2. If psql fails AND the output matches "already exists", treat as
#      idempotent re-run; otherwise propagate failure.
#   3. Stamp a named Dolt commit via SELECT dolt_commit('-Am', ...). Tolerate
#      only the specific "nothing to commit" case — anything else propagates.
#
# We deliberately do NOT set @@dolt_transaction_commit. Dolt's MySQL-style
# @@variable syntax is not guaranteed to work on Doltgres (pg wire protocol),
# and the trailing explicit dolt_commit('-Am') already stages every change
# from the migration batch. One Dolt commit per migration is cleaner than
# one-per-DDL-statement anyway.
for FILE in "${MIGRATIONS[@]}"; do
  NAME="$(basename "$FILE" .sql)"
  echo "🔧 Applying migration: $NAME"

  MIGRATE_LOG=$(mktemp)
  if PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
        -v ON_ERROR_STOP=1 -f "$FILE" >"$MIGRATE_LOG" 2>&1; then
    cat "$MIGRATE_LOG"
  else
    cat "$MIGRATE_LOG"
    if grep -qi "already exists" "$MIGRATE_LOG"; then
      echo "   (already applied — skipped)"
    else
      echo "❌ Migration $NAME failed with unexpected error (see log above)"
      rm -f "$MIGRATE_LOG"
      exit 1
    fi
  fi
  rm -f "$MIGRATE_LOG"

  # Stamp a named Dolt commit. Tolerate ONLY "nothing to commit" (idempotent
  # re-run where no rows/schema changed). Any other error must propagate.
  COMMIT_LOG=$(mktemp)
  if PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
        -v ON_ERROR_STOP=1 -c "SELECT dolt_commit('-Am', 'migration: $NAME')" \
        >"$COMMIT_LOG" 2>&1; then
    :
  elif grep -qi "nothing to commit" "$COMMIT_LOG"; then
    echo "   (dolt_commit: nothing to commit — migration was a no-op)"
  else
    cat "$COMMIT_LOG"
    echo "❌ dolt_commit for migration $NAME failed"
    rm -f "$COMMIT_LOG"
    exit 1
  fi
  rm -f "$COMMIT_LOG"

  echo "   -> $NAME applied."
done

echo "✅ knowledge_poly migrations complete."
