---
id: monitoring-engine-spec
type: spec
title: AI Awareness & Decision Plane
status: active
spec_state: proposed
trust: draft
summary: Extends ingestion-core with ObservationEvent for continuous data streams. Adds a thin AI decision layer — cheap triggers, budgeted analysis, scored signals, action routing, calibration — on top of the existing append-only ingestion spine.
read_when: Adding a new data source (prediction markets, infra metrics, analytics, social), extending the trigger/analysis pipeline, or understanding how Cogni agents become aware of the world.
implements:
owner: derekg1729
created: 2026-03-30
verified: 2026-03-31
tags: [awareness, temporal, langgraph, data-streams, cogni-template]
---

# AI Awareness & Decision Plane

> Own decisions, not telemetry. External backends keep raw data. We keep what the AI noticed, why it cared, and what it decided.

### Key References

|                    |                                                                              |                                          |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| **Ingestion Core** | [ingestion-core AGENTS.md](../../packages/ingestion-core/)                   | PollAdapter, ActivityEvent, cursor model |
| **Attribution**    | [attribution-ledger AGENTS.md](../../packages/attribution-ledger/)           | Epoch lifecycle consuming receipts       |
| **Temporal**       | temporal-patterns-spec (cogni-template)                                      | Workflow/Activity/Graph boundaries       |
| **First Domain**   | [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) | Polymarket domain pack                   |

## Goal

Enable Cogni nodes to autonomously monitor any data stream — prediction markets, infrastructure metrics, product analytics, social signals — by extending the existing ingestion pipeline with a thin AI decision layer. Adding a new domain requires only edge adapters, trigger functions, an LLM prompt, and scoring logic. The engine handles scheduling, persistence, debounce, budget control, and calibration.

## Design

The design has four parts: federated awareness (where data lives), single ingestion spine (how it enters), AI decision layers (how it's processed), and human visibility (what users see).

### Federated Awareness Model

```
┌──────────────────────────────────────────────────────────────────┐
│                    EXTERNAL BACKENDS (own raw telemetry)         │
│                                                                  │
│  Grafana/Mimir    PostHog       Polymarket API    Twitter/Reddit │
│  (metrics, logs)  (funnels,     (markets, prices) (posts, trends)│
│                    events)                                       │
└──────┬───────────────┬──────────────┬──────────────┬────────────┘
       │               │              │              │
       ▼               ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│              EDGE ADAPTERS (PollAdapter / WebhookNormalizer)     │
│              One per source. Thin. Fetch → normalize → emit.    │
│              Each adapter carries a source_ref: a pointer back   │
│              to the external system for deep investigation.      │
└──────────────────────────────┬───────────────────────────────────┘
                               │
          ┌────────────────────┴────────────────────┐
          ▼                                         ▼
   ActivityEvent                             ObservationEvent
   (a discrete event happened)               (a state measurement was taken)
          │                                         │
          ▼                                         ▼
   ingestion_receipts                        observation_events
   (existing, append-only)                   (new, append-only)
          │         │                               │
          │         └───────────────┐               │
          ▼                         ▼               ▼
   Attribution pipeline       AI Decision Plane (shared)
   (selection → epochs)       (triggers → analysis → signals)
```

**Principle:** External backends are the warehouse. We are the judgment layer. Store what the AI saw (compact snapshots), why it cared (triggers, analysis), what it concluded (signals), and how to drill back into the source (pointers). Do not mirror firehoses.

---

## Single Ingestion Spine

`ingestion-core` is already purpose-neutral. Both record types share:

- **PollAdapter** port — cursor-based incremental sync
- **ingestion_cursors** table — checkpoint state between polls
- **`buildEventId()`** — deterministic IDs from source data
- **`hashCanonicalPayload()`** — SHA-256 provenance on every record
- **StreamCursor / StreamDefinition** — same cursor model

Two physical tables because `ingestion_receipts` has `platform_user_id NOT NULL` and attribution-specific columns that don't apply to state measurements. Forcing them into one table would either break the attribution contract or require nullable columns that weaken it.

**This is one logical substrate, not two parallel systems.** The shared PollAdapter, cursor, ID, and hash machinery is what makes it one spine.

### Two sibling record types — same base, different shapes

The split is about the **kind of fact**, not the downstream use:

- **ActivityEvent** = a discrete event happened (with or without a human actor)
- **ObservationEvent** = a state measurement was taken at a point in time

> **Naming note:** `ActivityEvent` is the existing name in `ingestion-core`. A clearer name would be `DiscreteEvent` — it removes the "human activity → attribution" implication. This rename is a future migration; the spec uses the existing name but the concept is "discrete event," not "human activity."

Both share: `id`, `source`, `metadata`, `payloadHash`, timestamp. They diverge on what additional fields they carry:

|                        | ActivityEvent (existing) | ObservationEvent (new)                    |
| ---------------------- | ------------------------ | ----------------------------------------- |
| **Fact type**          | Something happened       | Something was measured                    |
| **Has human actor**    | Often (platformUserId)   | No                                        |
| **Has numeric values** | No                       | Yes (values: Record\<string, number\>)    |
| **Has artifact**       | Often (artifactUrl)      | No (but metadata carries source pointers) |
| **Has subject key**    | Implicit in id           | Explicit entityId                         |
| **Persists to**        | ingestion_receipts       | observation_events                        |

### Classification examples

| Raw fact                  | Type             | Why                                             |
| ------------------------- | ---------------- | ----------------------------------------------- |
| PR #42 merged by user123  | ActivityEvent    | Discrete event, has human actor                 |
| Deploy v1.2.3 started     | ActivityEvent    | Discrete event, has human actor                 |
| Grafana alert fired       | ActivityEvent    | Discrete event (no human actor, still an event) |
| Market resolved to YES    | ActivityEvent    | Discrete event                                  |
| PostHog `capture()` event | ActivityEvent    | Discrete user action                            |
| CPU = 92% at 12:00:00     | ObservationEvent | State measurement                               |
| BTC probability = 62%     | ObservationEvent | State measurement                               |
| p95 latency = 480ms       | ObservationEvent | State measurement                               |
| Conversion rate = 3.2%    | ObservationEvent | State measurement                               |
| Orderbook spread = 100bps | ObservationEvent | State measurement                               |

**Attribution eligibility is a downstream concern.** The attribution pipeline's selection stage decides which discrete events enter an epoch — not the record type. An observation never gets attributed (it's a measurement, not an action), but a discrete event might or might not be attribution-eligible depending on selection policy.

**Observations can trigger derived events.** "Price crossed 500bps threshold" (observation) may cause "alert fired" (activity event). The observation is the raw fact; the derived event is a separate record created downstream.

### ObservationEvent fields

| Field         | Type                      | Description                                                          |
| ------------- | ------------------------- | -------------------------------------------------------------------- |
| `id`          | string                    | Deterministic via `buildEventId(source, "obs", entityId, timestamp)` |
| `source`      | string                    | Adapter source: `"polymarket"`, `"grafana"`, `"posthog"`             |
| `entityId`    | string                    | Stable subject key: `"polymarket:market:abc123"`                     |
| `entityTitle` | string                    | Human-readable: `"Fed cuts rates at June meeting?"`                  |
| `category`    | string                    | Domain-specific: `"economics"`, `"api-latency"`, `"funnel"`          |
| `values`      | Record\<string, number\>  | Domain-specific numerics: `{ probabilityBps: 6200, spreadBps: 100 }` |
| `metadata`    | Record\<string, unknown\> | Non-numeric context, source pointers for deep investigation          |
| `payloadHash` | string                    | SHA-256 via `hashCanonicalPayload()` — same as ActivityEvent         |
| `observedAt`  | Date                      | When the measurement was taken at the source                         |

**The adapter decides which type to produce.** A source may emit both — a social media adapter produces `ActivityEvent` for posts (discrete actions) and `ObservationEvent` for engagement metrics (measurements). A market adapter produces `ObservationEvent` for prices and `ActivityEvent` when a market resolves.

---

## AI Decision Layers

The decision plane consumes **both record types**. Observations are the primary input (continuous monitoring), but discrete events can also trigger analysis (e.g., "Grafana alert fired" → investigate, "market resolved" → record outcome).

```
observation_events ───┐
                      ├──→ Derived state + features ── domain-specific views/aggregates
ingestion_receipts ───┘    (latest per entity, rolling windows, recent events)
                                    │
                                    ▼
                      Trigger evaluation ─────────── pure functions in Workflow code
                                    │                 ephemeral — not persisted
                                    │
                          Budget gate ────────────── cap concurrent runs + LLM calls/hour
                                    │
                                    ▼
                      analysis_runs (persisted) ──── Temporal Workflow + LangGraph child
                                    │
                                    ▼
                      analysis_signals (persisted) ─ AI conclusions with action level
                                    │
                                    ▼
                      Action routing ─────────────── domain-specific: observe/alert/recommend/auto-act/escalate
                                    │
                                    ▼
                      analysis_outcomes (persisted) ─ ground truth when entities resolve
                                    │
                                    ▼
                      base_rates (updated) ────────── calibration loop
```

> **v1 scope:** The Polymarket domain pack triggers only on observations (price moves, volume spikes, cross-platform spreads). Triggering on discrete events (e.g., "market resolved" → calibration) is supported by the architecture but implemented incrementally.

### Record Families

| Family                 | Persisted?                | Lifecycle                                 | Purpose                                                                  |
| ---------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| **Raw facts**          | Yes — both tables         | Append-only, immutable                    | What the AI saw. Source of truth. Both observations and discrete events. |
| **Derived state**      | No — views on raw log     | Recomputed on read                        | Latest value per entity, rolling aggregates. Domain defines the views.   |
| **Trigger candidates** | No — ephemeral            | Evaluated in Workflow code, discarded     | Cheap filter: did anything change enough to warrant AI tokens?           |
| **Analysis cases**     | Yes — `analysis_runs`     | Created on trigger, updated on completion | When and why AI was invoked. Temporal workflowId as PK.                  |
| **Signals**            | Yes — `analysis_signals`  | Created by analysis, immutable            | What the AI concluded. Action level determines routing.                  |
| **Outcomes**           | Yes — `analysis_outcomes` | Created when entity resolves              | Ground truth. Compared against signals for calibration.                  |

**Key filtering principle:** ~95% of raw facts should be eliminated by cheap deterministic triggers before any LLM call. The budget gate caps the remaining 5% to prevent runaway token spend.

---

## What Humans See

```
┌─────────────────────────────────────┐
│       Postgres (source of truth)    │
│  observation_events + analysis_*    │
└──────────────┬──────────────────────┘
               │
          INSERT triggers
               │
               ▼
┌─────────────────────────────────────┐
│     Redis Streams (live fan-out)    │
│  obs:{domain}  signals:{domain}    │
└──────────────┬──────────────────────┘
               │
            SSE/WS
               │
               ▼
┌─────────────────────────────────────┐
│         UI: AI Awareness Feed       │
│                                     │
│  "What the AI sees, as it sees it"  │
│  Observations → Triggers → Signals  │
└─────────────────────────────────────┘
```

Postgres is the durable log. Redis Streams fan out live events for the UI. The SSE endpoint replays recent history from Postgres on connect, then tails Redis for live updates. Same pattern as existing `apps/web` streaming.

Users see the same event stream the AI sees. **Transparency is the product.**

---

## Invariants

| Rule                        | Constraint                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SINGLE_INGESTION_SUBSTRATE  | Both ActivityEvent and ObservationEvent flow through ingestion-core PollAdapter. Same cursors, same ID helpers, same payloadHash. No parallel ingestion system.                                        |
| FACT_TYPE_NOT_USE_TYPE      | The ActivityEvent/ObservationEvent split describes the kind of fact (event vs measurement), not the downstream use. Attribution eligibility is decided by the selection stage, not by the record type. |
| OWN_DECISIONS_NOT_TELEMETRY | External backends own raw data. Our DB stores compact snapshots + decision artifacts + source pointers. Never mirror firehoses.                                                                        |
| OBSERVATION_APPEND_ONLY     | `observation_events` is append-only. DB trigger rejects UPDATE/DELETE. Same pattern as `ingestion_receipts`.                                                                                           |
| OBSERVATION_IDEMPOTENT      | Observation IDs are deterministic via `buildEventId()`. Retries produce the same record.                                                                                                               |
| NO_ENTITY_REGISTRY          | No `monitored_entities` table. `entityId` is a stable key on raw records and signals. Derived views materialize latest state when needed.                                                              |
| CHEAP_BEFORE_EXPENSIVE      | Triggers are pure functions on derived state. The LLM never sees raw firehose. ~95% filtered before any AI call.                                                                                       |
| BUDGET_GATE                 | `prioritizeTriggers(triggers, budget, activeRuns)` caps concurrent analysis runs and LLM calls/hour. Triggers compete on priority.                                                                     |
| TEMPORAL_OWNS_IO            | All DB reads/writes and HTTP calls happen in Temporal Activities (per temporal-patterns-spec).                                                                                                         |
| GRAPH_OWNS_THINKING         | LLM reasoning lives in a LangGraph graph invoked via Temporal Activity. The graph does zero I/O.                                                                                                       |
| WORKFLOW_PURE_ONLY          | Trigger evaluation and scoring run in Temporal Workflow code. Deterministic, replay-safe.                                                                                                              |
| ACTION_LEVELS               | Every signal declares one of: `observe`, `alert`, `recommend`, `auto_act`, `escalate`.                                                                                                                 |
| CALIBRATION_LOOP            | When an entity resolves, an outcome is recorded. A calibration job compares signals to outcomes and updates base rates.                                                                                |

---

## Schema

Existing tables (`ingestion_receipts`, `ingestion_cursors`) are unchanged — they remain in `db-schema/attribution` for now.

New tables live in a **neutral `db-schema/ingestion` slice** — not under attribution. Observations and the AI decision pipeline have nothing to do with epoch-based credit allocation.

### `observation_events` — raw observation log

| Column         | Type        | Constraints           | Description                                          |
| -------------- | ----------- | --------------------- | ---------------------------------------------------- |
| `id`           | text        | PK                    | Deterministic: `{source}:obs:{entityId}:{timestamp}` |
| `node_id`      | uuid        | NOT NULL              | Tenant scope                                         |
| `source`       | text        | NOT NULL              | Adapter source name                                  |
| `entity_id`    | text        | NOT NULL              | Stable subject key                                   |
| `entity_title` | text        | NOT NULL              | Human-readable label                                 |
| `category`     | text        | NOT NULL              | Domain-specific category                             |
| `values`       | jsonb       | NOT NULL              | Numeric fields (domain-specific)                     |
| `metadata`     | jsonb       |                       | Non-numeric context, source pointers                 |
| `payload_hash` | text        | NOT NULL              | SHA-256 provenance                                   |
| `observed_at`  | timestamptz | NOT NULL              | When observed at source                              |
| `ingested_at`  | timestamptz | NOT NULL, default now | When we stored it                                    |

Indexes: `(entity_id, observed_at)`, `source`, `category`, `(node_id, observed_at)`. TimescaleDB hypertable on `observed_at` when available.

### `analysis_runs` — when and why AI was invoked

| Column              | Type        | Constraints         | Description                                     |
| ------------------- | ----------- | ------------------- | ----------------------------------------------- |
| `id`                | text        | PK                  | Temporal workflowId                             |
| `node_id`           | uuid        | NOT NULL            |                                                 |
| `domain`            | text        | NOT NULL            | `"prediction-market"`, `"infrastructure"`, etc. |
| `trigger_type`      | text        | NOT NULL            | Domain-defined trigger type                     |
| `trigger_detail`    | text        |                     | Human-readable context                          |
| `entities_analyzed` | integer     | NOT NULL, default 0 |                                                 |
| `signals_generated` | integer     | NOT NULL, default 0 |                                                 |
| `status`            | text        | NOT NULL            | `running` / `completed` / `failed`              |
| `started_at`        | timestamptz | NOT NULL            |                                                 |
| `completed_at`      | timestamptz |                     |                                                 |

### `analysis_signals` — AI conclusions

| Column           | Type    | Constraints        | Description                                   |
| ---------------- | ------- | ------------------ | --------------------------------------------- |
| `id`             | text    | PK                 | `signal:{entityId}:{runId}` — deterministic   |
| `node_id`        | uuid    | NOT NULL           |                                               |
| `entity_id`      | text    | NOT NULL           | Stable subject key (not FK — no entity table) |
| `run_id`         | text    | FK → analysis_runs | Which run produced this                       |
| `domain`         | text    | NOT NULL           |                                               |
| `finding`        | text    | NOT NULL           | What was found                                |
| `thesis`         | text    | NOT NULL           | LLM reasoning                                 |
| `confidence_pct` | integer | NOT NULL           | 0–100                                         |
| `action_level`   | text    | NOT NULL           | observe/alert/recommend/auto_act/escalate     |
| `payload`        | jsonb   | NOT NULL           | Domain-specific structured data               |
| `sources`        | jsonb   | NOT NULL           | Evidence references                           |

### `analysis_outcomes` — ground truth for calibration

| Column        | Type        | Constraints | Description                          |
| ------------- | ----------- | ----------- | ------------------------------------ |
| `id`          | text        | PK          |                                      |
| `entity_id`   | text        | NOT NULL    | What resolved                        |
| `resolution`  | text        | NOT NULL    | What actually happened               |
| `correct`     | boolean     |             | null until evaluated against signals |
| `resolved_at` | timestamptz | NOT NULL    |                                      |

### `base_rates` — historical frequencies for calibration

| Column                 | Type         | Constraints | Description                        |
| ---------------------- | ------------ | ----------- | ---------------------------------- |
| `category_key`         | text         | PK          | `{domain}:{category}:{event_type}` |
| `domain`               | text         | NOT NULL    |                                    |
| `historical_frequency` | numeric(6,4) | NOT NULL    | 0.0000–1.0000                      |
| `sample_size`          | integer      | NOT NULL    |                                    |
| `source`               | text         | NOT NULL    | Where the rate came from           |

---

## Domain Pack Interface

Each domain (prediction markets, infrastructure, analytics, social) provides:

| Slot              | What                                     | Example (Polymarket)                                        |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Edge adapter      | PollAdapter or WebhookNormalizer         | Gamma API + CLOB polling                                    |
| Record type       | ActivityEvent, ObservationEvent, or both | ObservationEvent with `probabilityBps`, `spreadBps`         |
| Source pointers   | URLs/queries for deep investigation      | Market URL, CLOB orderbook endpoint                         |
| Derived features  | Domain-specific views on raw log         | 1h OHLC, 24h change, volume moving average                  |
| Trigger functions | Pure: derived state → TriggerCheck[]     | Price move >5%, volume spike >2x, cross-platform spread >3% |
| Enrichment        | Temporal Activity: fetch external refs   | GDELT news, Metaculus forecasts, base rates                 |
| LLM prompt        | System prompt for synthesis graph        | Calibrated market analyst                                   |
| Scoring function  | Pure: assessments → signals              | Edge scoring with liquidity discount                        |
| Action routing    | Map action levels to domain actions      | observe/alert/recommend at confidence thresholds            |
| Resolution logic  | How entities resolve → outcomes          | Market settles → outcome recorded                           |
| Base rate seeds   | Initial calibration data                 | Historical event frequencies by category                    |

---

## Non-Goals

- Replacing `ingestion-core` or `attribution-ledger`
- Cloning external backend data (Grafana/Mimir, PostHog)
- Real-time WebSocket feeds (upgrade path, not MVP)
- Multi-tenant isolation (single-node MVP)

## Open Questions

- [x] ~~Should `observation_events` live in `db-schema/attribution` or a new slice?~~ → New `db-schema/ingestion` slice. Attribution is a downstream consumer, not the owner of awareness data.
- [ ] Default budget values (maxConcurrentRuns, maxLlmCallsPerHour)?
- [ ] Should `auto_act` require governance approval?
- [ ] When to rename `ActivityEvent` → `DiscreteEvent` in `ingestion-core`? (Breaking change, needs migration.)

## Related

- [Architecture](./architecture.md) — hexagonal layering
- [Ingestion Core](../../packages/ingestion-core/AGENTS.md) — PollAdapter, ActivityEvent
- [Attribution Ledger](../../packages/attribution-ledger/AGENTS.md) — epoch lifecycle
- [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md) — Polymarket domain pack (first implementation)
