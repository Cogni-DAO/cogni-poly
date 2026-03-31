// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/market-provider`
 * Purpose: Validate MarketProviderPort adapters against live Polymarket + Kalshi APIs.
 * Scope: Read-only market listing via the port interface — same path the AI brain will use. Does not place trades.
 * Invariants: OBSERVATION_IDEMPOTENT (IDs deterministic), READ-ONLY (no POST/PUT).
 * Side-effects: IO (HTTP to Polymarket Gamma API, Kalshi Trading API)
 * Links: packages/market-provider/, work/items/task.0230.market-data-package.md
 * @internal
 */

import type {
  MarketProviderPort,
  NormalizedMarket,
} from "@cogni/market-provider";
import { NormalizedMarketSchema } from "@cogni/market-provider";
import { KalshiAdapter } from "@cogni/market-provider/adapters/kalshi";
import { PolymarketAdapter } from "@cogni/market-provider/adapters/polymarket";
import { describe, expect, it } from "vitest";

// ── Polymarket (public, no credentials needed) ──

describe("PolymarketAdapter (external)", () => {
  const adapter: MarketProviderPort = new PolymarketAdapter();

  it("listMarkets() returns normalized markets from live Gamma API", async () => {
    const markets = await adapter.listMarkets({ limit: 5 });

    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(5);

    for (const m of markets) {
      // Validates full Zod schema
      expect(() => NormalizedMarketSchema.parse(m)).not.toThrow();

      // Deterministic ID format (OBSERVATION_IDEMPOTENT)
      expect(m.id).toMatch(/^prediction-market:polymarket:.+$/);
      expect(m.provider).toBe("polymarket");
      expect(m.sourceId).toBeTruthy();
      expect(m.title).toBeTruthy();

      // Basis points in valid range
      expect(m.probabilityBps).toBeGreaterThanOrEqual(0);
      expect(m.probabilityBps).toBeLessThanOrEqual(10000);
      expect(m.spreadBps).toBeGreaterThanOrEqual(0);

      // Has outcomes
      expect(m.outcomes.length).toBeGreaterThanOrEqual(2);
    }
  }, 15_000);

  it("listMarkets() with search returns relevant results", async () => {
    const markets = await adapter.listMarkets({
      search: "president",
      limit: 3,
    });

    // May return 0 if no matches — that's ok
    for (const m of markets) {
      expect(() => NormalizedMarketSchema.parse(m)).not.toThrow();
    }
  }, 15_000);
});

// ── Kalshi (requires KALSHI_API_KEY + KALSHI_API_SECRET) ──

const KALSHI_API_KEY = process.env.KALSHI_API_KEY ?? "";
const KALSHI_API_SECRET = process.env.KALSHI_API_SECRET ?? "";
const skipKalshi = !KALSHI_API_KEY || !KALSHI_API_SECRET;

describe.skipIf(skipKalshi)("KalshiAdapter (external)", () => {
  const adapter: MarketProviderPort = new KalshiAdapter({
    credentials: {
      apiKey: KALSHI_API_KEY,
      apiSecret: KALSHI_API_SECRET,
    },
  });

  it("listMarkets() returns normalized markets from live Trading API", async () => {
    const markets = await adapter.listMarkets({ limit: 5 });

    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(5);

    for (const m of markets) {
      expect(() => NormalizedMarketSchema.parse(m)).not.toThrow();

      // Deterministic ID format (OBSERVATION_IDEMPOTENT)
      expect(m.id).toMatch(/^prediction-market:kalshi:.+$/);
      expect(m.provider).toBe("kalshi");
      expect(m.sourceId).toBeTruthy();
      expect(m.title).toBeTruthy();

      // Basis points in valid range
      expect(m.probabilityBps).toBeGreaterThanOrEqual(0);
      expect(m.probabilityBps).toBeLessThanOrEqual(10000);
      expect(m.spreadBps).toBeGreaterThanOrEqual(0);

      // Kalshi always has Yes/No
      expect(m.outcomes).toHaveLength(2);
    }
  }, 15_000);
});

// ── Cross-platform: same port interface, different providers ──

describe.skipIf(skipKalshi)(
  "MarketProviderPort cross-platform (external)",
  () => {
    const providers: MarketProviderPort[] = [
      new PolymarketAdapter(),
      new KalshiAdapter({
        credentials: {
          apiKey: KALSHI_API_KEY,
          apiSecret: KALSHI_API_SECRET,
        },
      }),
    ];

    it("all providers return NormalizedMarket[] through the same port interface", async () => {
      const results: NormalizedMarket[][] = await Promise.all(
        providers.map((p) => p.listMarkets({ limit: 3 }))
      );

      for (const markets of results) {
        expect(markets.length).toBeGreaterThan(0);
        for (const m of markets) {
          expect(() => NormalizedMarketSchema.parse(m)).not.toThrow();
        }
      }

      // Different providers
      const providerNames = results.map((r) => r[0]?.provider);
      expect(providerNames).toContain("polymarket");
      expect(providerNames).toContain("kalshi");
    }, 20_000);
  }
);
