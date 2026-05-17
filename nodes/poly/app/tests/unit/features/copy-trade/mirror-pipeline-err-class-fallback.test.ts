// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/mirror-pipeline-err-class-fallback.test`
 * Purpose: Regression — `extractAdapterErrorReceipt` and the placement-failed
 *   log emission must read `err.name` (the explicit `this.name = "..."` string
 *   literal set in the constructor body), NOT `err.constructor.name`. Terser
 *   minifies class identifiers in production bundles to single letters
 *   ("i", "n", ...); persisting those into the durable receipt makes
 *   forensics impossible. This test fixture sets `name` to a value distinct
 *   from the class identifier so the assertion fails if anyone reverts.
 * Scope: Pure — `FakeOrderLedger` + stub `WalletActivitySource` +
 *   `RecordingMetricsPort` + noop logger. No DB, no network.
 * Invariants: ERR_NAME_NOT_CONSTRUCTOR_NAME.
 * Side-effects: none
 * Links: src/features/copy-trade/mirror-pipeline.ts (extractAdapterErrorReceipt),
 *   nodes/poly/research/delta-minimizing/lal-osa-mad-2026-05-12-2026-05-17T04-42-47/
 * @internal
 */

import {
  createRecordingMetrics,
  type Fill,
  type LoggerPort,
} from "@cogni/poly-market-provider";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID, TEST_USER_ID_1 } from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";
import { FakeOrderLedger } from "@/adapters/test";
import { runMirrorTick } from "@/features/copy-trade/mirror-pipeline";
import type { MirrorTargetConfig } from "@/features/copy-trade/types";
import type { WalletActivitySource } from "@/features/wallet-watch";

const TARGET_ID = "33333333-3333-3333-3333-333333333333";
const TARGET_WALLET = "0xCCcccccCCcCcCcCCcCccCcccCccCCcCcCccCCccc" as const;

const BASE_TARGET: MirrorTargetConfig = {
  target_id: TARGET_ID,
  target_wallet: TARGET_WALLET,
  billing_account_id: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  created_by_user_id: TEST_USER_ID_1,
  mode: "live",
  sizing: { kind: "min_bet", max_usdc_per_condition: 5 },
  placement: { kind: "mirror_limit" },
};

function makeFill(): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: "data-api:0xfeed:0xasset:BUY:1713302400",
    source: "data-api",
    market_id:
      "prediction-market:polymarket:0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size_usdc: 10,
    observed_at: "2026-05-12T20:07:47.000Z",
    attributes: {
      asset: "12345",
      condition_id:
        "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
    },
  };
}

function makeSource(fills: Fill[]): WalletActivitySource {
  return {
    async fetchSince() {
      return { fills, newSince: Math.floor(Date.now() / 1000) };
    },
  };
}

const noopLogger: LoggerPort = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

describe("extractAdapterErrorReceipt — regression: read err.name, not err.constructor.name", () => {
  it("persists the explicit this.name string (survives terser minification), not the class identifier", async () => {
    // Simulates a production-bundled error class: terser would minify
    // `MinifiedInProd` to "i", but the explicit `this.name = "..."` literal
    // is preserved. err.constructor.name === "MinifiedInProd" in dev / "i" in
    // prod; err.name === "ClobUpstreamFailure" in BOTH. We must read .name.
    class MinifiedInProd extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ClobUpstreamFailure";
      }
    }

    const fill = makeFill();
    const ledger = new FakeOrderLedger();
    const metrics = createRecordingMetrics();
    let cursor: number | undefined;

    const placeIntent = vi.fn(async () => {
      throw new MinifiedInProd("upstream timeout");
    });

    await runMirrorTick({
      source: makeSource([fill]),
      ledger,
      placeIntent,
      target: BASE_TARGET,
      getMarketConstraints: async () => ({
        minShares: 1,
        minUsdcNotional: 1,
        tickSize: 0.01,
      }),
      getCursor: () => cursor,
      setCursor: (n) => {
        cursor = n;
      },
      logger: noopLogger,
      metrics,
    });

    const errDec = ledger.decisions.find(
      (d) => d.outcome === "error" && d.reason === "placement_failed"
    );
    expect(errDec?.receipt).toMatchObject({
      error_code: "unknown",
      error_class: "ClobUpstreamFailure",
    });
  });
});
