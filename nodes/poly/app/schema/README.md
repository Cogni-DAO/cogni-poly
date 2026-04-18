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

### The three-step incantation

Doltgres is wire-compatible with Postgres, so drizzle-kit works — but Dolt's DDL statements don't honor MySQL/autocommit, so the migrator must commit DDL explicitly. Every migration run looks like:

```sql
SET @@dolt_transaction_commit = 1;
-- drizzle-kit migrate (runs all pending migrations against knowledge_poly)
SELECT dolt_commit('-Am', 'migration: <version>');
```

1. `SET @@dolt_transaction_commit = 1` — auto-commits every SQL transaction as a Dolt commit. Covers inserts and non-DDL statements. See [Dolt system variables](https://docs.dolthub.com/sql-reference/version-control/dolt-system-variables).
2. drizzle-kit runs the migration SQL normally.
3. `SELECT dolt_commit('-Am', ...)` catches any `CREATE`/`ALTER` statements that ignored autocommit. See [dolt#4843](https://github.com/dolthub/dolt/issues/4843) for the DDL wrinkle.

The migrator compose service (`doltgres-migrate-poly`) wraps this so contributors never hand-type the three steps. The Dolt commit message convention is `migration: <drizzle-version>` so `SELECT * FROM dolt_log` makes the migration trail auditable.

### Dolt's guidance

Per [DoltHub's schema-migrations blog](https://www.dolthub.com/blog/2022-07-20-schema-migrations/), this is the recommended approach for single-branch Dolt databases. Multi-branch schema migrations are a separate concern and not applicable while knowledge_poly runs on `main` only.

## Adding a table

1. Define it in the appropriate dialect file (`knowledge.ts` for Doltgres, or create a sibling file for Postgres-side tables).
2. Run `pnpm --filter @cogni/poly-app db:generate:doltgres` (or the Postgres equivalent) to generate the migration SQL.
3. Commit both the TS schema change and the generated migration in the same PR.
4. Deploy-infra runs `doltgres-migrate-poly` automatically. No manual SSH.

## Adding a whole new dialect file

Only add a new file here when a genuinely new dialect or target DB is involved. Don't split by feature — co-locate related tables in one dialect file. Feature splitting happens at the Drizzle table level, not the file level.
