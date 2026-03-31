---
id: task.0227
type: task
title: "Cogni Poly — MVP agent workflows & data streams"
status: needs_implement
priority: 1
rank: 1
estimate: 5
summary: Design the generic Cogni monitoring engine (cogni-template PR) and the Polymarket domain pack (additive) — continuous data streams with threshold-triggered AI analysis.
outcome: Two implementable specs — one generic monitoring backbone reusable across all Cogni nodes, one Polymarket-specific domain policy pack.
spec_refs:
  - task.0226
assignees: derekg1729
credit:
project:
branch: staging
pr:
reviewer:
revision: 3
blocked_by:
deploy_verified: false
created: 2026-03-30
updated: 2026-03-30
labels: [poly, prediction-markets, ai, langgraph, design, cogni-template]
external_refs:
---

# Cogni Poly — MVP Agent Workflows & Data Streams (v4)

> Revision 3 — split into generic engine (Part A: cogni-template PR) and
> domain pack (Part B: polymarket-specific, additive). The generic pattern
> applies to Grafana, PostHog, social media, pricing — any data stream a
> Cogni node needs to monitor, analyze, and act on.

---

# PART A — Generic Cogni Monitoring Engine (cogni-template PR)

> This part defines the reusable backbone. Every Cogni node gets this.
> Domain-specific adapters, prompts, and scoring are plugged in on top.

## A1. The Universal Pipeline

Every Cogni monitoring concern follows the same shape:

```
Source → Normalize → Snapshot → Trigger → Enrich → Synthesize (AI) → Score → Act → Measure → Calibrate
```

| Stage          | Responsibility                                                  | Owner                                                | Domain-specific?                      |
| -------------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| **Source**     | Poll or receive data from external system                       | `PollAdapter` / `WebhookNormalizer` (ingestion-core) | Yes — each source has its own adapter |
| **Normalize**  | Map raw data → canonical `MonitoredEntity`                      | Pure function                                        | Yes — per-source normalizer           |
| **Snapshot**   | Append time-series observation                                  | Temporal Activity → DB                               | No — generic table                    |
| **Trigger**    | Evaluate thresholds → decide if analysis needed                 | Temporal Workflow (pure functions)                   | Yes — domain defines thresholds       |
| **Enrich**     | Fetch reference data (base rates, news, context)                | Temporal Activity                                    | Partially — enrichment sources vary   |
| **Synthesize** | LLM reasons over structured context                             | LangGraph child (via Activity)                       | Yes — domain-specific prompt          |
| **Score**      | Pure math: confidence, edge, priority                           | Temporal Workflow (pure functions)                   | Yes — domain-specific scoring         |
| **Act**        | Route action: observe / alert / recommend / auto-act / escalate | Temporal Activity                                    | Yes — domain-specific actions         |
| **Measure**    | Record outcome when ground truth arrives                        | Temporal Activity                                    | Yes — domain defines resolution       |
| **Calibrate**  | Update base rates and model parameters                          | Temporal Activity                                    | No — generic calibration loop         |

## A2. Generic Packages

### `packages/monitor-core/` — Pure domain types (no I/O)

The equivalent of `ingestion-core` but for the analysis/action side. Contains Zod schemas and pure functions that every monitoring domain shares.

```typescript
// packages/monitor-core/src/schemas/entity.ts

/** A thing being monitored — generic across all domains */
export const MonitoredEntitySchema = z.object({
  id: z.string(), // Deterministic: "{domain}:{source}:{sourceId}"
  domain: z.string(), // "prediction-market", "infrastructure", "analytics", "social"
  source: z.string(), // "polymarket", "grafana", "posthog", "twitter"
  sourceId: z.string(),
  title: z.string(),
  category: z.string(),
  /** Domain-specific structured data */
  attributes: z.record(z.unknown()),
  active: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type MonitoredEntity = z.infer<typeof MonitoredEntitySchema>;
```

```typescript
// packages/monitor-core/src/schemas/signal.ts

/** Action levels — from passive to autonomous */
export const ActionLevelSchema = z.enum([
  "observe", // Log it, no notification
  "alert", // Notify human, no recommendation
  "recommend", // Notify human with suggested action
  "auto_act", // Execute action, notify human after
  "escalate", // Urgent — interrupt human immediately
]);

/** A signal emitted by the analysis pipeline */
export const SignalSchema = z.object({
  id: z.string(), // Deterministic: "signal:{entityId}:{runId}"
  entityId: z.string(),
  domain: z.string(),
  source: z.string(),
  category: z.string(),
  /** What the analysis found */
  finding: z.string(),
  /** Structured reasoning from the LLM */
  thesis: z.string(),
  /** 0–100 */
  confidencePct: z.number().int().min(0).max(100),
  /** What action level is justified */
  actionLevel: ActionLevelSchema,
  /** Domain-specific structured payload */
  payload: z.record(z.unknown()),
  sources: z.array(z.string()),
  runId: z.string(),
  timestamp: z.string().datetime(),
});
export type Signal = z.infer<typeof SignalSchema>;
```

```typescript
// packages/monitor-core/src/schemas/trigger.ts

export const TriggerCheckSchema = z.object({
  type: z.string(), // Domain defines its own trigger types
  entityId: z.string(),
  detail: z.string(),
  /** Priority score for competing triggers (higher = more urgent) */
  priority: z.number().int().min(0).max(100),
});
export type TriggerCheck = z.infer<typeof TriggerCheckSchema>;
```

```typescript
// packages/monitor-core/src/schemas/run.ts

export const AnalysisRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
]);

export const AnalysisRunSchema = z.object({
  id: z.string(),
  domain: z.string(),
  trigger: TriggerCheckSchema,
  entitiesScanned: z.number().int(),
  signalsGenerated: z.number().int(),
  status: AnalysisRunStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;
```

```typescript
// packages/monitor-core/src/schemas/outcome.ts

/** Ground truth for calibration — recorded when an entity resolves */
export const OutcomeSchema = z.object({
  entityId: z.string(),
  /** What actually happened */
  resolution: z.string(),
  /** The signals we emitted for this entity */
  signalIds: z.array(z.string()),
  /** Was our signal direction correct? */
  correct: z.boolean().optional(), // null until evaluated
  resolvedAt: z.string().datetime(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;
```

```typescript
// packages/monitor-core/src/focus.ts — Global focus policy (pure functions)

/** Every trigger competes in a shared priority queue with budget */
export function prioritizeTriggers(
  triggers: TriggerCheck[],
  budget: { maxConcurrentRuns: number; maxLlmCallsPerHour: number },
  activeRuns: number
): TriggerCheck[] {
  if (activeRuns >= budget.maxConcurrentRuns) return [];
  return triggers
    .sort((a, b) => b.priority - a.priority)
    .slice(0, budget.maxConcurrentRuns - activeRuns);
}
```

### `packages/db-schema/monitor` — Generic monitoring tables

New slice. Self-contained (no `monitor-core` import). Domain-specific tables extend these.

```typescript
// packages/db-schema/src/monitor.ts

/** Entity state — the thing being watched */
export const monitoredEntities = pgTable(
  "monitored_entities",
  {
    id: text("id").primaryKey(), // "{domain}:{source}:{sourceId}"
    domain: text("domain").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("mon_entities_domain_source_idx").on(t.domain, t.source),
    index("mon_entities_category_idx").on(t.category),
    index("mon_entities_active_idx").on(t.active),
    uniqueIndex("mon_entities_domain_source_source_id_idx").on(
      t.domain,
      t.source,
      t.sourceId
    ),
  ]
).enableRLS();

/** Time-series observations — numeric snapshots per entity */
export const entitySnapshots = pgTable(
  "entity_snapshots",
  {
    entityId: text("entity_id")
      .references(() => monitoredEntities.id)
      .notNull(),
    /** Domain-specific numeric values (prices, counts, latencies, etc.) */
    values: jsonb("values").$type<Record<string, number>>().notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("entity_snapshots_entity_time_idx").on(t.entityId, t.snapshotAt),
  ]
);
// TimescaleDB: SELECT create_hypertable('entity_snapshots', 'snapshot_at');

/** Analysis run ledger */
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerDetail: text("trigger_detail"),
    entitiesScanned: integer("entities_scanned").notNull().default(0),
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
    index("analysis_runs_status_idx").on(t.status),
    index("analysis_runs_started_idx").on(t.startedAt),
  ]
).enableRLS();

/** Signals emitted by analysis */
export const signals = pgTable(
  "signals",
  {
    id: text("id").primaryKey(), // "signal:{entityId}:{runId}"
    entityId: text("entity_id")
      .references(() => monitoredEntities.id)
      .notNull(),
    runId: text("run_id")
      .references(() => analysisRuns.id)
      .notNull(),
    domain: text("domain").notNull(),
    source: text("source").notNull(),
    category: text("category").notNull(),
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
    index("signals_domain_idx").on(t.domain),
    index("signals_created_idx").on(t.createdAt),
    index("signals_action_level_idx").on(t.actionLevel),
  ]
).enableRLS();

/** Base rates for calibration — shared across domains */
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

/** Outcomes for calibration loop — ground truth when entities resolve */
export const outcomes = pgTable(
  "outcomes",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .references(() => monitoredEntities.id)
      .notNull(),
    resolution: text("resolution").notNull(),
    correct: boolean("correct"), // null until evaluated against signals
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("outcomes_entity_idx").on(t.entityId),
    uniqueIndex("outcomes_entity_unique_idx").on(t.entityId),
  ]
).enableRLS();
```

### Generic Temporal Workflows (in `packages/temporal-workflows/`)

Two reusable workflow patterns that domain packs compose:

**`DataStreamWorkflow`** — Polls sources on an interval, writes snapshots, evaluates triggers.

```typescript
// packages/temporal-workflows/src/workflows/data-stream.ts

export interface DataStreamConfig {
  domain: string;
  /** Activity that fetches + normalizes + upserts entities */
  pollActivityName: string;
  /** Activity that appends snapshots */
  snapshotActivityName: string;
  /** Pure function that evaluates triggers given current + historical data */
  evaluateTriggers: (snapshots: SnapshotBatch) => TriggerCheck[];
  /** Polling intervals */
  entityPollInterval: Duration; // e.g., 5 min
  snapshotPollInterval: Duration; // e.g., 60 sec
  /** Budget for how many analysis runs can fire */
  budget: { maxConcurrentRuns: number; maxLlmCallsPerHour: number };
}
```

**`AnalysisRunWorkflow`** — Triggered by `DataStreamWorkflow`. Loads context, calls AI, scores, persists.

```typescript
// packages/temporal-workflows/src/workflows/analysis-run.ts

export interface AnalysisRunConfig {
  domain: string;
  /** Activity: load entities + snapshots + cross-references from DB */
  loadContextActivityName: string;
  /** Activity: fetch external reference data (news, expert forecasts, etc.) */
  enrichActivityName: string;
  /** Activity: invoke LangGraph synthesis graph */
  synthesizeActivityName: string;
  /** Pure function: score assessments into signals */
  scoreAssessments: (
    assessments: unknown[],
    entities: MonitoredEntity[]
  ) => Signal[];
  /** Activity: write signals + update run record */
  persistActivityName: string;
}
```

The workflow itself is generic:

```typescript
export async function AnalysisRunWorkflow(
  config: AnalysisRunConfig,
  input: { trigger: TriggerCheck; entityIds: string[] }
): Promise<void> {
  const runId = workflow.workflowInfo().workflowId;

  // Activity: mark run started
  await activities[config.domain].createRunRecord(runId, input.trigger);

  // Activity: load context
  const context = await activities[config.domain].loadContext(
    input.trigger,
    input.entityIds
  );

  // Activity: enrich with external references
  const refs = await activities[config.domain].enrich(context.entities);

  // Activity: LLM synthesis (domain-specific graph)
  const assessments = await activities[config.domain].synthesize(context, refs);

  // Workflow code: score (pure function, replay-safe)
  const scored = config.scoreAssessments(assessments, context.entities);

  // Activity: persist signals
  await activities[config.domain].persist(
    runId,
    scored,
    context.entities.length
  );
}
```

Debounce uses **Temporal workflowId idempotency**: `{domain}-analysis:{5minBucket}`.

### What Every Cogni Node Gets (Template)

When a new Cogni node is created, it inherits:

- `packages/monitor-core/` — schemas, focus policy, types
- `packages/db-schema/monitor` — generic tables (entities, snapshots, runs, signals, base_rates, outcomes)
- `packages/temporal-workflows/` — `DataStreamWorkflow` + `AnalysisRunWorkflow` patterns
- `packages/ingestion-core/` — `PollAdapter` interface (already exists)
- TimescaleDB hypertable on `entity_snapshots`
- Calibration loop: outcomes → base rate updates

---

# PART B — Polymarket Domain Pack (additive, this repo only)

> This part is domain-specific policy. It plugs into the generic engine from Part A.
> Another node could have a Grafana domain pack, or a PostHog domain pack,
> or a social media domain pack — all using the same backbone.

## B1. What the Domain Pack Provides

| Generic Slot       | Polymarket Implementation                                                               |
| ------------------ | --------------------------------------------------------------------------------------- |
| Source adapters    | `polymarket` PollAdapter, `kalshi` PollAdapter                                          |
| Normalizer         | `normalizePolymarketMarket()`, `normalizeKalshiMarket()`                                |
| Entity attributes  | `probabilityBps`, `volume`, `openInterest`, `outcomesJson`, `resolvesAt`                |
| Snapshot values    | `probabilityBps`, `bestBidBps`, `bestAskBps`, `spreadBps`, `bidDepthUsd`, `askDepthUsd` |
| Trigger thresholds | Price move >5%/1h, Volume spike >2x/24h, Cross-platform spread >3%                      |
| Enrichment sources | GDELT news, Metaculus expert forecasts, base rates DB                                   |
| LangGraph prompt   | Calibrated market analyst (base rate → news update → fair probability → thesis)         |
| Scoring function   | `scoreEdge()`: \|fair - market\| > 500bps, liquidity-discounted confidence > 50%        |
| Action routing     | Observe (log), Alert (>70% confidence), Recommend (>85% confidence + >8% edge)          |
| Resolution         | Market resolves → outcome recorded → calibration update                                 |
| Base rate seeds    | economics, politics, climate, tech, crypto event frequencies                            |

## B2. Package: `packages/poly-core/`

Pure domain types + math for prediction markets. Imports from `monitor-core` and extends it.

```typescript
// packages/poly-core/src/schemas/market.ts — extends MonitoredEntity

export const PlatformSchema = z.enum(["polymarket", "kalshi"]);

export const NormalizedMarketSchema = MonitoredEntitySchema.extend({
  domain: z.literal("prediction-market"),
  platform: PlatformSchema,
  probabilityBps: z.number().int().min(0).max(10000),
  change24hBps: z.number().int(),
  spreadBps: z.number().int().min(0),
  volume: z.number(),
  outcomes: z.array(
    z.object({
      label: z.string(),
      probabilityBps: z.number().int().min(0).max(10000),
      change24hBps: z.number().int(),
    })
  ),
  resolvesAt: z.string().datetime(),
});
export type NormalizedMarket = z.infer<typeof NormalizedMarketSchema>;
```

```typescript
// packages/poly-core/src/schemas/assessment.ts — LLM structured output

export const RawAssessmentSchema = z.object({
  marketId: z.string(),
  baseRateImplication: z.string(),
  newsUpdate: z.string(),
  fairProbabilityPct: z.number().int().min(0).max(100),
  confidencePct: z.number().int().min(0).max(100),
  thesis: z.string(),
  sourcesUsed: z.array(z.string()),
});
```

```typescript
// packages/poly-core/src/schemas/signal.ts — extends generic Signal

export const MarketSignalSchema = SignalSchema.extend({
  domain: z.literal("prediction-market"),
  payload: z.object({
    probability: z.number().int().min(0).max(100),
    direction: z.enum(["bullish", "bearish"]),
    edgeBps: z.number().int(),
  }),
});
export type MarketSignal = z.infer<typeof MarketSignalSchema>;
```

```typescript
// packages/poly-core/src/schemas/api.ts — frontend response shapes
// These match BrainFeed.tsx / MarketCards.tsx / AgentStream.tsx mock types exactly

export const BrainStatusSchema = z.object({
  state: z.enum(["scanning", "analyzing", "idle"]),
  marketsScanned: z.number().int(),
  signalsGenerated: z.number().int(),
  lastHeartbeat: z.string(),
  lastTrigger: z.string().optional(),
});

export const BrainSignalsResponseSchema = z.object({
  signals: z.array(
    z.object({
      id: z.string(),
      market: z.string(),
      platform: z.enum(["Polymarket", "Kalshi", "Manifold"]),
      category: z.string(),
      probability: z.number().int().min(0).max(100),
      direction: z.enum(["bullish", "bearish"]),
      confidence: z.number().int().min(0).max(100),
      thesis: z.string(),
      sources: z.array(z.string()),
      timestamp: z.string(),
    })
  ),
  cursor: z.string().optional(),
});

export const StreamEventSchema = z.object({
  id: z.string(),
  type: z.enum(["thinking", "searching", "analyzing", "signal", "done"]),
  text: z.string(),
  timestamp: z.number(),
});
```

## B3. Thresholds + Scoring (pure functions)

```typescript
// packages/poly-core/src/thresholds.ts

/** Prediction market trigger types */
export type PolyTriggerType =
  | "price_move"
  | "volume_spike"
  | "cross_platform_spread"
  | "scheduled";

/** Price moved >5% (500bps) in 1 hour */
export function checkPriceMove(
  entityId: string,
  currentBps: number,
  oneHourAgoBps: number | null
): TriggerCheck | null {
  if (oneHourAgoBps == null) return null;
  const deltaBps = Math.abs(currentBps - oneHourAgoBps);
  if (deltaBps < 500) return null;
  return {
    type: "price_move",
    entityId,
    detail: `${deltaBps}bps in 1h`,
    priority: Math.min(100, Math.round(deltaBps / 50)), // bigger move = higher priority
  };
}

/** Volume >2x the 24h moving average */
export function checkVolumeSpike(
  entityId: string,
  recentVolume: bigint,
  avg24hVolume: bigint
): TriggerCheck | null {
  if (avg24hVolume === 0n) return null;
  const ratio = Number(recentVolume) / Number(avg24hVolume);
  if (ratio < 2.0) return null;
  return {
    type: "volume_spike",
    entityId,
    detail: `${ratio.toFixed(1)}x 24h avg`,
    priority: Math.min(100, Math.round(ratio * 20)),
  };
}

/** Same event priced >3% (300bps) apart across platforms */
export function checkCrossPlatformSpread(
  entityId: string,
  polyBps: number,
  kalshiBps: number
): TriggerCheck | null {
  const spreadBps = Math.abs(polyBps - kalshiBps);
  if (spreadBps < 300) return null;
  return {
    type: "cross_platform_spread",
    entityId,
    detail: `${spreadBps}bps spread`,
    priority: Math.min(100, Math.round(spreadBps / 20)),
  };
}

/** Score an LLM assessment into a signal (or null if no edge) */
export function scoreEdge(
  assessment: RawAssessment,
  market: NormalizedMarket,
  runId: string
): MarketSignal | null {
  const fairBps = assessment.fairProbabilityPct * 100;
  const edgeBps = fairBps - market.probabilityBps;
  const absEdge = Math.abs(edgeBps);

  if (absEdge < 500) return null; // <5% edge — not worth it

  const liquidityDiscount = market.spreadBps > 300 ? 0.8 : 1.0;
  const adjustedConfidence = Math.round(
    assessment.confidencePct * liquidityDiscount
  );

  if (adjustedConfidence < 50) return null; // too uncertain

  // Route action level based on confidence + edge size
  const actionLevel =
    adjustedConfidence >= 85 && absEdge >= 800
      ? "recommend"
      : adjustedConfidence >= 70
        ? "alert"
        : "observe";

  return {
    id: `signal:${market.id}:${runId}`,
    entityId: market.id,
    domain: "prediction-market",
    source: market.source,
    category: market.category,
    finding: `${absEdge / 100}% ${edgeBps > 0 ? "bullish" : "bearish"} edge detected`,
    thesis: assessment.thesis,
    confidencePct: adjustedConfidence,
    actionLevel,
    payload: {
      probability: Math.round(fairBps / 100),
      direction: edgeBps > 0 ? "bullish" : "bearish",
      edgeBps,
    },
    sources: assessment.sourcesUsed,
    runId,
    timestamp: new Date().toISOString(),
  };
}
```

## B4. Normalizers (pure functions)

```typescript
// packages/poly-core/src/normalizers/polymarket.ts

export function normalizePolymarketMarket(
  raw: PolymarketRawMarket,
  change24hBps: number,
  spreadBps: number
): NormalizedMarket {
  const prices: number[] = JSON.parse(raw.outcomePrices);
  const yesBps = Math.round(prices[0] * 10000);
  return {
    id: `prediction-market:polymarket:${raw.id}`,
    domain: "prediction-market",
    source: "polymarket",
    sourceId: raw.id,
    platform: "polymarket",
    title: raw.question,
    category: raw.category ?? "Other",
    attributes: { conditionId: raw.conditionId, negRisk: raw.negRisk },
    probabilityBps: yesBps,
    change24hBps,
    spreadBps,
    volume: raw.volume,
    outcomes: raw.outcomes.map((label, i) => ({
      label,
      probabilityBps: Math.round(prices[i] * 10000),
      change24hBps: 0,
    })),
    resolvesAt: raw.endDate,
    active: raw.active && !raw.closed,
    updatedAt: raw.updatedAt,
  };
}

// packages/poly-core/src/normalizers/kalshi.ts

export function normalizeKalshiMarket(
  raw: KalshiRawMarket,
  change24hBps: number,
  spreadBps: number
): NormalizedMarket {
  const yesBps = raw.yes_bid * 100;
  return {
    id: `prediction-market:kalshi:${raw.ticker}`,
    domain: "prediction-market",
    source: "kalshi",
    sourceId: raw.ticker,
    platform: "kalshi",
    title: raw.title,
    category: raw.category ?? "Other",
    attributes: { eventTicker: raw.event_ticker },
    probabilityBps: yesBps,
    change24hBps,
    spreadBps: (raw.yes_ask - raw.yes_bid) * 100,
    volume: raw.volume,
    outcomes: [
      { label: "Yes", probabilityBps: yesBps, change24hBps: 0 },
      { label: "No", probabilityBps: raw.no_bid * 100, change24hBps: 0 },
    ],
    resolvesAt: raw.expiration_time,
    active: raw.status === "open",
    updatedAt: new Date().toISOString(),
  };
}
```

## B5. Data Adapters

Live in `apps/poly/src/adapters/` (I/O — app code, not packages).

### Polymarket PollAdapter

**Source:** Gamma API (public, no auth) + CLOB API (public reads).

| Stream      | Endpoint            | Cursor       | Interval |
| ----------- | ------------------- | ------------ | -------- |
| `markets`   | `GET gamma/markets` | `updatedAt`  | 5 min    |
| `prices`    | `GET clob/price`    | — (snapshot) | 60 sec   |
| `orderbook` | `GET clob/book`     | — (snapshot) | 60 sec   |

Gotchas: `outcomePrices` is a JSON _string_. Prices are 0.0–1.0. Cap at 2 req/sec.

### Kalshi PollAdapter

**Source:** Trading API (public reads, no auth for market data).

| Stream         | Endpoint                 | Cursor            | Interval |
| -------------- | ------------------------ | ----------------- | -------- |
| `markets`      | `GET /markets`           | `cursor` (opaque) | 5 min    |
| `prices`       | `GET /markets` (bid/ask) | — (snapshot)      | 60 sec   |
| `candlesticks` | `GET /candlesticks`      | `end_ts`          | 15 min   |

Gotchas: Values in **cents** (0–100). Rate limit 20/sec. Demo env at `demo.kalshi.com`.

## B6. LangGraph: `poly-synth`

Lives in `packages/langgraph-graphs/src/graphs/poly-synth/`. NOT in `LANGGRAPH_CATALOG` (not a message-based chat agent). Follows `pr-review` pattern: `createReactAgent` + structured output, no tools.

```typescript
export function createPolySynthGraph(opts: CreateReactAgentGraphOptions) {
  return createReactAgent({
    llm: opts.llm,
    tools: [],
    messageModifier: POLY_SYNTH_SYSTEM_PROMPT,
    ...(opts.responseFormat !== undefined && {
      responseFormat: opts.responseFormat,
    }),
  });
}
```

**System prompt:**

```
You are a calibrated prediction market analyst. For each market, I provide:
- Current price (bps) and 24h price history (momentum, spread dynamics)
- Base rate: historical frequency of this event category
- Recent news: headlines and sentiment from the last 24h
- Expert forecast: Metaculus community median (if available)
- Cross-platform price: same event on another exchange (if available)

Your job per market:
1. State what the base rate implies
2. State how recent news updates the base rate (up or down, by how much)
3. State your fair probability estimate (0–100)
4. State your confidence (0–100, based on information quality)
5. Write a 2-sentence thesis

Do NOT hallucinate sources. Only reference data I provided.
Do NOT anchor to the current market price — assess independently first.
```

**Structured output:** `SynthesisOutputSchema = { assessments: RawAssessment[] }`. Batches of 5 markets per LLM call.

## B7. Temporal Wiring

The domain pack registers its activities + config with the generic workflows:

```typescript
// Poly data stream — plugs into generic DataStreamWorkflow
const polyDataStreamConfig: DataStreamConfig = {
  domain: "prediction-market",
  pollActivityName: "polyPollMarkets",
  snapshotActivityName: "polySnapshotPrices",
  evaluateTriggers: (batch) => [
    ...batch.entities.flatMap(
      (e) => checkPriceMove(e.id, e.currentBps, e.oneHourAgoBps) ?? []
    ),
    ...batch.crossPlatformPairs.flatMap(
      (p) => checkCrossPlatformSpread(p.entityId, p.polyBps, p.kalshiBps) ?? []
    ),
  ],
  entityPollInterval: { minutes: 5 },
  snapshotPollInterval: { seconds: 60 },
  budget: { maxConcurrentRuns: 2, maxLlmCallsPerHour: 12 },
};

// Poly brain run — plugs into generic AnalysisRunWorkflow
const polyAnalysisConfig: AnalysisRunConfig = {
  domain: "prediction-market",
  loadContextActivityName: "polyLoadContext",
  enrichActivityName: "polyEnrichRefs",
  synthesizeActivityName: "polySynthesize",
  scoreAssessments: (assessments, entities) =>
    assessments.flatMap((a) => {
      const market = entities.find((e) => e.id === a.marketId);
      return market ? (scoreEdge(a, market, runId) ?? []) : [];
    }),
  persistActivityName: "polyPersistSignals",
};
```

Debounce: workflowId `prediction-market-analysis:${5minBucket}`.
Scheduled fallback: every 2 hours, `overlap: SKIP`.

## B8. API Endpoints

All in `apps/poly/src/app/api/v1/poly/`. Public, no auth.

| Route                | Returns                | Source                                                           |
| -------------------- | ---------------------- | ---------------------------------------------------------------- |
| `GET /brain/status`  | `BrainStatusResponse`  | Latest `analysis_runs` + aggregates for domain=prediction-market |
| `GET /brain/signals` | `BrainSignalsResponse` | `signals` for domain=prediction-market, cursor-paginated         |
| `GET /brain/stream`  | SSE `StreamEvent`      | Redis Streams → SSE (stretch)                                    |
| `GET /markets`       | `MarketsResponse`      | `monitored_entities` + snapshot-derived change24h                |

## B9. Base Rate Seeds

Seeded via migration into `base_rates` table (domain = "prediction-market"):

| category_key                    | freq | n   | source                    |
| ------------------------------- | ---- | --- | ------------------------- |
| `economics:fed_rate_cut`        | 0.35 | 120 | FOMC 1990-2025            |
| `politics:incumbent_reelection` | 0.67 | 15  | US presidential 1960-2024 |
| `climate:cat5_hurricane_us`     | 0.08 | 50  | NHC 1975-2025             |
| `tech:product_release_on_time`  | 0.40 | 30  | Major tech releases       |
| `crypto:btc_above_threshold`    | 0.45 | 20  | BTC yearly targets        |

---

# Implementation Order

| Phase  | What                                                                      | Where             | Depends On     |
| ------ | ------------------------------------------------------------------------- | ----------------- | -------------- |
| **A0** | `packages/monitor-core` — generic schemas, focus policy                   | cogni-template PR | Nothing        |
| **A1** | `packages/db-schema/monitor` — generic tables + migration                 | cogni-template PR | Nothing        |
| **A2** | Generic Temporal workflow patterns (DataStream + AnalysisRun)             | cogni-template PR | A0             |
| **B0** | `packages/poly-core` — market schemas, normalizers, thresholds, scoreEdge | This repo         | A0             |
| **B1** | Data adapters (Polymarket + Kalshi PollAdapters)                          | This repo         | B0             |
| **B2** | `poly-synth` LangGraph graph                                              | This repo         | B0             |
| **B3** | Poly Temporal activities + workflow config                                | This repo         | A2, B0, B1, B2 |
| **B4** | API routes (status, signals, markets)                                     | This repo         | B0, A1         |
| **B5** | Frontend wiring (replace mocks)                                           | This repo         | B4             |
| **B6** | SSE stream (stretch)                                                      | This repo         | B3, B4         |

A0 + A1 are parallelizable. B0 depends on A0. B1 + B2 are parallelizable.

---

## Validation

### Part A (cogni-template)

- [ ] `packages/monitor-core` builds, exports all schemas (`pnpm packages:build`)
- [ ] `db-schema/monitor` self-contained, migration creates tables + hypertable
- [ ] Generic workflows compile with placeholder activities
- [ ] `prioritizeTriggers` respects budget limits (unit test)
- [ ] `pnpm check` passes

### Part B (polymarket)

- [ ] `packages/poly-core` extends `monitor-core` schemas correctly
- [ ] Polymarket adapter polls ≥100 markets
- [ ] Kalshi adapter polls ≥50 markets
- [ ] Price snapshots accumulate every 60 sec
- [ ] `change24h` computed from real snapshot data
- [ ] Threshold triggers fire on >5% price move (unit test)
- [ ] Temporal debounce: duplicate start within 5-min window rejected
- [ ] `poly-synth` graph returns valid `RawAssessment[]`
- [ ] `scoreEdge` filters <5% edge and <50% confidence (unit test)
- [ ] Action levels: observe < 70% conf, alert 70-85%, recommend 85%+
- [ ] All Activities idempotent (signal IDs deterministic)
- [ ] API endpoints return valid responses
- [ ] Landing page renders real data
- [ ] `pnpm check` passes
