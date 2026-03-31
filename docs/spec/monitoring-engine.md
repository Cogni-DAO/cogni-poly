---
id: monitoring-engine-spec
type: spec
title: Cogni Monitoring Engine
status: draft
spec_state: draft
trust: draft
summary: Extends ingestion-core with continuous observations, adds a thin AI decision plane (trigger → analysis → signal → action → outcome) on top of the existing append-only event pipeline.
read_when: Building a new monitoring domain (prediction markets, infrastructure, analytics, social), or extending the trigger/analysis pipeline.
implements:
owner: derekg1729
created: 2026-03-30
verified:
tags: [monitoring, temporal, langgraph, data-streams, cogni-template]
---

# Cogni Monitoring Engine

> A thin AI decision plane on top of the existing ingestion pipeline — not a new substrate.

### Key References

|                    |                                                                              |                                            |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| **Ingestion Core** | [ingestion-core](../../packages/ingestion-core/AGENTS.md)                    | PollAdapter, ActivityEvent, cursor model   |
| **Attribution**    | [attribution-ledger](../../packages/attribution-ledger/AGENTS.md)            | Epoch lifecycle consuming ingestion events |
| **Temporal**       | [temporal-patterns](temporal-patterns-spec in cogni-template)                | Workflow/Activity/Graph boundaries         |
| **First Domain**   | [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) | Polymarket domain pack                     |

## Design

### What Already Exists

`ingestion-core` provides a purpose-neutral event pipeline:

```
Source → PollAdapter.collect() → ActivityEvent[] → ingestion_receipts (append-only)
                                                 → ingestion_cursors  (incremental state)
```

`attribution-ledger` consumes receipts: receipts → epoch selection → allocation → statement.

This is the canonical substrate. **We do not replace it.**

### What's Missing

`ActivityEvent` models discrete human activities (PRs, reviews, messages) with `platformUserId` and `artifactUrl`. Continuous state observations of external systems (market prices, Grafana metrics, PostHog funnels) need a sibling model — same ingestion pattern, different shape.

And: no existing system decides **"should we spend AI tokens analyzing this?"** or **"what action should we take?"**

### The Extension

```
                     ┌─── ActivityEvent ──→ ingestion_receipts ──→ attribution pipeline
                     │    (discrete human activities)
PollAdapter.collect()┤
                     │
                     └─── ObservationEvent ──→ observation_events (append-only, new)
                          (continuous state)         │
                                                     ├──→ entity_state (derived: latest per entity)
                                                     ├──→ feature_windows (derived: rolling aggregates)
                                                     │
                                              ┌──────┘
                                              │
                              Cheap triggers (pure functions on derived state)
                                              │
                                    Budget gate (prioritize, cap LLM spend)
                                              │
                              Analysis case (Temporal workflow + LangGraph child)
                                              │
                                   Signal → Action → Outcome → Calibrate
```

**The adapter decides which type to produce.** A GitHub adapter produces `ActivityEvent[]` (human work → attribution-eligible). A Polymarket adapter produces `ObservationEvent[]` (market state → monitoring only). A social media adapter could produce both — a post is an `ActivityEvent` (someone did something) and its engagement metrics are `ObservationEvent[]`.

## Goal

Enable Cogni nodes to autonomously monitor any data stream — prediction markets, infrastructure, analytics, social — using the same ingestion infrastructure that already exists for attribution, with a thin AI decision layer that controls when to spend tokens and what actions to take.

## Non-Goals

- Replacing `ingestion-core` or `attribution-ledger` — we extend, not fork
- Real-time WebSocket streaming (upgrade path, not MVP)
- Multi-tenant isolation (single-node MVP)
- Building a bespoke "monitoring engine" substrate — this is a decision plane on an existing pipeline

## Invariants

| Rule                       | Constraint                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SINGLE_INGESTION_SUBSTRATE | Both `ActivityEvent` and `ObservationEvent` flow through `ingestion-core` PollAdapter. No parallel ingestion system.                                                       |
| OBSERVATION_APPEND_ONLY    | `observation_events` is append-only (like `ingestion_receipts`). DB trigger rejects UPDATE/DELETE.                                                                         |
| OBSERVATION_IDEMPOTENT     | Observation IDs are deterministic: `buildEventId(source, "obs", entityId, snapshotTimestamp)`. Same pattern as ActivityEvent.                                              |
| OBSERVATION_PROVENANCE     | `payloadHash` required on every observation (same as ActivityEvent).                                                                                                       |
| STATE_IS_DERIVED           | `entity_state` is materialized from latest observation per entity — not a separate source of truth.                                                                        |
| FEATURES_ARE_DERIVED       | Rolling aggregates (change_24h, volume_avg, spread_history) are Timescale continuous aggregates or SQL views on `observation_events` — not maintained by application code. |
| CHEAP_BEFORE_EXPENSIVE     | Triggers are deterministic pure functions on derived state. The LLM never sees raw firehose traffic. ~95% of observations should be filtered before any AI call.           |
| BUDGET_GATE                | A `prioritizeTriggers(triggers, budget, activeRuns)` function caps concurrent analysis runs and LLM calls/hour.                                                            |
| TEMPORAL_OWNS_IO           | All DB reads/writes, HTTP calls happen in Temporal Activities (per temporal-patterns-spec).                                                                                |
| GRAPH_OWNS_THINKING        | LLM reasoning lives in a LangGraph graph invoked as a Temporal Activity child — the graph does zero I/O.                                                                   |
| WORKFLOW_PURE_ONLY         | Trigger evaluation and scoring in Workflow code — deterministic, replay-safe.                                                                                              |
| SIGNALS_IDEMPOTENT         | Signal IDs are deterministic: `signal:{entityId}:{runId}`.                                                                                                                 |
| ACTION_LEVELS              | Every signal declares one of: `observe`, `alert`, `recommend`, `auto_act`, `escalate`.                                                                                     |
| CALIBRATION_LOOP           | When an entity resolves, an outcome record is written; a calibration job updates base rates.                                                                               |
| NOT_ALL_STREAMS_ATTRIBUTE  | ObservationEvents do NOT enter the attribution pipeline. Only ActivityEvents become ingestion_receipts → epoch selection → allocation.                                     |
| SOME_STREAMS_DO_BOTH       | An adapter MAY produce both ActivityEvents (→ attribution) and ObservationEvents (→ monitoring) from the same source. The adapter decides.                                 |

## Schema

### Extension to `@cogni/ingestion-core`

New model type alongside `ActivityEvent`:

```typescript
/** Continuous state observation of an external system — not a human activity */
export interface ObservationEvent {
  /** Deterministic: buildEventId(source, "obs", entityId, timestamp) */
  readonly id: string;
  readonly source: string; // "polymarket", "grafana", "posthog"
  readonly entityId: string; // What's being observed: "polymarket:market:abc123"
  readonly entityTitle: string; // Human-readable: "Fed cuts rates at June meeting?"
  readonly category: string; // Domain-specific: "economics", "api-latency", "funnel"
  /** Numeric values — domain-specific, flexible */
  readonly values: Record<string, number>; // { probabilityBps: 6200, spreadBps: 100, volumeUsd: 42000 }
  /** Non-numeric metadata */
  readonly metadata: Record<string, unknown>;
  readonly payloadHash: string; // SHA-256 (same as ActivityEvent)
  readonly observedAt: Date; // When observation was taken
}
```

Same `PollAdapter` port, same `CollectResult` pattern. The adapter's `collect()` returns `ObservationEvent[]` instead of (or alongside) `ActivityEvent[]`. The `CollectResult` type broadens:

```typescript
export interface CollectResult {
  events: readonly ActivityEvent[];
  observations?: readonly ObservationEvent[]; // NEW — optional
  nextCursor: StreamCursor;
}
```

### New table: `observation_events` (in `@cogni/db-schema/attribution` or new slice)

```typescript
export const observationEvents = pgTable(
  "observation_events",
  {
    /** Deterministic: "{source}:obs:{entityId}:{timestamp}" */
    id: text("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    source: text("source").notNull(),
    entityId: text("entity_id").notNull(),
    entityTitle: text("entity_title").notNull(),
    category: text("category").notNull(),
    /** Domain-specific numeric values */
    values: jsonb("values").$type<Record<string, number>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    payloadHash: text("payload_hash").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("obs_events_entity_time_idx").on(t.entityId, t.observedAt),
    index("obs_events_source_idx").on(t.source),
    index("obs_events_category_idx").on(t.category),
    index("obs_events_node_time_idx").on(t.nodeId, t.observedAt),
  ]
);
// TimescaleDB: SELECT create_hypertable('observation_events', 'observed_at');
```

Append-only. Same pattern as `ingestion_receipts`.

### Derived state (views or Timescale continuous aggregates)

**`entity_state`** — latest observation per entity:

```sql
-- Materialized view, refreshed on insert trigger or periodic
CREATE MATERIALIZED VIEW entity_state AS
SELECT DISTINCT ON (entity_id)
  entity_id, entity_title, source, category, values, observed_at
FROM observation_events
ORDER BY entity_id, observed_at DESC;
```

**`feature_windows`** — rolling aggregates:

```sql
-- Timescale continuous aggregate (auto-refreshed)
CREATE MATERIALIZED VIEW feature_windows_1h
WITH (timescaledb.continuous) AS
SELECT
  entity_id,
  time_bucket('1 hour', observed_at) AS bucket,
  first(values->>'probabilityBps', observed_at)::int AS open_bps,
  last(values->>'probabilityBps', observed_at)::int AS close_bps,
  max((values->>'probabilityBps')::int) AS high_bps,
  min((values->>'probabilityBps')::int) AS low_bps,
  count(*) AS sample_count
FROM observation_events
GROUP BY entity_id, time_bucket('1 hour', observed_at);
```

These are domain-specific — the Polymarket pack defines its own continuous aggregates. The engine just provides the pattern.

### Analysis pipeline tables (thin, generic)

```typescript
/** Analysis run ledger — tracks when and why AI was invoked */
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(), // Temporal workflowId
    nodeId: uuid("node_id").notNull(),
    domain: text("domain").notNull(), // "prediction-market", "infrastructure"
    triggerType: text("trigger_type").notNull(),
    triggerDetail: text("trigger_detail"),
    entitiesAnalyzed: integer("entities_analyzed").notNull().default(0),
    signalsGenerated: integer("signals_generated").notNull().default(0),
    status: text("status", {
      enum: ["running", "completed", "failed"],
    }).notNull(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("analysis_runs_domain_idx").on(t.domain),
    index("analysis_runs_started_idx").on(t.startedAt),
  ]
).enableRLS();

/** Signals emitted by analysis — the AI's conclusions */
export const analysisSignals = pgTable(
  "analysis_signals",
  {
    id: text("id").primaryKey(), // "signal:{entityId}:{runId}"
    nodeId: uuid("node_id").notNull(),
    entityId: text("entity_id").notNull(),
    runId: text("run_id")
      .references(() => analysisRuns.id)
      .notNull(),
    domain: text("domain").notNull(),
    finding: text("finding").notNull(),
    thesis: text("thesis").notNull(),
    confidencePct: integer("confidence_pct").notNull(),
    actionLevel: text("action_level", {
      enum: ["observe", "alert", "recommend", "auto_act", "escalate"],
    }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sources: jsonb("sources").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("signals_entity_idx").on(t.entityId),
    index("signals_run_idx").on(t.runId),
    index("signals_created_idx").on(t.createdAt),
  ]
).enableRLS();

/** Outcomes for calibration — ground truth when entities resolve */
export const analysisOutcomes = pgTable(
  "analysis_outcomes",
  {
    id: text("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    entityId: text("entity_id").notNull(),
    resolution: text("resolution").notNull(),
    correct: boolean("correct"), // null until evaluated against signals
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("outcomes_entity_idx").on(t.entityId)]
).enableRLS();

/** Base rates for calibration — historical frequencies by category */
export const baseRates = pgTable(
  "base_rates",
  {
    categoryKey: text("category_key").primaryKey(),
    domain: text("domain").notNull(),
    description: text("description").notNull(),
    historicalFrequency: numeric("historical_frequency", {
      precision: 6,
      scale: 4,
    }).notNull(),
    sampleSize: integer("sample_size").notNull(),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("base_rates_domain_idx").on(t.domain)]
);
```

### Temporal Workflow Patterns

**Observation Ingestion** — extends existing `CollectSourceStreamWorkflow` pattern:

```typescript
// Same as existing attribution collection, but writes to observation_events
export async function CollectObservationsWorkflow(
  source: string,
  streamId: string
) {
  const cursor = await loadCursorActivity(source, streamId);
  const { observations, nextCursor } = await collectObservationsActivity(
    source,
    streamId,
    cursor
  );
  await insertObservationsActivity(observations); // → observation_events
  await saveCursorActivity(source, streamId, nextCursor);
  // Evaluate triggers in next workflow (separation of concerns)
}
```

**Trigger Evaluation** — scheduled, reads derived state:

```typescript
export async function EvaluateTriggersWorkflow(domain: string) {
  const state = await loadEntityStateActivity(domain); // Read entity_state + feature_windows
  const triggers = evaluateTriggers(state); // Pure function (in Workflow code)
  const prioritized = prioritizeTriggers(triggers, budget, activeRuns); // Pure function
  for (const trigger of prioritized) {
    await startChild(AnalysisRunWorkflow, {
      workflowId: `${domain}-analysis:${timeBucket5min}`, // Idempotent debounce
      args: [{ trigger }],
    });
  }
}
```

**Analysis Run** — per temporal-patterns-spec normative pattern:

```typescript
export async function AnalysisRunWorkflow(input: { trigger: TriggerCheck }) {
  const runId = workflow.workflowInfo().workflowId;
  await createRunRecord(runId, input.trigger); // Activity: DB write
  const context = await loadContext(input.trigger); // Activity: DB read
  const refs = await enrichContext(context); // Activity: HTTP (cached)
  const assessments = await synthesize(context, refs); // Activity: LangGraph child
  const signals = scoreAssessments(assessments, context); // Workflow: pure function
  await persistSignals(runId, signals); // Activity: DB write (idempotent)
}
```

### Where Domain Packs Plug In

| Slot                      | What the domain provides                    | Example (Polymarket)                       |
| ------------------------- | ------------------------------------------- | ------------------------------------------ |
| `PollAdapter`             | Source-specific HTTP client + normalization | Gamma API + CLOB polling                   |
| `ObservationEvent.values` | Domain-specific numeric fields              | `{ probabilityBps, spreadBps, volumeUsd }` |
| Continuous aggregates     | Domain-specific rolling features            | 1h OHLC, 24h change, volume avg            |
| `evaluateTriggers()`      | Pure function: state → TriggerCheck[]       | Price move >5%, volume spike >2x           |
| `enrichContext()`         | Activity: fetch external references         | GDELT news, Metaculus forecasts            |
| LangGraph prompt          | Domain-specific system prompt               | Calibrated market analyst                  |
| `scoreAssessments()`      | Pure function: assessments → signals        | Edge scoring with liquidity discount       |
| Action routing            | Domain-specific action logic                | observe/alert/recommend thresholds         |
| Resolution                | How entities resolve                        | Market settles → outcome recorded          |
| Base rate seeds           | Initial calibration data                    | Historical event frequencies               |

### File Pointers

| File                                         | Purpose                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/ingestion-core/src/model.ts`       | Add `ObservationEvent` alongside `ActivityEvent`                                             |
| `packages/ingestion-core/src/port.ts`        | Extend `CollectResult` with optional `observations`                                          |
| `packages/db-schema/src/monitoring.ts`       | `observation_events`, `analysis_runs`, `analysis_signals`, `analysis_outcomes`, `base_rates` |
| `packages/temporal-workflows/src/workflows/` | `CollectObservationsWorkflow`, `EvaluateTriggersWorkflow`, `AnalysisRunWorkflow`             |

### Redis Streams — Live UI Fan-Out

Postgres is the source of truth. Redis Streams provide live fan-out for the UI:

```
observation_events INSERT trigger → XADD to Redis Stream "obs:{domain}"
analysis_signals INSERT trigger → XADD to Redis Stream "signals:{domain}"
```

The SSE endpoint tails the Redis Stream for live updates, with a replay window from Postgres for page load. This reuses the existing Redis Streams → SSE pattern from `apps/web`.

Users see the same event stream the AI sees — observations flowing in, triggers firing, analysis running, signals emitted. Transparency is the product.

### TimescaleDB

`observation_events` uses a TimescaleDB hypertable on `observed_at`.

- Docker image: `timescale/timescaledb:latest-pg16`
- Migration: `CREATE EXTENSION IF NOT EXISTS timescaledb;`
- Fallback: without TimescaleDB, regular table with composite index — functional for dev

Continuous aggregates (domain-specific) auto-refresh incrementally.

## Open Questions

- [ ] Should `observation_events` live in `db-schema/attribution` (same slice as `ingestion_receipts`) or a new `db-schema/monitoring` slice? Leaning toward same slice — they're siblings.
- [ ] What is the right default budget? (maxConcurrentRuns, maxLlmCallsPerHour)
- [ ] Should `auto_act` require governance approval before execution?
- [ ] Exact shape of `CollectResult` extension — should adapters return a union type, or separate collect methods for events vs observations?

## Related

- [Architecture](./architecture.md) — hexagonal layering
- [Temporal Patterns](temporal-patterns-spec in cogni-template) — Workflow/Activity/Graph boundaries
- [Ingestion Core](../../packages/ingestion-core/AGENTS.md) — PollAdapter, ActivityEvent
- [Attribution Ledger](../../packages/attribution-ledger/AGENTS.md) — Epoch lifecycle
- [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) — Polymarket domain pack
