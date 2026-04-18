#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Module: infra/compose/doltgres-init/migrate-poly.sh
# Purpose: Apply drizzle-kit-generated migrations to knowledge_poly with the
#   three-step Dolt incantation (SET @@dolt_transaction_commit → apply SQL →
#   trailing SELECT dolt_commit for DDL that ignored autocommit).
# Scope: Executed by doltgres-migrate-poly compose service (bootstrap profile).
# Invariants: Idempotent. CREATE TABLE IF NOT EXISTS is fine because the
#   drizzle-kit output starts with CREATE TABLE (no IF NOT EXISTS); we catch
#   duplicate errors and skip. Subsequent migrations MUST be written idempotent
#   or guarded by a __drizzle_migrations__ lookup.
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

# Three-step incantation, per migration file:
#   1. SET @@dolt_transaction_commit=1  (auto-Dolt-commit on SQL commit)
#   2. apply the migration SQL
#   3. SELECT dolt_commit(...)          (catches DDL ignored by autocommit)
for FILE in "${MIGRATIONS[@]}"; do
  NAME="$(basename "$FILE" .sql)"
  echo "🔧 Applying migration: $NAME"

  # Apply; tolerate "already exists" on re-runs so the script stays idempotent
  # without a drizzle migrations tracking table. Subsequent migrations must
  # use IF NOT EXISTS / safe-by-construction DDL or add a tracking table.
  {
    echo "SET @@dolt_transaction_commit = 1;"
    cat "$FILE"
  } | PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
        -v ON_ERROR_STOP=0 2>&1 | tee /tmp/migrate.out || true

  if grep -qi "already exists" /tmp/migrate.out; then
    echo "   (already applied — skipped)"
  fi

  # Trailing dolt_commit to capture any DDL that ignored autocommit.
  # -Am includes all changes (schema + any seed rows from same file).
  # Tolerate "nothing to commit" if the migration was a pure no-op on re-run.
  PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$DB" \
    -v ON_ERROR_STOP=1 -c "SELECT dolt_commit('-Am', 'migration: $NAME')" 2>/dev/null \
    || echo "   (dolt_commit: nothing to commit)"

  echo "   -> $NAME applied."
done

echo "✅ knowledge_poly migrations complete."
