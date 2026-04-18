---
id: task.0311
type: task
title: "Poly Knowledge Plane v0 — Protocol-Fact Seeds + Upsert Bug Fix"
status: done
priority: 1
rank: 2
estimate: 1
summary: "Ship the poly knowledge store as an empty-by-design plane: 3 protocol-fact seeds only (CLOB mechanics, Kelly reference, HF dataset pointers). Fix upsertKnowledge() adapter bug where EXCLUDED references fail on Doltgres. Add root workspace deps so the seed script resolves node-level knowledge packages."
outcome: "knowledge_poly is ready for the brain to fill. The store contains only externally-verifiable protocol facts; strategy, edges, and observations are the brain's job to research, validate, and promote through its own confidence gate."
spec_refs:
  - knowledge-data-plane-spec
  - knowledge-syntropy
  - multi-node-tenancy
  - databases
assignees: derekg1729
project: proj.poly-prediction-bot
created: 2026-04-15
updated: 2026-04-17
labels: [poly, knowledge, doltgres, syntropy, seed]
---

# Poly Knowledge Plane v0 — Protocol-Fact Seeds + Upsert Bug Fix

> Spec: [knowledge-syntropy](../../docs/spec/knowledge-syntropy.md) · [knowledge-data-plane](../../docs/spec/knowledge-data-plane.md)
> Project: [proj.poly-prediction-bot](../projects/proj.poly-prediction-bot.md)
> Follows: task.0231 (done) · PR #887 (poly-brain LangGraph catalog registration, merged)

## Context

Task.0231 shipped the Doltgres knowledge plane: `knowledge_poly` database, `KnowledgeStorePort`, `DoltgresKnowledgeStoreAdapter`, and `core__knowledge_search/read/write` wired into poly-brain. The `@cogni/poly-knowledge` package existed but contained only 3 placeholder seeds about system architecture.

An earlier iteration of this task (reverted) attempted to seed the store with 13 Polymarket "strategy" entries sourced from Medium content-marketing posts. That approach was rejected: seeding a knowledge store with AI-authored strategy prose pollutes retrieval (every search returns plausible-sounding noise the brain will cite as authoritative), and "how to trade" is the brain's job to discover, not a human's job to pre-script. See the [v0-seeds decision note](#decision-seeds-stay-empty-ish) below.

## Design

### Outcome

`knowledge_poly` ships with 3 protocol-fact rows only — CLOB mechanics, Kelly formula reference, canonical HuggingFace dataset pointers. Everything else the brain will accumulate itself through its research + observation + promotion loop.

### Approach

Replace the 3 placeholder entries in `nodes/poly/packages/knowledge/src/seeds/poly.ts` with 3 protocol-fact entries. Fix the Doltgres upsert bug discovered while verifying the seed path. Register the node-level knowledge packages as root workspace deps so the seed script resolves them via dynamic `import()`.

**Reuses:**

- Existing `@cogni/poly-knowledge` package and `NewKnowledge` type
- Existing `scripts/db/seed-doltgres.mts`
- Existing `createKnowledgeCapability().write()` flow

### Per-Node DB Alignment (multi-node-tenancy.md)

Doltgres is deployed as a **single server on Compose, one database per node** — the exact same model the Postgres tier uses. This is a deliberate, evidence-backed commitment; it mirrors the invariants in [multi-node-tenancy.md](../../docs/spec/multi-node-tenancy.md) and closes off the "shared schema leak" class of bug at day-one.

| Invariant from `multi-node-tenancy.md`                             | How Doltgres satisfies it                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `DB_PER_NODE` — one DB per node on a shared server                 | `provision.sh` iterates `COGNI_NODE_DBS` and creates `knowledge_operator`, `knowledge_poly`, `knowledge_resy` |
| `DB_IS_BOUNDARY` — the DB is the node boundary, no tenancy columns | No `node_id` column on `knowledge`; DB name IS the node                                                       |
| `NO_CROSS_NODE_QUERIES`                                            | Each pod connects to its own knowledge DB via its own `DOLTGRES_URL_*`                                        |

**Commit-history isolation** (Doltgres-specific): each `CREATE DATABASE` in Doltgres creates an independent Dolt repo with its own `dolt_log`. Poly's AI-slop commits never appear in operator's timeline. `SELECT dolt_log FROM knowledge_poly` and `SELECT dolt_log FROM knowledge_operator` are physically different histories. This is intrinsic to Doltgres's "database = Dolt repo" model — not something we implement, just something we preserve by keeping one DB per node.

**Schema source-of-truth**: DDL lives in `infra/compose/runtime/doltgres-init/provision.sh` (lines 72–91), not drizzle-kit. Deliberate divergence from the Postgres tier because Doltgres's native migration model is SQL + `dolt_commit()`, and drizzle-kit's generated migrations would fight that (it would not call `dolt_commit` after each DDL change, breaking the audit trail). Schema changes land as new SQL blocks in `provision.sh` with their own `dolt_commit('-Am', 'schema: <change>')`. This is consistent with task.0322's direction (SQL-native migrations for stateful infra that ships its own history).

**Per-node env convention**: `nodes/poly/app/src/shared/env/server-env.ts` already reads `DOLTGRES_URL_POLY` (per-node, mirrors `DATABASE_URL_POLY`). Operator and resy currently read generic `DOLTGRES_URL` — minor inconsistency, filed as follow-up but not a blocker for candidate-a/poly-first.

**Connection string shape** (what deploy-infra.sh writes to the per-node k8s secret):

```
DOLTGRES_URL_POLY=postgresql://knowledge_writer:<pw>@poly-doltgres-external:5435/knowledge_poly
```

The DB name in the URL (`/knowledge_poly`) is what routes the connection to the right Dolt repo. No shared-DB fallback.

**What's NOT addressed here (future work, explicitly out of scope):**

- Per-node _schema_ divergence (poly's knowledge schema differing from operator's). Today every `knowledge_*` DB uses the same 10-column `knowledge` table baked into `provision.sh`. When poly needs prediction-market-specific columns/tables, that becomes a schema-split task — not this PR.
- TS schema definitions for node-local knowledge tables living under `nodes/<node>/app/schema/` (the Postgres path). Not applicable until Doltgres needs drizzle-kit-managed tables, which it doesn't today.
- Aligning `DOLTGRES_URL` → `DOLTGRES_URL_OPERATOR`/`DOLTGRES_URL_RESY` for consistency with poly.
- Backups (follow the Postgres WAL-G path from proj.database-ops once that lands).

### Decision: seeds stay (almost) empty

A knowledge store is worse than empty when seeded with narrative-grade content:

- Retrieval returns plausible-sounding prose, not reference facts — the brain cites it and compounds error.
- You lose the ability to distinguish curated seed rows from brain-authored rows once any brain writes land.
- "How to find edge in Polymarket" is the entire product; pre-canning it defeats the purpose.

Protocol facts are different: they're externally verifiable, authoritative, and describe the _substrate_ the brain reasons about, not its reasoning. Those are safe to seed.

Future slop-grade entries (e.g. exploratory research summaries the brain writes) belong in the 10–30% confidence band, not 60–70%. The seed rows here stay at `VERIFIED` because they really are verified — they're the only reason we can have confident rows at all.

### Changes

- **`nodes/poly/packages/knowledge/src/seeds/poly.ts`** — replaced 3 placeholder entries with 3 protocol-fact seeds: `pm:protocol:clob-mechanics`, `pm:protocol:kelly-formula`, `pm:protocol:hf-datasets`. All sourced to canonical URLs (polymarket.com docs, Wikipedia, HuggingFace).
- **`packages/knowledge-store/src/adapters/doltgres/index.ts`** — fixed `upsertKnowledge()` which used `ON CONFLICT ... EXCLUDED.col` references that Doltgres does not support. Replaced with try-INSERT / catch-duplicate / fallback-UPDATE pattern. Guard for deleted-between-insert-and-update race.
- **`package.json`** — added `@cogni/knowledge-store`, `@cogni/node-template-knowledge`, `@cogni/poly-knowledge` as root workspace deps so `scripts/db/seed-doltgres.mts` can resolve them via dynamic `import()`. Architectural stopgap: per-node knowledge packages shouldn't live as root deps forever. Retired when the seed script moves into the node-local surface.

### Invariants

<!-- CODE REVIEW CRITERIA -->

- [x] ENTRY_HAS_PROVENANCE: every seed has `sourceType: 'external'` and a non-null `sourceRef` URL (spec: knowledge-syntropy)
- [x] SCHEMA_GENERIC_CONTENT_SPECIFIC: poly-specific content lives in seed rows, not schema (spec: knowledge-data-plane)
- [x] PACKAGES_NO_ENV: knowledge-store adapter still takes `sql` via constructor, not `process.env` (spec: packages-architecture)
- [x] AUTO_COMMIT: every seed write creates a Dolt commit via `createKnowledgeCapability().write()` (spec: knowledge-data-plane)
- [x] UPSERT_DOLTGRES_COMPATIBLE: upsertKnowledge works on this Doltgres version
- [x] SEEDS_ARE_PROTOCOL_FACTS_ONLY: no strategy prose, no trading anti-patterns, no narrative content

## Acceptance Criteria

- [x] `pnpm packages:build` succeeds
- [x] `pnpm db:seed:doltgres:poly` writes 4 entries to `knowledge_poly` (1 base + 3 poly protocol facts)
- [x] Re-running the seed is idempotent (Dolt skips "nothing to commit")
- [x] `pnpm check:docs` passes
- [x] `pnpm format` clean

## Validation

```
✅ 4 entries seeded into knowledge_poly (1 base + 3 poly protocol facts)
✅ Idempotent re-run (Dolt skips "nothing to commit")
✅ All sourceRef URLs resolve (polymarket docs, Wikipedia, HuggingFace)
✅ pnpm packages:build — all packages compile
✅ pnpm check:docs — passes
```

## Out of Scope / Follow-ups

1. **Brain-authored knowledge loop** — `core__knowledge_write` + promotion gate so the brain can accumulate observations at low confidence (10–30%) and promote them as evidence accumulates. This is the whole point of the store — pre-canned content was the wrong approach.
2. **Storage-expert agent** — bridges awareness-plane `ObservationEvent` → promoted `knowledge` entries.
3. **DoltHub delivery path** (spike.0318 → task.0319) — replace the root-level seed script with `dolt_clone` from per-node DoltHub remotes. Retires the root-dep stopgap.
4. **Syntropy schema columns** (`entry_type`, `status`, `updated_at`) — when a concrete consumer needs them.
5. **Postgres search index** (embeddings + FTS) — when corpus grows past ~1K entries.

## Related

- [task.0231](./task.0231.knowledge-data-plane.md) — shipped the baseline this task seeds
- PR [#887](https://github.com/Cogni-DAO/cogni-template/pull/887) — poly-brain LangGraph catalog registration (merged)
- [spike.0318](./spike.0318.dolthub-knowledge-seeding-design.md) — DoltHub delivery design
- [task.0319](./task.0319.dolthub-seed-delivery.md) — DoltHub implementation
- [knowledge-syntropy spec](../../docs/spec/knowledge-syntropy.md)
