// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/unit/scripts/tenant-matrix-evaluator.test.ts`
 * Purpose: Cover the pure metric calculators + tenant discovery half-block
 *   detection in `nodes/poly/scripts/tenant-matrix-evaluator.ts`. These are
 *   the load-bearing pieces the LLM finding depends on for sample-size flags
 *   and A/B deltas; the HTTP/SQL plumbing is integration territory.
 * Scope: No network. Fixture data only.
 * @public
 */

import { describe, expect, it } from "vitest";
import {
  aggregateDecisions,
  aggregateFillsForTarget,
  compareTenants,
  discoverTenants,
  filterMarketsByTargetWallet,
  isLowSample,
  placementRate,
  type TenantMetrics,
} from "../../../../scripts/tenant-matrix-evaluator";

const baseFills: TenantMetrics["fills"] = {
  markets_count: 0,
  markets_with_open_position: 0,
  fills_count: 0,
  filled_count: 0,
  intent_usdc: 0,
  realized_size_usdc: 0,
};

const baseDecisions: TenantMetrics["decisions"] = {
  decisions: 0,
  placed: 0,
  skipped: 0,
  errored: 0,
  skip_reasons: {},
  error_reasons: {},
};

function mkMetrics(
  prefix: string,
  envSlug: TenantMetrics["tenant"]["envSlug"],
  role: string,
  overrides: Partial<TenantMetrics>
): TenantMetrics {
  return {
    tenant: {
      envLabel: envSlug.toUpperCase().replace("-", "_"),
      role,
      envSlug,
      billingAccountId: "00000000-0000-0000-0000-000000000000",
      envKeyPrefix: prefix,
    },
    target_id: "11111111-1111-5111-9111-111111111111",
    target_wallet: "0x0000000000000000000000000000000000000000",
    window: { since: "2026-05-17T00:00:00Z", until: "2026-05-18T00:00:00Z" },
    decisions: { ...baseDecisions },
    placement_rate: null,
    fills: { ...baseFills },
    markets: [],
    low_sample: false,
    errors: [],
    ...overrides,
  };
}

describe("discoverTenants", () => {
  it("pairs API_KEY + BILLING_ACCOUNT_ID into one tenant per env-key prefix", () => {
    const env = {
      POLY_PROD_TENANT_LIVE_API_KEY: "k1",
      POLY_PROD_TENANT_LIVE_BILLING_ACCOUNT_ID:
        "aaaaaaaa-0000-0000-0000-000000000001",
      POLY_PREVIEW_TENANT_TRUST_TWIN_API_KEY: "k2",
      POLY_PREVIEW_TENANT_TRUST_TWIN_BILLING_ACCOUNT_ID:
        "aaaaaaaa-0000-0000-0000-000000000002",
    } as unknown as NodeJS.ProcessEnv;
    const { tenants, errors } = discoverTenants(env);
    expect(errors).toEqual([]);
    expect(tenants).toHaveLength(2);
    const prod = tenants.find((t) => t.envSlug === "production");
    expect(prod?.role).toBe("LIVE");
    expect(prod?.apiBaseUrl).toBe("https://poly.cognidao.org");
    expect(prod?.dsUid).toBe("cogni-production-poly-postgres");
    const prev = tenants.find((t) => t.envSlug === "preview");
    expect(prev?.role).toBe("TRUST_TWIN");
    expect(prev?.dsUid).toBe("cogni-preview-poly-postgres");
  });

  it("detects half-block: API_KEY without BILLING_ACCOUNT_ID", () => {
    const env = {
      POLY_PROD_TENANT_LIVE_API_KEY: "k1",
      // billing_account_id missing
    } as unknown as NodeJS.ProcessEnv;
    const { tenants, errors } = discoverTenants(env);
    expect(tenants).toEqual([]);
    expect(errors).toContainEqual({
      envKeyPrefix: "POLY_PROD_TENANT_LIVE",
      missing: "BILLING_ACCOUNT_ID",
    });
  });

  it("ignores non-tenant POLY_* env vars", () => {
    const env = {
      POLY_CLOB_GEO_BLOCK_TOKEN: "xyz",
      POLY_WALLET_AEAD_KEY_HEX: "deadbeef",
      POLY_PROD_TENANT_LIVE_API_KEY: "k1",
      POLY_PROD_TENANT_LIVE_BILLING_ACCOUNT_ID:
        "aaaaaaaa-0000-0000-0000-000000000001",
    } as unknown as NodeJS.ProcessEnv;
    const { tenants, errors } = discoverTenants(env);
    expect(errors).toEqual([]);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.role).toBe("LIVE");
  });

  it("maps CANDIDATE_A → candidate-a slug + dsUid", () => {
    const env = {
      POLY_CANDIDATE_A_TENANT_GAP_API_KEY: "k",
      POLY_CANDIDATE_A_TENANT_GAP_BILLING_ACCOUNT_ID:
        "aaaaaaaa-0000-0000-0000-000000000003",
    } as unknown as NodeJS.ProcessEnv;
    const { tenants } = discoverTenants(env);
    expect(tenants[0]?.envSlug).toBe("candidate-a");
    expect(tenants[0]?.dsUid).toBe("cogni-candidate-a-poly-postgres");
    expect(tenants[0]?.apiBaseUrl).toBe("https://poly-test.cognidao.org");
  });
});

describe("filterMarketsByTargetWallet", () => {
  it("case-insensitive match on target_wallet", () => {
    const resp = {
      billing_account_id: "x",
      mode: "all" as const,
      since: null,
      until: null,
      captured_at: "x",
      summary: {} as never,
      markets: [
        {
          market_id: "0xabc",
          target_id: "tid",
          target_wallet: "0xABCDEF",
          fills_count: 2,
          filled_count: 1,
          open_count: 0,
          pending_count: 0,
          canceled_count: 0,
          error_count: 0,
          buy_count: 1,
          sell_count: 0,
          intent_usdc: 10,
          realized_size_usdc: 5,
          has_open_position: false,
          position_lifecycle: null,
          first_fill_at: null,
          last_fill_at: null,
        },
        {
          market_id: "0xdef",
          target_id: "tid",
          target_wallet: "0x999",
          fills_count: 0,
          filled_count: 0,
          open_count: 0,
          pending_count: 0,
          canceled_count: 0,
          error_count: 0,
          buy_count: 0,
          sell_count: 0,
          intent_usdc: 0,
          realized_size_usdc: 0,
          has_open_position: false,
          position_lifecycle: null,
          first_fill_at: null,
          last_fill_at: null,
        },
      ],
    };
    const filtered = filterMarketsByTargetWallet(resp, "0xabcdef");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.market_id).toBe("0xabc");
  });
});

describe("aggregateFillsForTarget", () => {
  it("sums fields across rows; counts open positions", () => {
    const rows = [
      {
        market_id: "m1",
        target_id: "tid",
        target_wallet: "0x1",
        fills_count: 3,
        filled_count: 2,
        open_count: 1,
        pending_count: 0,
        canceled_count: 0,
        error_count: 0,
        buy_count: 2,
        sell_count: 0,
        intent_usdc: 30,
        realized_size_usdc: 15,
        has_open_position: true,
        position_lifecycle: "open",
        first_fill_at: null,
        last_fill_at: null,
      },
      {
        market_id: "m2",
        target_id: "tid",
        target_wallet: "0x1",
        fills_count: 1,
        filled_count: 1,
        open_count: 0,
        pending_count: 0,
        canceled_count: 0,
        error_count: 0,
        buy_count: 1,
        sell_count: 0,
        intent_usdc: 10,
        realized_size_usdc: 10,
        has_open_position: false,
        position_lifecycle: null,
        first_fill_at: null,
        last_fill_at: null,
      },
    ];
    const agg = aggregateFillsForTarget(rows);
    expect(agg).toEqual({
      markets_count: 2,
      markets_with_open_position: 1,
      fills_count: 4,
      filled_count: 3,
      intent_usdc: 40,
      realized_size_usdc: 25,
    });
  });

  it("returns zeros for empty input", () => {
    expect(aggregateFillsForTarget([])).toEqual({
      markets_count: 0,
      markets_with_open_position: 0,
      fills_count: 0,
      filled_count: 0,
      intent_usdc: 0,
      realized_size_usdc: 0,
    });
  });
});

describe("aggregateDecisions", () => {
  it("buckets by outcome + tracks skip / error reasons", () => {
    const rows = [
      { outcome: "placed", reason: null, n: 12 },
      { outcome: "skipped", reason: "below_target_percentile", n: 30 },
      { outcome: "skipped", reason: "vwap_floor_breach", n: 5 },
      { outcome: "skipped", reason: null, n: 2 },
      { outcome: "error", reason: "insufficient_balance", n: 1 },
    ];
    const agg = aggregateDecisions(rows);
    expect(agg.decisions).toBe(50);
    expect(agg.placed).toBe(12);
    expect(agg.skipped).toBe(37);
    expect(agg.errored).toBe(1);
    expect(agg.skip_reasons).toEqual({
      below_target_percentile: 30,
      vwap_floor_breach: 5,
      _null: 2,
    });
    expect(agg.error_reasons).toEqual({ insufficient_balance: 1 });
  });

  it("handles empty input", () => {
    const agg = aggregateDecisions([]);
    expect(agg.decisions).toBe(0);
    expect(agg.placed).toBe(0);
  });
});

describe("placementRate", () => {
  it("returns placed / decisions", () => {
    expect(
      placementRate({ ...baseDecisions, decisions: 100, placed: 25 })
    ).toBeCloseTo(0.25);
  });
  it("returns null when no decisions (avoid 0/0 NaN)", () => {
    expect(placementRate({ ...baseDecisions })).toBeNull();
  });
});

describe("isLowSample", () => {
  it("flags decisions < 50 regardless of resolved markets", () => {
    expect(isLowSample({ ...baseDecisions, decisions: 49 }, 100)).toBe(true);
  });
  it("flags resolved_markets < 3 even when decisions are high", () => {
    expect(isLowSample({ ...baseDecisions, decisions: 5_000 }, 2)).toBe(true);
  });
  it("passes when both thresholds met", () => {
    expect(isLowSample({ ...baseDecisions, decisions: 50 }, 3)).toBe(false);
  });
});

describe("compareTenants", () => {
  it("computes delta and delta_pct vs control", () => {
    const control = mkMetrics("CTRL", "preview", "TRUST_TWIN", {
      decisions: { ...baseDecisions, decisions: 100, placed: 50 },
      placement_rate: 0.5,
      fills: { ...baseFills, intent_usdc: 200, realized_size_usdc: 150 },
    });
    const treatment = mkMetrics("GAP", "preview", "GAP", {
      decisions: { ...baseDecisions, decisions: 80, placed: 20 },
      placement_rate: 0.25,
      fills: { ...baseFills, intent_usdc: 100, realized_size_usdc: 60 },
    });
    const ab = compareTenants(control, treatment);
    const byAxis = (a: string) => {
      const d = ab.find((row) => row.axis === a);
      if (!d) throw new Error(`axis ${a} missing from ab`);
      return d;
    };
    expect(byAxis("decisions").delta).toBe(-20);
    expect(byAxis("decisions").delta_pct).toBeCloseTo(-0.2);
    expect(byAxis("placed").delta).toBe(-30);
    expect(byAxis("placed").delta_pct).toBeCloseTo(-0.6);
    expect(byAxis("placement_rate").delta).toBeCloseTo(-0.25);
    expect(byAxis("intent_usdc").delta).toBe(-100);
    expect(byAxis("realized_size_usdc").delta).toBe(-90);
  });

  it("returns null delta_pct when control is zero (no divide-by-zero)", () => {
    const control = mkMetrics("CTRL", "preview", "TRUST_TWIN", {
      decisions: { ...baseDecisions, decisions: 0, placed: 0 },
      placement_rate: null,
      fills: { ...baseFills },
    });
    const treatment = mkMetrics("GAP", "preview", "GAP", {
      decisions: { ...baseDecisions, decisions: 25, placed: 5 },
      placement_rate: 0.2,
      fills: { ...baseFills, intent_usdc: 50 },
    });
    const ab = compareTenants(control, treatment);
    const decisionsDelta = ab.find((d) => d.axis === "decisions");
    expect(decisionsDelta?.delta).toBe(25);
    expect(decisionsDelta?.delta_pct).toBeNull();
    const rateDelta = ab.find((d) => d.axis === "placement_rate");
    expect(rateDelta?.delta).toBeNull();
    expect(rateDelta?.delta_pct).toBeNull();
  });
});
