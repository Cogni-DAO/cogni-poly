---
id: poly-app-schema-readme
type: readme
title: Poly App — Schema Entry Points
status: active
trust: verified
summary: Node-local schema re-exports for drizzle-kit. One file per dialect. Covers the Doltgres DDL gotcha (trailing dolt_commit).
read_when: Adding a poly-local table, changing the poly knowledge schema, or running migrations against poly's Doltgres DB.
owner: derekg1729
created: 2026-04-18
verified: 2026-04-18
tags: [poly, schema, drizzle, doltgres, migrations]
---

# Poly App Schema

Node-local schema entry points. One file per dialect. drizzle-kit configs at the repo root discover these via `schema: "./nodes/poly/app/schema/*.ts"`.

## Files

| File           | Dialect         | Target DB                    | drizzle config                    |
| -------------- | --------------- | ---------------------------- | --------------------------------- |
| `knowledge.ts` | Postgres (wire) | `knowledge_poly` on Doltgres | `drizzle.poly.doltgres.config.ts` |

Postgres-side poly-local tables (copy-trade, etc.) live sibling to this file per the repo-wide per-node schema convention; each file declares its own dialect.

## Migrating `knowledge_poly` (Doltgres)

### The two-step pattern

Doltgres is wire-compatible with Postgres, so drizzle-kit generates migrations normally — but DDL statements don't honor autocommit on Dolt (see [dolt#4843](https://github.com/dolthub/dolt/issues/4843)), so the migrator must stamp a Dolt commit explicitly after each migration. Every run is:

```bash
psql -h doltgres -p 5432 -U postgres -d knowledge_poly \
     -v ON_ERROR_STOP=1 -f 0000_init_knowledge.sql
psql -h doltgres -p 5432 -U postgres -d knowledge_poly \
     -v ON_ERROR_STOP=1 \
     -c "SELECT dolt_commit('-Am', 'migration: 0000_init_knowledge')"
```

1. `psql -f` applies the drizzle-kit-generated migration SQL under strict error stopping. Real errors fail the deploy; only `already exists` on re-runs is tolerated by the wrapper script (`migrate-poly.sh`).
2. `SELECT dolt_commit('-Am', ...)` stages all working-set changes from the migration and stamps a named Dolt commit. `dolt_log` is then an auditable migration trail. Only `nothing to commit` on idempotent re-runs is tolerated.

Dolt also exposes [`@@dolt_transaction_commit`](https://docs.dolthub.com/sql-reference/version-control/dolt-system-variables) to auto-commit every SQL transaction boundary, but the `@@variable` MySQL syntax is not verified on Doltgres's pg wire protocol, and DDL would skip it per #4843 anyway. v0 skips it — the explicit trailing `dolt_commit` covers the full delta per migration.

The migrator compose service (`doltgres-migrate-poly` → `migrate-poly.sh`) wraps both steps. The seeder (`doltgres-seed-poly` → `seed-poly.sh`) uses the identical pattern.

### Dolt's guidance

Per [DoltHub's schema-migrations blog](https://www.dolthub.com/blog/2022-07-20-schema-migrations/), this is the recommended approach for single-branch Dolt databases. Multi-branch schema migrations are a separate concern and not applicable while knowledge_poly runs on `main` only.

## Adding a table

1. Define it in the appropriate dialect file (`knowledge.ts` for Doltgres, or create a sibling file for Postgres-side tables).
2. Run `pnpm --filter @cogni/poly-app db:generate:doltgres` (or the Postgres equivalent) to generate the migration SQL.
3. Commit both the TS schema change and the generated migration in the same PR.
4. Deploy-infra runs `doltgres-migrate-poly` automatically. No manual SSH.

## Adding a whole new dialect file

Only add a new file here when a genuinely new dialect or target DB is involved. Don't split by feature — co-locate related tables in one dialect file. Feature splitting happens at the Drizzle table level, not the file level.
