---
id: task.0230
type: task
title: "market-data package — port, domain types, Polymarket + Kalshi adapters"
status: needs_implement
priority: 1
rank: 1
estimate: 3
summary: Create @cogni/market-data package with MarketDataPort interface, normalized market Zod schemas, and REST adapters for Polymarket (Gamma + CLOB) and Kalshi (Trading API).
outcome: Any runtime can list, search, and read live prediction market data from Polymarket and Kalshi through a single typed port interface with zero platform leakage.
spec_refs:
  - monitoring-engine-spec
  - task.0227
assignees: derekg1729
credit:
project: proj.poly-prediction-bot
branch: feat/market-data-package
pr:
reviewer:
revision: 0
blocked_by:
deploy_verified: false
created: 2026-03-31
updated: 2026-03-31
labels: [poly, prediction-markets, packages]
external_refs:
---

# market-data package — Port, Domain Types, Polymarket + Kalshi Adapters

## Design

### Outcome

Any Cogni runtime (Next.js API route, Temporal worker, CLI script) can read live prediction market data from Polymarket and Kalshi through a typed `MarketDataPort` — no platform-specific code leaks to callers.

### Approach

**Solution**: New `packages/market-data/` following the `operator-wallet` pattern — port interface + domain types in root barrel, platform adapters in subpath exports. Raw `fetch` + Zod response validation. Constructor-injected config (no env loading in adapters).

**Reuses**:

- `operator-wallet` package pattern (port + subpath adapter exports, tsup, tsc -b)
- `ingestion-core` helpers (`buildEventId`, `hashCanonicalPayload`) for deterministic IDs
- Normalizer logic from task.0227 §B4 (already designed, just needs implementation)
- Raw API schema from task.0227 §B5 (Gamma/CLOB/Trading API endpoints documented)

**Rejected alternatives**:

- `@polymarket/clob-client` SDK — adds dep weight for read-only use; Gamma API is simpler for market listing; raw fetch is consistent with Kalshi (no SDK). The CLOB client is warranted later for order placement (Run phase).
- Implementing full `PollAdapter` from `ingestion-core` now — `PollAdapter.collect()` is for incremental background sync (cursor + time window). Crawl needs synchronous list/search/read. PollAdapter compliance comes in Walk when Temporal workflows drive scheduled polling.
- Single package `poly-core` with thresholds + scoring + normalizers + adapters — too broad for Crawl. Thresholds and scoring are Walk scope. `market-data` is the read layer; analysis layers build on top.

### Invariants

- [ ] ADAPTERS_NOT_IN_CORE: Port in `src/port/`, adapters in `src/adapters/{polymarket,kalshi}/` (spec: architecture)
- [ ] PACKAGES_NO_ENV: All adapter config via constructor injection — no `process.env` (spec: architecture)
- [ ] PACKAGES_NO_LIFECYCLE: No startup/shutdown — callers manage adapter lifecycle (spec: architecture)
- [ ] PACKAGES_NO_SRC_IMPORTS: No imports from `src/` or `apps/` (spec: architecture)
- [ ] OBSERVATION_IDEMPOTENT: Market IDs are deterministic: `prediction-market:{platform}:{sourceId}` (spec: monitoring-engine)
- [ ] SIMPLE_SOLUTION: Raw fetch + Zod, no SDK deps, follows `operator-wallet` pattern exactly
- [ ] ARCHITECTURE_ALIGNMENT: Port + subpath adapters, tsup ESM, tsc -b declarations

### Files

```
packages/market-data/
  src/
    index.ts                          — barrel: port + domain types + normalizers
    port/
      market-data.port.ts             — MarketDataPort interface
    domain/
      schemas.ts                      — Zod: Platform, NormalizedMarket, MarketSnapshot, ListMarketsParams
      normalizers/
        polymarket.ts                 — normalizePolymarketMarket() pure fn
        kalshi.ts                     — normalizeKalshiMarket() pure fn
    adapters/
      polymarket/
        index.ts                      — PolymarketAdapter (exports)
        polymarket.adapter.ts         — implements MarketDataPort
        polymarket.client.ts          — raw REST client (Gamma + CLOB fetch)
        polymarket.types.ts           — PolymarketRawMarket Zod schema
      kalshi/
        index.ts                      — KalshiAdapter (exports)
        kalshi.adapter.ts             — implements MarketDataPort
        kalshi.client.ts              — raw REST client (Trading API fetch)
        kalshi.types.ts               — KalshiRawMarket Zod schema
  package.json                        — @cogni/market-data, subpath exports
  tsconfig.json                       — composite, declaration
  tsup.config.ts                      — ESM, entry: [index, adapters/polymarket, adapters/kalshi]
  AGENTS.md                           — package boundaries
```

## Port Interface

```typescript
// packages/market-data/src/port/market-data.port.ts

export interface MarketDataPort {
  /** Platform this adapter serves */
  readonly platform: Platform;

  /** List active markets, optionally filtered by category/search */
  listMarkets(params?: ListMarketsParams): Promise<NormalizedMarket[]>;

  /** Get a single market by platform-specific source ID */
  getMarket(sourceId: string): Promise<NormalizedMarket | null>;

  /** Get current price snapshots for one or more markets */
  getPrices(sourceIds: string[]): Promise<MarketSnapshot[]>;
}
```

## Domain Types

```typescript
// packages/market-data/src/domain/schemas.ts

export const PlatformSchema = z.enum(["polymarket", "kalshi"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const NormalizedMarketSchema = z.object({
  /** Deterministic: "prediction-market:{platform}:{sourceId}" */
  id: z.string(),
  platform: PlatformSchema,
  sourceId: z.string(),
  title: z.string(),
  category: z.string(),
  probabilityBps: z.number().int().min(0).max(10000),
  spreadBps: z.number().int().min(0),
  volume: z.number(),
  outcomes: z.array(
    z.object({
      label: z.string(),
      probabilityBps: z.number().int().min(0).max(10000),
    })
  ),
  resolvesAt: z.string().datetime(),
  active: z.boolean(),
  /** Platform-specific extra fields */
  attributes: z.record(z.unknown()),
  updatedAt: z.string().datetime(),
});
export type NormalizedMarket = z.infer<typeof NormalizedMarketSchema>;

export const MarketSnapshotSchema = z.object({
  sourceId: z.string(),
  platform: PlatformSchema,
  probabilityBps: z.number().int().min(0).max(10000),
  bestBidBps: z.number().int().min(0).max(10000),
  bestAskBps: z.number().int().min(0).max(10000),
  spreadBps: z.number().int().min(0),
  snapshotAt: z.string().datetime(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const ListMarketsParamsSchema = z
  .object({
    category: z.string().optional(),
    search: z.string().optional(),
    activeOnly: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  })
  .optional();
export type ListMarketsParams = z.infer<typeof ListMarketsParamsSchema>;
```

## Adapter Config (constructor-injected)

```typescript
// Polymarket
export interface PolymarketAdapterConfig {
  gammaBaseUrl?: string; // default: "https://gamma-api.polymarket.com"
  clobBaseUrl?: string; // default: "https://clob.polymarket.com"
  maxRequestsPerSec?: number; // default: 2
}

// Kalshi
export interface KalshiAdapterConfig {
  baseUrl?: string; // default: "https://trading-api.kalshi.com/trade-api/v2"
  maxRequestsPerSec?: number; // default: 20
}
```

## API Details (from task.0227 §B5)

### Polymarket

| Endpoint                               | Purpose                    | Auth                | Rate Limit |
| -------------------------------------- | -------------------------- | ------------------- | ---------- |
| `GET gamma-api.polymarket.com/markets` | Market listing + metadata  | None (public)       | 2 req/sec  |
| `GET clob.polymarket.com/price`        | Current prices             | None (public reads) | 2 req/sec  |
| `GET clob.polymarket.com/book`         | Order book (bid/ask depth) | None (public reads) | 2 req/sec  |

Gotchas: `outcomePrices` is a JSON **string** (not parsed). Prices 0.0–1.0 scale → multiply by 10000 for bps.

### Kalshi

| Endpoint                                                   | Purpose                 | Auth                | Rate Limit |
| ---------------------------------------------------------- | ----------------------- | ------------------- | ---------- |
| `GET trading-api.kalshi.com/trade-api/v2/markets`          | Market listing + prices | None (public reads) | 20 req/sec |
| `GET trading-api.kalshi.com/trade-api/v2/markets/{ticker}` | Single market detail    | None (public reads) | 20 req/sec |

Gotchas: Values in **cents** (0–100, not bps) → multiply by 100 for bps. Opaque cursor pagination.

## Requirements

- `@cogni/market-data` package builds cleanly (`pnpm packages:build`)
- Root barrel exports port + domain types + normalizers (zero adapter deps)
- Subpath `./adapters/polymarket` exports `PolymarketAdapter`
- Subpath `./adapters/kalshi` exports `KalshiAdapter`
- Both adapters implement `MarketDataPort`
- `listMarkets()` returns `NormalizedMarket[]` from each platform's API
- `getPrices()` returns `MarketSnapshot[]` with current bid/ask/spread
- Normalizers are pure functions with unit tests
- Adapters use constructor-injected config (no env loading)
- Rate limiting built into adapter clients (not caller responsibility)
- AGENTS.md documents package boundaries and public surface
- `pnpm check` passes

## Allowed Changes

- Create: `packages/market-data/` (entire new package)
- Modify: root `package.json` (add workspace dep)
- Modify: root `tsconfig.json` (add project reference)
- Modify: `pnpm-workspace.yaml` (if needed — likely already has `packages/*` glob)

## Plan

- [ ] Scaffold package: `package.json`, `tsconfig.json`, `tsup.config.ts`, `AGENTS.md`
- [ ] Domain types: `schemas.ts` with Zod schemas (NormalizedMarket, MarketSnapshot, Platform, ListMarketsParams)
- [ ] Port interface: `market-data.port.ts`
- [ ] Raw types: `polymarket.types.ts`, `kalshi.types.ts` (Zod schemas for API responses)
- [ ] Normalizers: `polymarket.ts`, `kalshi.ts` (pure functions + unit tests)
- [ ] Polymarket client: `polymarket.client.ts` (Gamma + CLOB fetch with rate limiting)
- [ ] Polymarket adapter: `polymarket.adapter.ts` (implements MarketDataPort)
- [ ] Kalshi client: `kalshi.client.ts` (Trading API fetch with rate limiting)
- [ ] Kalshi adapter: `kalshi.adapter.ts` (implements MarketDataPort)
- [ ] Barrel exports: `index.ts` + adapter subpath `index.ts` files
- [ ] Wire into monorepo: root package.json, tsconfig.json references
- [ ] Unit tests for normalizers and Zod schemas
- [ ] Integration smoke test (live API call, can be skipped in CI)
- [ ] `pnpm check` passes

## Validation

**Command:**

```bash
# Package builds
pnpm packages:build

# Unit tests pass
pnpm test packages/market-data/

# Full CI check
pnpm check
```

**Expected:** Package builds, exports resolve, normalizer tests pass, `pnpm check` clean.

## Review Checklist

- [ ] **Work Item:** `task.0230` linked in PR body
- [ ] **Spec:** monitoring-engine-spec invariants upheld (OBSERVATION_IDEMPOTENT IDs)
- [ ] **Tests:** normalizer unit tests, Zod schema validation tests
- [ ] **Reviewer:** assigned and approved

## PR / Links

- Design source: task.0227 §B2 (schemas), §B4 (normalizers), §B5 (adapters)
- Architecture pattern: `packages/operator-wallet/` (port + subpath adapters)
- Monitoring engine: `docs/spec/monitoring-engine.md`
- Project: proj.poly-prediction-bot (Crawl P0)

## Attribution

- derekg1729 — design and implementation
