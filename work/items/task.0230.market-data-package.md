---
id: task.0230
type: task
title: "market-provider package — port, domain types, Polymarket + Kalshi adapters"
status: needs_closeout
priority: 1
rank: 1
estimate: 3
summary: Create @cogni/market-provider package with MarketProviderPort interface, normalized market Zod schemas, and REST adapters for Polymarket (Gamma + CLOB) and Kalshi (Trading API). Multi-tenant auth aligned with tenant-connections spec.
outcome: Any runtime can list live prediction market data from Polymarket and Kalshi through a typed port interface. Auth is tenant-scoped (system account for reads, per-tenant for trading later). Data pipeline adapters delegate to this port.
spec_refs:
  - monitoring-engine-spec
  - task.0227
  - spec.tenant-connections
  - identity-model-spec
assignees: derekg1729
credit:
project: proj.poly-prediction-bot
branch: feat/market-provider-package
pr:
reviewer:
revision: 1
blocked_by:
deploy_verified: false
created: 2026-03-31
updated: 2026-03-31
labels: [poly, prediction-markets, packages, multi-tenant]
external_refs:
---

# market-provider package — Port, Domain Types, Polymarket + Kalshi Adapters

## Design

### Outcome

Any Cogni runtime can read live prediction market data from Polymarket and Kalshi through a typed `MarketProviderPort`. Auth is tenant-scoped: a system connection for public reads (Crawl), per-tenant connections for trading (Run). The data pipeline's `PollAdapter` delegates to this same port — one platform abstraction, not two.

### Approach

**Solution**: New `packages/market-provider/` following the `operator-wallet` pattern. The port covers the full provider lifecycle (read now, trade later). Adapters take constructor-injected config (base URLs, rate limits) and a `credentials` parameter aligned with the `connections` table schema from tenant-connections spec. Raw `fetch` + Zod response validation.

**Key architectural decision — one abstraction, two consumers:**

```
MarketProviderPort (this package)
  ├── API routes: adapter.listMarkets() → JSON to landing page
  └── PollAdapter (Walk): collect() calls adapter.listMarkets() + getPrices()
                           → produces ObservationEvent[] into monitoring pipeline
```

The data pipeline's `PollAdapter` is a thin wrapper that calls `MarketProviderPort` methods and maps the results to `ObservationEvent[]`. No parallel HTTP clients. This resolves the `SINGLE_INGESTION_SUBSTRATE` concern — the market provider IS the platform abstraction; the PollAdapter just maps its output.

**Reuses**:

- `operator-wallet` package pattern (port + subpath adapter exports, tsup, tsc -b)
- `ingestion-core` helpers (`buildEventId`, `hashCanonicalPayload`) for deterministic IDs
- Normalizer logic from task.0227 §B4
- Tenant connections model (spec.tenant-connections): `connectionId`, `provider`, encrypted credentials, `billing_account_id` scoping

**Rejected alternatives**:

- `MarketDataPort` (read-only) — dead end. The same adapter that reads markets will place trades in Run. One port for the full provider lifecycle.
- `@polymarket/clob-client` SDK — overkill for read-only; warranted in Run for order placement.
- Credentials in constructor config — violates tenant-connections model. Credentials come from connection broker (or env shim for prototype).

### Auth Model

Aligned with [tenant-connections spec](cogni-template:docs/spec/tenant-connections.md):

```
connections table
  provider: "polymarket" | "kalshi"
  credential_type: "api_key" | "wallet_signing"
  billing_account_id: system | per-tenant
  encrypted_credentials: AEAD blob
```

**Crawl v0**: System-level credentials loaded from env → injected into adapter at bootstrap. No connection broker needed yet.

**Walk/Run**: Per-tenant connections resolved by connection broker at invocation time. Adapter receives `MarketCredentials` per-call for tenant-scoped operations.

The port interface accepts an optional `credentials` parameter. System reads use the default (constructor-injected). Tenant operations pass explicit credentials:

```typescript
export interface MarketProviderPort {
  readonly provider: MarketProvider;

  /** List active markets. Uses system credentials by default. */
  listMarkets(params?: ListMarketsParams): Promise<NormalizedMarket[]>;

  // Walk: getPrices(), getOrderbook() — added when pipeline needs them
  // Run: placeOrder(), getPositions() — added when trading starts
}
```

**Crawl ships with `listMarkets()` only.** Additional methods added when callers need them (YAGNI).

### Invariants

- [ ] ADAPTERS_NOT_IN_CORE: Port in `src/port/`, adapters in `src/adapters/{polymarket,kalshi}/` (spec: architecture)
- [ ] PACKAGES_NO_ENV: No `process.env` in package. Credentials injected via constructor config (spec: architecture)
- [ ] PACKAGES_NO_LIFECYCLE: No startup/shutdown (spec: architecture)
- [ ] CONNECTION_ID_ONLY: No raw tokens in port interface. Credentials abstracted behind `MarketCredentials` type (spec: tenant-connections)
- [ ] TENANT_SCOPED: Credentials scoped to `billing_account_id`. System account for reads, per-tenant for trades (spec: identity-model)
- [ ] OBSERVATION_IDEMPOTENT: Market IDs deterministic: `prediction-market:{platform}:{sourceId}` (spec: monitoring-engine)
- [ ] SINGLE_INGESTION_SUBSTRATE: PollAdapter delegates to MarketProviderPort, not parallel HTTP (spec: monitoring-engine)
- [ ] SIMPLE_SOLUTION: Raw fetch + Zod, 1 method for Crawl, ~10 source files

### Files

```
packages/market-provider/
  src/
    index.ts                                — barrel: port + domain types + normalizers
    port/
      market-provider.port.ts               — MarketProviderPort interface + MarketCredentials
    domain/
      schemas.ts                            — Zod: MarketProvider, NormalizedMarket, ListMarketsParams
      normalizers/
        polymarket.ts                       — normalizePolymarketMarket() pure fn
        kalshi.ts                           — normalizeKalshiMarket() pure fn
    adapters/
      polymarket/
        index.ts                            — exports
        polymarket.adapter.ts               — implements MarketProviderPort (fetch + normalize)
        polymarket.types.ts                 — PolymarketRawMarket Zod schema
      kalshi/
        index.ts                            — exports
        kalshi.adapter.ts                   — implements MarketProviderPort (fetch + normalize)
        kalshi.types.ts                     — KalshiRawMarket Zod schema
  package.json
  tsconfig.json
  tsup.config.ts
  AGENTS.md
```

11 source files. Each adapter is a single file (fetch + normalize + port impl) — no separate client layer.

## Port Interface

```typescript
// packages/market-provider/src/port/market-provider.port.ts

import type { z } from "zod";

export const MarketProviderSchema = z.enum(["polymarket", "kalshi"]);
export type MarketProvider = z.infer<typeof MarketProviderSchema>;

/**
 * Credentials abstraction — resolved from connections table or env shim.
 * Intentionally opaque: adapters interpret per-provider.
 * CONNECTION_ID_ONLY: callers never see raw tokens.
 */
export interface MarketCredentials {
  /** For API key auth (Kalshi) */
  readonly apiKey?: string;
  readonly apiSecret?: string;
  /** For wallet signing auth (Polymarket trading — Run phase) */
  readonly walletKey?: string;
}

/** Config injected at construction — no env loading in adapters */
export interface MarketProviderConfig {
  /** System-level credentials for public reads */
  credentials?: MarketCredentials;
  /** Override base URLs for testing */
  baseUrl?: string;
}

export interface MarketProviderPort {
  readonly provider: MarketProvider;

  /**
   * List active markets from this provider.
   * Uses constructor-injected system credentials by default.
   * Accepts explicit credentials for tenant-scoped access.
   */
  listMarkets(params?: ListMarketsParams): Promise<NormalizedMarket[]>;
}
```

## Domain Types

```typescript
// packages/market-provider/src/domain/schemas.ts

export const NormalizedMarketSchema = z.object({
  /** Deterministic: "prediction-market:{platform}:{sourceId}" */
  id: z.string(),
  provider: MarketProviderSchema,
  sourceId: z.string(),
  title: z.string(),
  category: z.string(),
  /** YES probability in basis points (0–10000) */
  probabilityBps: z.number().int().min(0).max(10000),
  /** Bid-ask spread in basis points */
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
  /** Platform-specific fields (conditionId, eventTicker, etc.) */
  attributes: z.record(z.unknown()),
  updatedAt: z.string().datetime(),
});
export type NormalizedMarket = z.infer<typeof NormalizedMarketSchema>;

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

## Adapter Config

```typescript
// Polymarket — public reads, no credentials needed for Crawl
new PolymarketAdapter({
  baseUrl: "https://gamma-api.polymarket.com", // default
});

// Kalshi — requires API key for all endpoints
new KalshiAdapter({
  baseUrl: "https://trading-api.kalshi.com/trade-api/v2", // default
  credentials: { apiKey: "...", apiSecret: "..." },
});
```

## API Details

### Polymarket

| Endpoint                               | Purpose                   | Auth                | Rate Limit |
| -------------------------------------- | ------------------------- | ------------------- | ---------- |
| `GET gamma-api.polymarket.com/markets` | Market listing + metadata | None (public)       | 2 req/sec  |
| `GET clob.polymarket.com/price`        | Current prices (Walk)     | None (public reads) | 2 req/sec  |

Gotchas: `outcomePrices` is a JSON **string**. Prices 0.0–1.0 → multiply by 10000 for bps.

### Kalshi

| Endpoint                             | Purpose                 | Auth             | Rate Limit |
| ------------------------------------ | ----------------------- | ---------------- | ---------- |
| `GET /trade-api/v2/markets`          | Market listing + prices | API key required | 20 req/sec |
| `GET /trade-api/v2/markets/{ticker}` | Single market detail    | API key required | 20 req/sec |

Gotchas: Values in **cents** (0–100) → multiply by 100 for bps. Opaque cursor pagination. **All endpoints require auth** (confirmed via live API test — 401 without credentials).

## Env Config (Crawl v0 prototype)

Add to `.env.local`:

```bash
# ── Market Provider: Polymarket ──
# Public reads — no credentials needed for Gamma API
POLYMARKET_GAMMA_BASE_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_BASE_URL=https://clob.polymarket.com

# ── Market Provider: Kalshi ──
# Required for ALL endpoints (even market listing)
# Get from: https://kalshi.com/settings/api
KALSHI_API_KEY=
KALSHI_API_SECRET=
KALSHI_BASE_URL=https://trading-api.kalshi.com/trade-api/v2
```

These are loaded at bootstrap (app/service code), NOT inside the package. The adapter receives them via `MarketProviderConfig`.

## Data Pipeline Reconciliation

When Walk adds the monitoring pipeline, `PollAdapter` wraps `MarketProviderPort`:

```typescript
// services/scheduler-worker/src/adapters/ingestion/polymarket-poll.adapter.ts
// This is Walk scope — NOT in this task

class PolymarketPollAdapter implements PollAdapter {
  constructor(private market: MarketProviderPort) {}

  async collect(params: CollectParams): Promise<CollectResult> {
    const markets = await this.market.listMarkets({ cursor: params.cursor?.value });
    const observations: ObservationEvent[] = markets.map(m => ({
      id: buildEventId("polymarket", "obs", m.sourceId, now),
      source: "polymarket",
      entityId: m.id,
      entityTitle: m.title,
      category: m.category,
      values: { probabilityBps: m.probabilityBps, spreadBps: m.spreadBps, volumeUsd: m.volume },
      metadata: m.attributes,
      payloadHash: await hashCanonicalPayload({ ...m }),
      observedAt: new Date(),
    }));
    return { events: [], observations, nextCursor: ... };
  }
}
```

One HTTP client per platform. PollAdapter is a thin mapping layer.

## Requirements

- `@cogni/market-provider` package builds cleanly (`pnpm packages:build`)
- Root barrel exports port + domain types + normalizers (zero adapter deps)
- Subpath `./adapters/polymarket` exports `PolymarketAdapter`
- Subpath `./adapters/kalshi` exports `KalshiAdapter`
- Both adapters implement `MarketProviderPort` with `listMarkets()`
- Polymarket adapter fetches from Gamma API (public, no auth)
- Kalshi adapter authenticates with API key from constructor config
- Normalizers are pure functions with unit tests
- AGENTS.md documents package boundaries
- `pnpm check` passes

## Allowed Changes

- Create: `packages/market-provider/` (entire new package)
- Modify: root `package.json` (add workspace dep)
- Modify: root `tsconfig.json` (add project reference)
- Create: `.env.local.example` entries for Kalshi credentials

## Plan

- [ ] Scaffold package: `package.json`, `tsconfig.json`, `tsup.config.ts`, `AGENTS.md`
- [ ] Domain types: `schemas.ts` (NormalizedMarket, ListMarketsParams, MarketProvider)
- [ ] Port interface: `market-provider.port.ts` (MarketProviderPort, MarketCredentials, MarketProviderConfig)
- [ ] Raw types: `polymarket.types.ts`, `kalshi.types.ts` (Zod response schemas)
- [ ] Normalizers: `polymarket.ts`, `kalshi.ts` (pure functions + unit tests)
- [ ] Polymarket adapter: `polymarket.adapter.ts` (Gamma API fetch + normalize)
- [ ] Kalshi adapter: `kalshi.adapter.ts` (Trading API fetch + normalize + API key auth)
- [ ] Barrel exports: `index.ts` + adapter subpath `index.ts` files
- [ ] Wire into monorepo: root package.json, tsconfig.json references
- [ ] Add env entries to `.env.local.example`
- [ ] Unit tests for normalizers and Zod schemas
- [ ] `pnpm check` passes

## Validation

**Command:**

```bash
# Package builds
pnpm packages:build

# Unit tests pass
pnpm test packages/market-provider/

# Full CI check
pnpm check
```

**Expected:** Package builds, exports resolve, normalizer tests pass, `pnpm check` clean.

## Review Checklist

- [ ] **Work Item:** `task.0230` linked in PR body
- [ ] **Spec:** tenant-connections invariants upheld (CONNECTION_ID_ONLY, TENANT_SCOPED)
- [ ] **Spec:** monitoring-engine invariants upheld (OBSERVATION_IDEMPOTENT, SINGLE_INGESTION_SUBSTRATE plan)
- [ ] **Spec:** identity-model invariants upheld (billing_account_id scoping)
- [ ] **Tests:** normalizer unit tests, Zod schema validation tests
- [ ] **Reviewer:** assigned and approved

## PR / Links

- Design source: task.0227 §B2 (schemas), §B4 (normalizers), §B5 (adapters)
- Architecture pattern: `packages/operator-wallet/` (port + subpath adapters)
- Auth model: [tenant-connections spec](cogni-template:docs/spec/tenant-connections.md)
- Identity model: [identity-model spec](cogni-template:docs/spec/identity-model.md)
- Monitoring engine: `docs/spec/monitoring-engine.md`
- Project: proj.poly-prediction-bot (Crawl P0)

## Attribution

- derekg1729 — design and implementation
