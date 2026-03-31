---
id: task.0227.handoff
type: handoff
work_item_id: task.0227
status: active
created: 2026-03-31
updated: 2026-03-31
branch: feat/market-provider-package
last_commit: 79ddbc77
---

# Handoff: Build the Poly Data Pipeline

## What You're Building

The first domain pack on the Cogni AI Awareness & Decision Plane — a Polymarket/Kalshi prediction market monitoring pipeline that:

1. Polls market data via `PollAdapter` (existing ingestion-core interface)
2. Persists observations to `observation_events` (append-only, new table)
3. Evaluates cheap triggers (price moves, volume spikes, cross-platform spreads)
4. Runs AI analysis only when triggers fire (budget-gated)
5. Produces scored signals served to the `apps/poly` landing page

## Read These First (in this order)

| File                                                                                       | Why                                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [monitoring-engine spec](../../docs/spec/monitoring-engine.md)                             | **The approved design.** Federated awareness model, single ingestion spine, AI decision layers, invariants. Read the whole thing. |
| [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md)               | Implementation plan with phases P0–P8, Polymarket/Kalshi adapter details, trigger thresholds, scoring logic, API endpoints.       |
| [ingestion-core AGENTS.md](../../packages/ingestion-core/AGENTS.md)                        | Existing PollAdapter, ActivityEvent, cursor model, helpers. You'll add ObservationEvent here.                                     |
| [temporal-patterns spec](cogni-template: docs/spec/temporal-patterns.md)                   | Workflow/Activity/Graph boundaries. Critical: Temporal owns I/O, LangGraph owns LLM reasoning, pure functions in Workflow code.   |
| [apps/poly/src/components/BrainFeed.tsx](../../apps/poly/src/components/BrainFeed.tsx)     | Mock types for MarketSignal, BrainStatus — your API must match these shapes exactly (zero frontend changes).                      |
| [apps/poly/src/components/MarketCards.tsx](../../apps/poly/src/components/MarketCards.tsx) | Mock Market type — your `/markets` endpoint must match this shape.                                                                |

## Current State

- **Branch:** `feat/market-provider-package` (pushed to origin)
- **Landing page:** Live with mock data (`apps/poly`, port 3100). PR #12 merged.
- **Spec:** Approved and committed. No more design iteration needed — implement it.
- **`packages/market-provider/`:** Another developer is building this package on the same branch. It provides `MarketProviderPort` with Polymarket + Kalshi adapters. **Your data pipeline adapters should use `market-provider` for API access** rather than building raw HTTP clients. Coordinate on this — check their port interface before writing your PollAdapter implementations.
- **No backend code exists yet.** This is greenfield.

## Key Architecture Decisions (already made)

| Decision                                       | Rationale                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One ingestion spine, two record types**      | `ActivityEvent` (discrete events) + `ObservationEvent` (measurements). Same PollAdapter, cursors, `buildEventId`, `payloadHash`. Two physical tables because `ingestion_receipts` has `platform_user_id NOT NULL`. |
| **`db-schema/ingestion` slice (new)**          | `observation_events` + analysis pipeline tables. NOT in `db-schema/attribution` — observations have nothing to do with epoch allocation.                                                                           |
| **Temporal owns I/O, LangGraph owns thinking** | All DB reads/writes and HTTP calls in Activities. LLM reasoning in a `poly-synth` LangGraph graph invoked via Activity. Scoring in Workflow code (pure, replay-safe).                                              |
| **Cheap before expensive**                     | ~95% of observations filtered by deterministic triggers before any LLM call. Budget gate caps concurrent runs + LLM calls/hour.                                                                                    |
| **No entity registry table**                   | `entityId` is a stable key on raw records and signals. Derived views materialize latest state. No `monitored_entities`.                                                                                            |
| **`poly-synth` NOT in LANGGRAPH_CATALOG**      | It's not a message-based chat agent. Follows `pr-review` pattern: `createReactAgent` + structured output, no tools. Invoked by Temporal Activity directly.                                                         |
| **Federated awareness**                        | Polymarket/Kalshi APIs own raw data. We store compact snapshots + source pointers. Don't mirror firehoses.                                                                                                         |

## Implementation Phases

| Phase  | What                                                                                                                           | Depends On | Notes                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- |
| **P0** | Add `ObservationEvent` to `ingestion-core` model + extend `CollectResult`                                                      | Nothing    | Smallest possible change — type + optional field                                                           |
| **P1** | Add `db-schema/ingestion` slice — `observation_events`, `analysis_runs`, `analysis_signals`, `analysis_outcomes`, `base_rates` | Nothing    | New subpath export, TimescaleDB hypertable on `observed_at`                                                |
| **P2** | `packages/poly-core` — Zod schemas, normalizers, trigger thresholds, `scoreEdge()`                                             | P0         | Pure package, no I/O. Depends on `ObservationEvent` type.                                                  |
| **P3** | Data adapters — PollAdapter impls wrapping `market-provider`                                                                   | P2         | **Coordinate with other dev on MarketProviderPort interface.** Adapters live in `apps/poly/src/adapters/`. |
| **P4** | `poly-synth` LangGraph graph                                                                                                   | P2         | In `packages/langgraph-graphs/src/graphs/poly-synth/`. Structured output → `RawAssessment[]`.              |
| **P5** | Temporal activities + workflows                                                                                                | P1–P4      | `CollectObservationsWorkflow`, `EvaluateTriggersWorkflow`, `AnalysisRunWorkflow`. Debounce via workflowId. |
| **P6** | API routes (`/brain/status`, `/brain/signals`, `/markets`)                                                                     | P1, P2     | Match mock types in BrainFeed.tsx and MarketCards.tsx exactly.                                             |
| **P7** | Frontend wiring — replace mocks with API calls                                                                                 | P6         | `BrainFeed.tsx`, `MarketCards.tsx` fetch from new endpoints.                                               |
| **P8** | SSE stream (stretch)                                                                                                           | P5, P6     | Redis Streams → SSE, reuse pattern from `apps/web`.                                                        |

P0 + P1 are parallelizable. P3 + P4 are parallelizable.

## Risks / Gotchas

| Risk                                                          | Mitigation                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **`market-provider` port interface not stable yet**           | Check with other dev before writing P3 adapters. If port isn't ready, write adapters with raw HTTP first, swap to port later.                 |
| **Polymarket `outcomePrices` is a JSON string**               | Must `JSON.parse()` in normalizer — it's not an array in the raw API response.                                                                |
| **Kalshi values are in cents (0–100)**                        | Normalizer must multiply by 100 for basis points (0–10000).                                                                                   |
| **TimescaleDB may not be in dev Docker image**                | Table works as regular table without the extension — just add index on `observed_at`. Hypertable is a production optimization.                |
| **Pre-existing lint failures in `packages/market-provider/`** | Other dev's files need SPDX headers + TSDoc. If pre-commit/pre-push hooks fail on their files, stash `packages/market-provider/` temporarily. |
| **`apps/poly` is standalone Next.js (port 3100)**             | API routes live in `apps/poly/src/app/api/`, not `apps/web`. No cross-app calls needed.                                                       |

## Validation Criteria

From task.0227 — the pipeline is done when:

- [ ] `ingestion-core` exports `ObservationEvent` type
- [ ] `observation_events` table created via migration
- [ ] Polymarket adapter polls ≥100 markets into `observation_events`
- [ ] Kalshi adapter polls ≥50 markets into `observation_events`
- [ ] Snapshots accumulate every 60 sec
- [ ] 24h change computed from real observation data
- [ ] Triggers fire on >5% price move (unit test)
- [ ] `poly-synth` graph returns valid `RawAssessment[]`
- [ ] `scoreEdge` filters <5% edge and <50% confidence (unit test)
- [ ] API endpoints return valid responses matching frontend mock types
- [ ] Landing page renders real data (no mocks)
- [ ] `pnpm check` passes

## Commands

```bash
pnpm dev                      # start dev server
pnpm packages:build           # build workspace packages (run after changing ingestion-core)
pnpm check                    # lint + type + format (fast gate)
pnpm test                     # unit tests
pnpm check:full               # CI-parity full validation (slow, use as final gate)
```
