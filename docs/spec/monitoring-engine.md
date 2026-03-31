---
id: monitoring-engine-spec
type: spec
title: Cogni Monitoring Engine
status: draft
spec_state: draft
trust: draft
summary: Generic data-stream monitoring backbone — ingest, snapshot, trigger, analyze (AI), score, act, measure, calibrate. Reusable across all Cogni node domains.
read_when: Building a new monitoring domain (prediction markets, infrastructure, analytics, social), or extending the trigger/analysis pipeline.
implements:
owner: derekg1729
created: 2026-03-30
verified:
tags: [monitoring, temporal, langgraph, data-streams, cogni-template]
---

# Cogni Monitoring Engine

> A reusable backbone for autonomous data-stream monitoring, AI-powered analysis, and action routing — shared by every Cogni node regardless of domain.

### Key References

|                  |                                                                              |                                    |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| **Temporal**     | [temporal-patterns](../../docs/spec/temporal-patterns.md) (cogni-template)   | Workflow/Activity/Graph boundaries |
| **Ingestion**    | `packages/ingestion-core/`                                                   | PollAdapter, WebhookNormalizer     |
| **First Domain** | [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) | Polymarket domain pack             |

## Design

```
Source → Normalize → Snapshot → Trigger → Enrich → Synthesize (AI) → Score → Act → Measure → Calibrate
   │         │           │          │         │           │             │       │        │          │
PollAdapter  pure fn    Activity  Workflow   Activity   LangGraph    Workflow Activity  Activity  Activity
(ingestion-  (domain    (DB       (pure fn,  (HTTP,     child (via   (pure    (domain  (domain   (DB
 core)        pack)     write)    replay-    cached)    Activity)     fn)      pack)    pack)    write)
                                  safe)
```

**Ownership boundary (per temporal-patterns-spec):**

- **Temporal** owns: all I/O (DB reads/writes, HTTP calls), orchestration, retries, idempotency
- **LangGraph** owns: LLM reasoning (thinking, evaluating, synthesizing)
- **Workflow code** owns: deterministic pure functions (trigger evaluation, scoring, focus policy)

## Goal

Provide a single, principled architecture for monitoring any data stream — so that adding a new domain (Grafana alerts, PostHog funnels, social signals, market prices) requires only writing domain-specific adapters, thresholds, prompts, and scoring functions. The engine handles scheduling, persistence, trigger evaluation, debounce, AI orchestration, action routing, and calibration.

## Non-Goals

- Order execution or trading (domain pack responsibility)
- User-facing dashboards (domain pack responsibility)
- Real-time WebSocket streaming (upgrade path, not MVP)
- Multi-tenant isolation (single-node MVP)

## Invariants

| Rule                     | Constraint                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PIPELINE_SHAPE           | Every monitoring domain follows: Source → Normalize → Snapshot → Trigger → Enrich → Synthesize → Score → Act → Measure → Calibrate                                                  |
| TEMPORAL_OWNS_IO         | All DB reads, DB writes, and HTTP calls happen inside Temporal Activities — never in Workflow code or LangGraph nodes                                                               |
| GRAPH_OWNS_THINKING      | LLM reasoning lives in a LangGraph graph invoked as a Temporal Activity child — the graph does zero I/O                                                                             |
| WORKFLOW_PURE_ONLY       | Workflow code contains only deterministic pure functions (trigger checks, scoring, focus policy) — replay-safe                                                                      |
| TRIGGERS_COMPETE         | All triggers across all domains enter a shared priority queue governed by `prioritizeTriggers()` with a configurable budget                                                         |
| DEBOUNCE_VIA_WORKFLOW_ID | Brain runs are debounced via Temporal workflowId idempotency (`{domain}-analysis:{timeBucket}`) — no advisory locks                                                                 |
| SIGNALS_IDEMPOTENT       | Signal IDs are deterministic: `signal:{entityId}:{runId}` — Activities are safe to retry                                                                                            |
| ACTION_LEVELS            | Every signal declares one of: observe, alert, recommend, auto_act, escalate                                                                                                         |
| CALIBRATION_LOOP         | When an entity resolves, an Outcome record is written; a calibration job updates base rates                                                                                         |
| DOMAIN_PACK_PLUGGABLE    | A domain pack provides: adapters, normalizers, thresholds, enrichment sources, LLM prompt, scoring function, action routing, resolution logic. The engine provides everything else. |
| DB_SCHEMA_SELF_CONTAINED | `db-schema/monitor` does not import from `monitor-core` — adapter layer maps between DB rows and domain Zod types                                                                   |
| MONITOR_CORE_PURE        | `monitor-core` contains only Zod schemas and pure functions — zero I/O, zero side effects                                                                                           |

### Schema

**Package: `@cogni/db-schema/monitor`** — new subpath export, self-contained.

**Table:** `monitored_entities`

| Column       | Type        | Constraints            | Description                                                  |
| ------------ | ----------- | ---------------------- | ------------------------------------------------------------ |
| `id`         | text        | PK                     | `{domain}:{source}:{sourceId}`                               |
| `domain`     | text        | NOT NULL               | `prediction-market`, `infrastructure`, `analytics`, `social` |
| `source`     | text        | NOT NULL               | `polymarket`, `grafana`, `posthog`, `twitter`                |
| `source_id`  | text        | NOT NULL               | Platform-specific ID                                         |
| `title`      | text        | NOT NULL               | Human-readable name                                          |
| `category`   | text        | NOT NULL               | Domain-specific category                                     |
| `attributes` | jsonb       | NOT NULL               | Domain-specific structured data                              |
| `active`     | boolean     | NOT NULL, default true | Whether currently monitored                                  |
| `created_at` | timestamptz | NOT NULL               |                                                              |
| `updated_at` | timestamptz | NOT NULL               |                                                              |

Indexes: `(domain, source)`, `category`, `active`, unique `(domain, source, source_id)`. RLS enabled.

**Table:** `entity_snapshots` (TimescaleDB hypertable on `snapshot_at`)

| Column        | Type        | Constraints             | Description                                         |
| ------------- | ----------- | ----------------------- | --------------------------------------------------- |
| `entity_id`   | text        | FK → monitored_entities |                                                     |
| `values`      | jsonb       | NOT NULL                | `Record<string, number>` — domain-specific numerics |
| `snapshot_at` | timestamptz | NOT NULL                | Observation time                                    |

Index: `(entity_id, snapshot_at)`.

**Table:** `analysis_runs`

| Column              | Type        | Constraints         | Description                        |
| ------------------- | ----------- | ------------------- | ---------------------------------- |
| `id`                | text        | PK                  | Temporal workflowId                |
| `domain`            | text        | NOT NULL            |                                    |
| `trigger_type`      | text        | NOT NULL            | Domain-defined trigger type        |
| `trigger_detail`    | text        |                     | Human-readable trigger context     |
| `entities_scanned`  | integer     | NOT NULL, default 0 |                                    |
| `signals_generated` | integer     | NOT NULL, default 0 |                                    |
| `status`            | text        | NOT NULL            | `running` / `completed` / `failed` |
| `error_message`     | text        |                     |                                    |
| `started_at`        | timestamptz | NOT NULL            |                                    |
| `completed_at`      | timestamptz |                     |                                    |

Indexes: `domain`, `status`, `started_at`. RLS enabled.

**Table:** `signals`

| Column           | Type        | Constraints             | Description                               |
| ---------------- | ----------- | ----------------------- | ----------------------------------------- |
| `id`             | text        | PK                      | `signal:{entityId}:{runId}`               |
| `entity_id`      | text        | FK → monitored_entities |                                           |
| `run_id`         | text        | FK → analysis_runs      |                                           |
| `domain`         | text        | NOT NULL                |                                           |
| `source`         | text        | NOT NULL                |                                           |
| `category`       | text        | NOT NULL                |                                           |
| `finding`        | text        | NOT NULL                | What was found                            |
| `thesis`         | text        | NOT NULL                | LLM reasoning                             |
| `confidence_pct` | integer     | NOT NULL                | 0–100                                     |
| `action_level`   | text        | NOT NULL                | observe/alert/recommend/auto_act/escalate |
| `payload`        | jsonb       | NOT NULL                | Domain-specific structured data           |
| `sources`        | jsonb       | NOT NULL                | Evidence references                       |
| `created_at`     | timestamptz | NOT NULL                |                                           |

Indexes: `entity_id`, `run_id`, `domain`, `created_at`, `action_level`. RLS enabled.

**Table:** `base_rates`

| Column                 | Type         | Constraints | Description                        |
| ---------------------- | ------------ | ----------- | ---------------------------------- |
| `category_key`         | text         | PK          | `{domain}:{category}:{event_type}` |
| `domain`               | text         | NOT NULL    |                                    |
| `description`          | text         | NOT NULL    |                                    |
| `historical_frequency` | numeric(6,4) | NOT NULL    | 0.0000–1.0000                      |
| `sample_size`          | integer      | NOT NULL    |                                    |
| `source`               | text         | NOT NULL    |                                    |
| `updated_at`           | timestamptz  | NOT NULL    |                                    |

Index: `domain`.

**Table:** `outcomes`

| Column        | Type        | Constraints                     | Description            |
| ------------- | ----------- | ------------------------------- | ---------------------- |
| `id`          | text        | PK                              |                        |
| `entity_id`   | text        | FK → monitored_entities, UNIQUE | One outcome per entity |
| `resolution`  | text        | NOT NULL                        | What happened          |
| `correct`     | boolean     |                                 | null until evaluated   |
| `resolved_at` | timestamptz | NOT NULL                        |                        |
| `created_at`  | timestamptz | NOT NULL                        |                        |

Index: `entity_id` (unique).

### Package: `@cogni/monitor-core` — pure domain types

```typescript
// Schemas (Zod)
MonitoredEntitySchema    // Generic thing being watched
SignalSchema             // Analysis output with action level
TriggerCheckSchema       // Threshold-fired trigger with priority
AnalysisRunSchema        // Run execution record
OutcomeSchema            // Ground truth for calibration
ActionLevelSchema        // observe | alert | recommend | auto_act | escalate

// Pure functions
prioritizeTriggers(triggers, budget, activeRuns) → TriggerCheck[]
lookupBaseRate(categoryKey, rates[]) → BaseRate | null
```

### Generic Temporal Workflows

**`DataStreamWorkflow`** — Scheduled, runs continuously.

```
loop:
  Activity: poll source → upsert entities
  Activity: snapshot values → append to entity_snapshots
  Workflow: evaluate triggers (pure functions from domain pack)
  if triggers fired:
    prioritize via focus policy
    startChild(AnalysisRunWorkflow, { workflowId: `{domain}-analysis:{5minBucket}` })
```

**`AnalysisRunWorkflow`** — Triggered by DataStreamWorkflow or scheduled fallback.

```
Activity: createRunRecord()
Activity: loadContext()          ← DB read
Activity: enrich()              ← HTTP (news, expert forecasts, etc.)
Activity: synthesize()          ← LangGraph child (LLM reasoning)
Workflow: score (pure function) ← deterministic, replay-safe
Activity: persist()             ← DB write (idempotent)
```

Both workflows are configured via a domain-specific config object (activity names, pure functions, intervals, budget).

### File Pointers

| File                                                        | Purpose                                 |
| ----------------------------------------------------------- | --------------------------------------- |
| `packages/monitor-core/src/index.ts`                        | Barrel export: schemas + pure functions |
| `packages/monitor-core/src/schemas/`                        | Zod schemas for all generic types       |
| `packages/monitor-core/src/focus.ts`                        | `prioritizeTriggers()` focus policy     |
| `packages/db-schema/src/monitor.ts`                         | Drizzle table definitions               |
| `packages/temporal-workflows/src/workflows/data-stream.ts`  | Generic data stream workflow            |
| `packages/temporal-workflows/src/workflows/analysis-run.ts` | Generic analysis run workflow           |

### TimescaleDB

`entity_snapshots` uses a TimescaleDB hypertable on `snapshot_at`.

- Docker image: `timescale/timescaledb:latest-pg16`
- Migration: `CREATE EXTENSION IF NOT EXISTS timescaledb;` then `SELECT create_hypertable('entity_snapshots', 'snapshot_at');`
- Fallback: without TimescaleDB, the table works as a normal table with a composite index — slower at scale but functional for dev.

## Open Questions

- [ ] Should `prioritizeTriggers` be configurable per-domain or global? Current design is global with domain-defined priority scores.
- [ ] What is the right default budget? (maxConcurrentRuns, maxLlmCallsPerHour)
- [ ] Should `auto_act` require a governance approval step before execution?
- [ ] How should cross-domain triggers work? (e.g., a Grafana alert triggers analysis on related prediction markets)

## Related

- [Architecture](./architecture.md) — hexagonal layering
- [Temporal Patterns](temporal-patterns-spec in cogni-template) — Workflow/Activity/Graph boundaries
- [Ingestion Core](../../packages/ingestion-core/AGENTS.md) — PollAdapter interface
- [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) — Polymarket domain pack (first implementation)
