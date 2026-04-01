---
id: task.0231
type: task
title: "Knowledge Data Plane — Port, Schema, Drizzle Adapter, Poly Seeds"
status: needs_implement
priority: 2
rank: 1
estimate: 3
summary: "Scaffold packages/knowledge-store with KnowledgeStorePort, Drizzle-backed knowledge tables in db-schema/knowledge, and seed data for the first Polymarket strategy and prompt. Unblocks task.0227's poly-synth graph."
outcome: "Analysis graphs read strategy + prompt content from a typed port instead of hardcoded strings. Knowledge tables exist in Postgres. Poly strategy seed data is queryable. Port abstraction enables future Dolt migration without consumer changes."
spec_refs:
  - knowledge-data-plane-spec
  - monitoring-engine-spec
assignees: derekg1729
project: proj.poly-prediction-bot
branch: feat/knowledge-data-plane
created: 2026-03-31
updated: 2026-03-31
---

# Knowledge Data Plane — Port, Schema, Drizzle Adapter, Poly Seeds

> Spec: [knowledge-data-plane](../../docs/spec/knowledge-data-plane.md) | Project: [proj.poly-prediction-bot](../projects/proj.poly-prediction-bot.md)

## Context

The monitoring-engine spec defines an **awareness plane** (Postgres): observations, triggers, signals, outcomes — what the AI sees and decides right now.

The knowledge-data-plane spec defines a **knowledge plane**: strategies, prompts, evaluations, evidence, playbooks, claims — what the AI has learned over time.

Task.0227's `poly-synth` analysis graph needs to read strategy content and system prompts. Currently these would be hardcoded. This task gives them a proper home behind a typed port.

### Relationship to prior knowledge-store work

Branch `docs/spike-0137-knowledge-store` designed a Postgres-based knowledge store (entities, relations, observations). This task uses the same Postgres approach but with a **simpler schema** focused on strategy/prompt versioning (the immediate need), not entity resolution. The spec targets Dolt as the v1 backend — the port abstraction makes that a transparent adapter swap.

---

## Design

### Outcome

Analysis graphs read strategy and prompt content from `KnowledgeStorePort` instead of hardcoded strings. Knowledge accumulates in typed, versioned tables.

### Approach

**Solution**: Postgres knowledge tables behind a port abstraction, following existing Drizzle + db-schema patterns. One new capability package (`packages/knowledge-store/`), one new db-schema slice (`packages/db-schema/knowledge/`).

**Reuses**:

- Existing Postgres infrastructure (zero new services)
- Existing Drizzle ORM + migration tooling
- Existing `@cogni/db-client` factory pattern
- Existing `@cogni/db-schema` slice pattern (same as attribution)
- Existing testcontainer setup for Postgres
- Existing capability package shape (port + domain + adapters)

**Rejected**:

- **Dolt from day 1** — adds second database engine (MySQL-compatible), second driver (mysql2), raw SQL migrations (no Drizzle), new testcontainer setup, new docker-compose service. None of these exist in the codebase today. The unique Dolt features (branching, fork inheritance, cross-node sharing) aren't exercised until Walk phase. Port abstraction means we can swap to Dolt later without changing consumers. (**REJECT_COMPLEXITY**)
- **Knowledge tables in `db-schema/ingestion`** — knowledge is a different concern from awareness data. Wrong slice boundary.
- **No knowledge store / hardcoded strategies** — creates tech debt in task.0227. Every domain pack would hardcode its own strategy+prompt content with no versioning.
- **Full entity/relation/observation model (proj.knowledge-store)** — over-engineered for the immediate need. Strategy + prompt versioning is the 80/20. Entity resolution and claims layer are Walk concerns.

### Invariants

<!-- CODE REVIEW CRITERIA -->

- [ ] AWARENESS_HOT_KNOWLEDGE_COLD: Knowledge tables are separate from awareness tables (spec: knowledge-data-plane)
- [ ] PORT_BEFORE_BACKEND: All access via `KnowledgeStorePort`, not direct Drizzle queries (spec: knowledge-data-plane)
- [ ] SCHEMA_GENERIC_CONTENT_SPECIFIC: Domain specificity in `domain` column + `params` JSONB, not table structure (spec: knowledge-data-plane)
- [ ] NO_PACKAGES_TO_SRC: Package cannot import from `src/**` (spec: architecture)
- [ ] PACKAGES_BUILD_BEFORE_APP: Package builds before Next.js app (spec: build-architecture)
- [ ] SIMPLE_SOLUTION: Leverages existing Postgres/Drizzle/db-client patterns — zero new infrastructure
- [ ] ARCHITECTURE_ALIGNMENT: Capability package shape (port + domain + adapters) per existing packages

### Files

**Create:**

- `packages/db-schema/src/knowledge.ts` — Drizzle table definitions (flat file, matches existing pattern: `attribution.ts`, `billing.ts`, etc.). Tables: `strategies`, `strategyVersions`, `strategyEvaluations`, `promptDefs`, `promptVersions`. (`playbooks`, `evidenceRefs`, `knowledgeClaims` deferred — no producer/consumer in Crawl)
- `packages/knowledge-store/src/port/knowledge-store.port.ts` — `KnowledgeStorePort` interface
- `packages/knowledge-store/src/domain/schemas.ts` — Zod schemas for knowledge types
- `packages/knowledge-store/src/adapters/drizzle.adapter.ts` — `DrizzleKnowledgeStoreAdapter`
- `packages/knowledge-store/src/index.ts` — barrel export (port + domain)
- `packages/knowledge-store/package.json`, `tsconfig.json`, `tsup.config.ts`
- `packages/knowledge-store/AGENTS.md`
- `packages/knowledge-store/tests/` — unit tests (schemas), contract tests (adapter vs Postgres)

**Modify:**

- `packages/db-schema/src/index.ts` — add knowledge slice re-export
- `packages/db-schema/package.json` — add `@cogni/db-schema/knowledge` subpath export
- `package.json` (root) — add `@cogni/knowledge-store` workspace dependency
- `tsconfig.json` (root) — add reference
- Drizzle migration — new tables

**Seed:**

- Initial `prediction-market` strategy ("Calibrated Market Analyst")
- Initial `poly-synth-prompt` prompt definition + v1 with system prompt text

---

## Deliverables

### P0 — Schema + Package Scaffold (1.5 days)

| #   | Deliverable          | Description                                                                                                                                                            |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Drizzle schema       | `packages/db-schema/src/knowledge.ts` — 5 tables (strategies, strategyVersions, strategyEvaluations, promptDefs, promptVersions). Flat file matching existing pattern. |
| 2   | Subpath export       | `@cogni/db-schema/knowledge` subpath in package.json exports                                                                                                           |
| 3   | Migration            | `pnpm db:generate` + `pnpm db:migrate` for new tables                                                                                                                  |
| 4   | Package scaffold     | `packages/knowledge-store/` — package.json, tsconfig, tsup, AGENTS.md                                                                                                  |
| 5   | Domain types + Zod   | Strategy, StrategyVersion, PromptDef, PromptVersion, StrategyEvaluation schemas                                                                                        |
| 6   | `KnowledgeStorePort` | Read + write interface per spec                                                                                                                                        |
| 7   | Root config          | Add workspace dep, tsconfig reference, biome override                                                                                                                  |

### P1 — Adapter + Tests (1 day)

| #   | Deliverable                    | Description                                                                                   |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| 8   | `DrizzleKnowledgeStoreAdapter` | Implements `KnowledgeStorePort` using `@cogni/db-client`. Reads + writes all knowledge types. |
| 9   | Unit tests                     | Schema validation (pure Zod), ID format tests                                                 |
| 10  | Contract tests                 | Adapter against real Postgres (testcontainer or dev-stack)                                    |

### P2 — Seed Data (0.5 day)

| #   | Deliverable        | Description                                                         |
| --- | ------------------ | ------------------------------------------------------------------- |
| 11  | Poly strategy seed | "Calibrated Market Analyst" strategy + v1 version with params       |
| 12  | Poly prompt seed   | `poly-synth-prompt` definition + v1 with initial system prompt text |

## Acceptance Criteria

- [ ] `pnpm check` passes (lint + type + format)
- [ ] `pnpm packages:build` builds knowledge-store successfully
- [ ] `pnpm test` — schema validation unit tests pass
- [ ] `pnpm test:component` — contract tests pass against Postgres
- [ ] Can read seed strategy + prompt via `KnowledgeStorePort`
- [ ] Can write a new strategy version via port
- [ ] AGENTS.md documented for new package
- [ ] Drizzle migration applies cleanly

## Validation

```bash
pnpm check                    # lint + type + format
pnpm packages:build           # builds knowledge-store
pnpm test                     # unit tests (Zod schemas)
pnpm test:component           # contract tests (vs Postgres testcontainer)
pnpm dev:stack                # tables exist, seeds queryable
```

## Out of Scope

- Dolt infrastructure (v1, separate task when branching/forking needed)
- Full awareness pipeline (task.0227)
- Automatic promotion gate (manual promotion only)
- pgvector / semantic search
- Multi-node knowledge sharing
- UI for knowledge browsing
- `analysis_runs.knowledge_version` column (added when task.0227 wires analysis runs)
