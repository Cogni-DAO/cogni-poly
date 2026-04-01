// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/market-provider/tests/normalizers`
 * Purpose: Unit tests for Polymarket and Kalshi normalizer pure functions.
 * Scope: Tests deterministic ID generation, price conversion, and field mapping. Does not perform network I/O.
 * Invariants: OBSERVATION_IDEMPOTENT (IDs must be deterministic).
 * Side-effects: none
 * Links: work/items/task.0230.market-data-package.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import type { KalshiRawMarket } from "../src/adapters/kalshi/kalshi.types.js";
import type { PolymarketRawMarket } from "../src/adapters/polymarket/polymarket.types.js";
import { normalizeKalshiMarket } from "../src/domain/normalizers/kalshi.js";
import { normalizePolymarketMarket } from "../src/domain/normalizers/polymarket.js";
import { NormalizedMarketSchema } from "../src/domain/schemas.js";

const polymarketFixture: PolymarketRawMarket = {
  id: "abc123",
  question: "Will the Fed cut rates in June?",
  category: "Economics",
  conditionId: "cond-456",
  negRisk: false,
  outcomePrices: "[0.62, 0.38]",
  outcomes: ["Yes", "No"],
  volume: 150000,
  active: true,
  closed: false,
  endDate: "2026-06-15T00:00:00Z",
  updatedAt: "2026-03-31T12:00:00Z",
  spreadPrice: 0.02,
};

const kalshiFixture: KalshiRawMarket = {
  ticker: "FED-RATE-CUT-JUN",
  title: "Fed cuts rates at June meeting?",
  category: "Economics",
  event_ticker: "FED-JUN-2026",
  yes_bid: 60,
  yes_ask: 64,
  no_bid: 34,
  no_ask: 38,
  volume: 50000,
  status: "open",
  expiration_time: "2026-06-15T00:00:00Z",
  close_time: null,
};

describe("normalizePolymarketMarket", () => {
  it("produces a deterministic ID", () => {
    const result = normalizePolymarketMarket(polymarketFixture);
    expect(result.id).toBe("prediction-market:polymarket:abc123");
  });

  it("converts prices from 0-1 float to basis points", () => {
    const result = normalizePolymarketMarket(polymarketFixture);
    expect(result.probabilityBps).toBe(6200);
    expect(result.outcomes[0]?.probabilityBps).toBe(6200);
    expect(result.outcomes[1]?.probabilityBps).toBe(3800);
  });

  it("converts spread from 0-1 float to basis points", () => {
    const result = normalizePolymarketMarket(polymarketFixture);
    expect(result.spreadBps).toBe(200);
  });

  it("sets provider to polymarket", () => {
    const result = normalizePolymarketMarket(polymarketFixture);
    expect(result.provider).toBe("polymarket");
  });

  it("maps active status correctly", () => {
    expect(normalizePolymarketMarket(polymarketFixture).active).toBe(true);
    expect(
      normalizePolymarketMarket({ ...polymarketFixture, closed: true }).active
    ).toBe(false);
    expect(
      normalizePolymarketMarket({ ...polymarketFixture, active: false }).active
    ).toBe(false);
  });

  it("parses outcomes from JSON string", () => {
    const withJsonOutcomes = {
      ...polymarketFixture,
      outcomes: '["Yes", "No"]',
    };
    const result = normalizePolymarketMarket(withJsonOutcomes);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]?.label).toBe("Yes");
  });

  it("validates against NormalizedMarketSchema", () => {
    const result = normalizePolymarketMarket(polymarketFixture);
    expect(() => NormalizedMarketSchema.parse(result)).not.toThrow();
  });
});

describe("normalizeKalshiMarket", () => {
  it("produces a deterministic ID", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(result.id).toBe("prediction-market:kalshi:FED-RATE-CUT-JUN");
  });

  it("converts prices from cents to basis points", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(result.probabilityBps).toBe(6000); // 60 cents * 100
  });

  it("calculates spread from bid/ask in basis points", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(result.spreadBps).toBe(400); // (64 - 60) * 100
  });

  it("sets provider to kalshi", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(result.provider).toBe("kalshi");
  });

  it("maps open status to active=true", () => {
    expect(normalizeKalshiMarket(kalshiFixture).active).toBe(true);
    expect(
      normalizeKalshiMarket({ ...kalshiFixture, status: "closed" }).active
    ).toBe(false);
  });

  it("always produces Yes/No outcomes", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]?.label).toBe("Yes");
    expect(result.outcomes[1]?.label).toBe("No");
  });

  it("clamps spread to non-negative", () => {
    const invertedSpread = { ...kalshiFixture, yes_bid: 64, yes_ask: 60 };
    const result = normalizeKalshiMarket(invertedSpread);
    expect(result.spreadBps).toBe(0);
  });

  it("validates against NormalizedMarketSchema", () => {
    const result = normalizeKalshiMarket(kalshiFixture);
    expect(() => NormalizedMarketSchema.parse(result)).not.toThrow();
  });
});
