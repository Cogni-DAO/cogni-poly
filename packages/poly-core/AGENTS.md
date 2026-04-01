# poly-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure domain types, Zod schemas, trigger functions, and scoring logic for prediction market monitoring. Bridges `@cogni/market-provider` (NormalizedMarket) and `@cogni/ingestion-core` (ObservationEvent).

## Pointers

- [Monitoring Engine Spec](../../docs/spec/monitoring-engine.md)
- [task.0227](../../work/items/task.0227.poly-mvp-agent-workflows-and-taps.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `zod`.

## Public Surface

- **Exports:**
  - **Schemas:** `RawAssessmentSchema`, `SynthesisOutputSchema`, `MarketSignalSchema`, `BrainStatusSchema`, `MarketResponseSchema`, `ActionLevelSchema` + corresponding types and API response wrappers (`BrainStatusResponseSchema`, `BrainSignalsResponseSchema`, `MarketsResponseSchema`)
  - **Triggers:** `checkPriceMove()`, `checkVolumeSpike()`, `checkCrossPlatformSpread()`, `THRESHOLDS`, `TriggerCheck`
  - **Scoring:** `scoreEdge()`, `lookupBaseRate()`, `SCORING_THRESHOLDS`, `ScoredSignal`
  - **Normalizers:** `marketToObservation()` (NormalizedMarket → ObservationEvent), `marketToResponse()` (NormalizedMarket → MarketResponse), `formatVolume()`

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define prediction market domain schemas, pure trigger threshold checks, edge scoring with action level routing, and NormalizedMarket → ObservationEvent/MarketResponse transforms
- This directory **does not**: Perform I/O, fetch data, access databases, import from `src/` or `services/`

## Usage

```bash
pnpm --filter @cogni/poly-core typecheck
pnpm --filter @cogni/poly-core build
```

## Standards

- Pure functions and types only — no I/O, no framework deps
- WORKFLOW_PURE_ONLY: Triggers and scoring are deterministic, replay-safe for Temporal Workflow code
- CHEAP_BEFORE_EXPENSIVE: Triggers filter ~95% of observations before any LLM call
- ACTION_LEVELS: Every scored signal declares one of observe/alert/recommend/auto_act/escalate

## Dependencies

- **Internal:** `@cogni/ingestion-core` (ObservationEvent, buildEventId, hashCanonicalPayload), `@cogni/market-provider` (NormalizedMarket)
- **External:** `zod`

## Change Protocol

- Update this file when public exports change
- Coordinate with monitoring-engine spec invariants

## Notes

- `marketToObservation()` is async (uses Web Crypto for payloadHash)
- Trigger thresholds are constants, not config — change requires code change + test update
- API response schemas match frontend mock types in `apps/poly/src/components/` exactly
