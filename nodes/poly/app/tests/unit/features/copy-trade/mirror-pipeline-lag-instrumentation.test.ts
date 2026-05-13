// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/mirror-pipeline-lag-instrumentation.test`
 * Purpose: Asserts task.5042 — `runMirrorTick()` emits exactly one `poly_mirror_decision_lag_ms{source}` histogram observation per fill, computed as `decided_at - fill.observed_at` and clamped ≥0, plus the `lag_ms_total` field surfaces on the downstream decision log via the logger child binding.
 * Scope: Pure — `FakeOrderLedger` + stub `WalletActivitySource` + `RecordingMetricsPort` + a tiny capturing logger. No DB, no network.
 * Invariants: DECISION_LAG_OBSERVED_ONCE.
 * Side-effects: none
 * Links: src/features/copy-trade/mirror-pipeline.ts, work/items/task.5042
 * @internal
 */

import {
  clientOrderIdFor,
  createRecordingMetrics,
  type Fill,
  type LoggerPort,
  type OrderIntent,
  type OrderReceipt,
} from "@cogni/poly-market-provider";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID, TEST_USER_ID_1 } from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";
import { FakeOrderLedger } from "@/adapters/test";
import {
  computeFillToDecisionLagMs,
  MIRROR_PIPELINE_METRICS,
  runMirrorTick,
} from "@/features/copy-trade/mirror-pipeline";
import type { MirrorTargetConfig } from "@/features/copy-trade/types";
import type { WalletActivitySource } from "@/features/wallet-watch";

const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_WALLET = "0xBBbbbbbBBbBbBbBBbBbbbBbbBbbBBbBbBbbBBbbb" as const;

const BASE_TARGET: MirrorTargetConfig = {
  target_id: TARGET_ID,
  target_wallet: TARGET_WALLET,
  billing_account_id: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  created_by_user_id: TEST_USER_ID_1,
  mode: "live",
  sizing: { kind: "min_bet", max_usdc_per_condition: 5 },
  placement: { kind: "mirror_limit" },
};

function makeFill(overrides?: Partial<Fill>): Fill {
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
    observed_at: "2026-05-12T12:22:59.000Z",
    attributes: {
      asset: "12345",
      condition_id:
        "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
    },
    ...overrides,
  };
}

function makeSource(fills: Fill[]): WalletActivitySource {
  return {
    async fetchSince() {
      return { fills, newSince: Math.floor(Date.now() / 1000) };
    },
  };
}

function makeReceipt(order_id: string, cid: string): OrderReceipt {
  return {
    order_id,
    client_order_id: cid,
    status: "open",
    filled_size_usdc: 0,
    submitted_at: new Date().toISOString(),
  };
}

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function createCapturingLogger(): {
  log: LoggerPort;
  logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  const make = (extra: Record<string, unknown>): LoggerPort => ({
    debug(obj, msg) {
      logs.push({ level: "debug", obj: { ...extra, ...obj }, msg });
    },
    info(obj, msg) {
      logs.push({ level: "info", obj: { ...extra, ...obj }, msg });
    },
    warn(obj, msg) {
      logs.push({ level: "warn", obj: { ...extra, ...obj }, msg });
    },
    error(obj, msg) {
      logs.push({ level: "error", obj: { ...extra, ...obj }, msg });
    },
    child(bindings) {
      return make({ ...extra, ...bindings });
    },
  });
  return { log: make({}), logs };
}

describe("computeFillToDecisionLagMs (task.5042 helper)", () => {
  it("returns the positive elapsed ms between fill.observed_at and decided_at", () => {
    const lag = computeFillToDecisionLagMs(
      "2026-05-12T12:22:59.000Z",
      new Date("2026-05-12T12:28:32.000Z")
    );
    expect(lag).toBe(5 * 60_000 + 33_000);
  });

  it("clamps a slightly-future fill.observed_at to 0 (clock skew tolerance)", () => {
    const lag = computeFillToDecisionLagMs(
      "2026-05-12T12:23:00.500Z",
      new Date("2026-05-12T12:23:00.000Z")
    );
    expect(lag).toBe(0);
  });

  it("returns 0 for a malformed observed_at instead of NaN (heavy 0-bucket = upstream contract drift signal)", () => {
    const lag = computeFillToDecisionLagMs(
      "not-a-date",
      new Date("2026-05-12T12:23:00.000Z")
    );
    expect(lag).toBe(0);
  });
});

describe("runMirrorTick — task.5042 lag observation + log field", () => {
  it("emits exactly one poly_mirror_decision_lag_ms{source} per fill and inherits lag_ms_total on the decision log", async () => {
    // Decision wall-clock pinned 5m33s after fill.observed_at — matches the
    // swisstony WTA Parma incident on 2026-05-12 that motivated this PR.
    const decidedAt = new Date("2026-05-12T12:28:32.000Z");
    const fill = makeFill({ observed_at: "2026-05-12T12:22:59.000Z" });

    const ledger = new FakeOrderLedger({ initial: [] });
    const metrics = createRecordingMetrics();
    const { log, logs } = createCapturingLogger();

    const cid = clientOrderIdFor(TARGET_ID, fill.fill_id);
    const placeIntent = vi.fn(
      async (_intent: OrderIntent): Promise<OrderReceipt> =>
        makeReceipt("0xnewlyplaced", cid)
    );

    let cursor: number | undefined;
    await runMirrorTick({
      source: makeSource([fill]),
      ledger,
      placeIntent,
      target: BASE_TARGET,
      getCursor: () => cursor,
      setCursor: (since) => {
        cursor = since;
      },
      logger: log,
      metrics,
      clock: () => decidedAt,
    });

    const observations = metrics.durations(
      MIRROR_PIPELINE_METRICS.decisionLagMs
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toBe(5 * 60_000 + 33_000);

    const hist = metrics.emissions.find(
      (e) =>
        e.kind === "duration" &&
        e.name === MIRROR_PIPELINE_METRICS.decisionLagMs
    );
    expect(hist?.labels).toEqual({ source: "data-api" });

    // The lag_ms_total field rides the child logger and must appear on the
    // downstream poly.mirror.decision log line — proving instrumentation lands
    // without per-emission-site edits.
    const decisionLog = logs.find(
      (l) =>
        l.obj.event === "poly.mirror.decision" && l.obj.outcome !== undefined
    );
    expect(decisionLog).toBeDefined();
    expect(decisionLog?.obj.lag_ms_total).toBe(5 * 60_000 + 33_000);
  });

  it("labels the lag histogram with source='chain' when the fill source is the chain adapter", async () => {
    const decidedAt = new Date("2026-05-12T12:22:59.002Z");
    // 2s after settlement — matches the expected end-to-end latency from the
    // chain-log source on Polygon.
    const fill = makeFill({
      source: "chain",
      fill_id: "chain:0xabc123:7:BUY",
      observed_at: "2026-05-12T12:22:57.000Z",
    });

    const ledger = new FakeOrderLedger({ initial: [] });
    const metrics = createRecordingMetrics();
    const { log } = createCapturingLogger();
    const cid = clientOrderIdFor(TARGET_ID, fill.fill_id);
    const placeIntent = vi.fn(
      async (_intent: OrderIntent): Promise<OrderReceipt> =>
        makeReceipt("0xnewlyplaced", cid)
    );

    let cursor: number | undefined;
    await runMirrorTick({
      source: makeSource([fill]),
      ledger,
      placeIntent,
      target: BASE_TARGET,
      getCursor: () => cursor,
      setCursor: (since) => {
        cursor = since;
      },
      logger: log,
      metrics,
      clock: () => decidedAt,
    });

    const hist = metrics.emissions.find(
      (e) =>
        e.kind === "duration" &&
        e.name === MIRROR_PIPELINE_METRICS.decisionLagMs
    );
    expect(hist?.labels).toEqual({ source: "chain" });
    expect(metrics.durations(MIRROR_PIPELINE_METRICS.decisionLagMs)).toEqual([
      2002,
    ]);
  });

  it("emits one observation per fill across multiple fills in a single tick", async () => {
    const decidedAt = new Date("2026-05-12T13:00:00.000Z");
    const fillA = makeFill({
      fill_id: "data-api:0xaaa:0xasset:BUY:1713302401",
      observed_at: "2026-05-12T12:59:50.000Z",
    });
    const fillB = makeFill({
      fill_id: "data-api:0xbbb:0xasset:BUY:1713302402",
      observed_at: "2026-05-12T12:50:00.000Z",
    });

    const ledger = new FakeOrderLedger({ initial: [] });
    const metrics = createRecordingMetrics();
    const { log } = createCapturingLogger();
    const placeIntent = vi.fn(
      async (intent: OrderIntent): Promise<OrderReceipt> =>
        makeReceipt(
          `0xorder-${intent.client_order_id.slice(2, 10)}`,
          intent.client_order_id
        )
    );

    let cursor: number | undefined;
    await runMirrorTick({
      source: makeSource([fillA, fillB]),
      ledger,
      placeIntent,
      target: BASE_TARGET,
      getCursor: () => cursor,
      setCursor: (since) => {
        cursor = since;
      },
      logger: log,
      metrics,
      clock: () => decidedAt,
    });

    const observations = metrics.durations(
      MIRROR_PIPELINE_METRICS.decisionLagMs
    );
    expect(observations).toHaveLength(2);
    // fillA observed 10s before decision, fillB observed 600s before.
    expect(observations).toEqual(expect.arrayContaining([10_000, 600_000]));
  });
});
