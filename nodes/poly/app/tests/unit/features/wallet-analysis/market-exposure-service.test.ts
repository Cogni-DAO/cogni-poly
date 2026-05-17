// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/market-exposure-service` (unit)
 * Purpose: Locks the cross-cutting invariants the dashboard Markets view
 *   depends on:
 *   - TARGET_LEGS_FROM_SNAPSHOTS — any active copy-target snapshot row that
 *     covers a condition we hold surfaces as a leg, regardless of whether
 *     we've mirrored a fill on that condition.
 *   - GAP_NULL_WITHOUT_TARGETS — `rateGapPct` and `sizeScaledGapUsdc` are
 *     null on lines/groups with zero target legs that have positive buy
 *     notional, so the UI renders `—` rather than a meaningless
 *     solo-market percentage.
 *   - SIGN_TARGET_MINUS_US — `rateGapPct` is positive when targets are
 *     ahead of us; the table sorts by `sizeScaledGapUsdc` descending so
 *     the biggest leak ends up on top.
 * Scope: Pure unit. Drizzle DB is faked via `db.execute()` returning canned
 *   rows; the SQL string itself is not asserted. Two distinct execute()
 *   calls are made per group: target-snapshots, then fill-rollups.
 * Side-effects: none
 * Links: nodes/poly/app/src/features/wallet-analysis/server/market-exposure-service.ts
 * @internal
 */

import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { describe, expect, it, vi } from "vitest";

import { buildMarketExposureGroups } from "@/features/wallet-analysis/server/market-exposure-service";

type Db = Parameters<typeof buildMarketExposureGroups>[0]["db"];

/**
 * Fake DB that returns a sequence of canned result-sets per .execute() call.
 * The service issues two reads when there are positions:
 *   1. target snapshots (poly_trader_position_snapshots)
 *   2. fill rollups       (poly_trader_fills)
 * Pass `[targetRows, fillRollupRows]`.
 */
function fakeDb(callResults: readonly unknown[][]): Db {
  let i = 0;
  return {
    execute: vi.fn(() => {
      const rows = callResults[i] ?? [];
      i += 1;
      return Promise.resolve(rows);
    }),
  } as unknown as Db;
}

const OUR_WALLET = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
const TARGET_WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function ourPosition(
  overrides: Partial<WalletExecutionPosition> = {}
): WalletExecutionPosition {
  return {
    positionId: "p-1",
    conditionId: "0xCOND1",
    asset: "tok-yes-1",
    marketTitle: "Tampa Bay Rays vs. Cleveland Guardians",
    eventTitle: null,
    marketSlug: "mlb-tb-cle",
    eventSlug: null,
    marketUrl: null,
    outcome: "Tampa Bay Rays",
    status: "open",
    openedAt: "2026-05-04T12:00:00.000Z",
    closedAt: null,
    resolvesAt: null,
    heldMinutes: 60,
    entryPrice: 0.205,
    currentPrice: 0.8,
    size: 9.99,
    currentValue: 9.99,
    pnlUsd: 7.95,
    pnlPct: 3.9,
    timeline: [],
    events: [],
    ...overrides,
  };
}

describe("buildMarketExposureGroups", () => {
  it("returns no groups when the caller has no positions (early-out)", async () => {
    const db = fakeDb([[], []]);
    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [],
    });
    expect(groups).toEqual([]);
    // Early-out — never asks the DB about anything.
    expect(db.execute as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("nulls gap metrics when no target snapshot rows exist", async () => {
    // Solo market: we hold $9.99 with $7.95 P/L, but no target leg surfaces.
    // The pre-fix code returned -ourPnl/ourCost = -390% — that is the bug.
    // No target snapshots, no fill rollups (our wallet not yet observed).
    const db = fakeDb([[], []]);
    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition()],
    });

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.lines).toHaveLength(1);
    expect(group?.lines[0]?.edgeGapUsdc).toBeNull();
    expect(group?.lines[0]?.edgeGapPct).toBeNull();
    expect(group?.edgeGapUsdc).toBeNull();
    expect(group?.edgeGapPct).toBeNull();
    // Our leg still renders.
    expect(group?.lines[0]?.participants).toHaveLength(1);
    expect(group?.lines[0]?.participants[0]?.side).toBe("our_wallet");
  });

  it("surfaces a target leg from a snapshot row, no fill required", async () => {
    // The pre-fix SQL gated target legs on poly_copy_trade_fills having a row
    // for (target, condition). After the fix, an active target with any
    // snapshot in our condition shows up — that is the whole point of the
    // "Markets" lens.
    const db = fakeDb([
      [
        {
          wallet_address: TARGET_WALLET,
          label: "RN1",
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          market_title: "Tampa Bay Rays vs. Cleveland Guardians",
          event_title: null,
          market_slug: "mlb-tb-cle",
          event_slug: null,
          outcome: "Tampa Bay Rays",
          shares: "100",
          cost_basis_usdc: "20.00",
          current_value_usdc: "80.00",
          avg_price: "0.20",
          last_observed_at: new Date("2026-05-04T12:30:00.000Z"),
          lifecycle: "active",
        },
      ],
      // Fill rollups: target's BUY notional was $20 on this condition.
      // Our wallet has no fills row → service falls back to position-derived
      // cost basis (currentValue − pnlUsd = 9.99 − 7.95 = $2.04).
      [
        {
          wallet_address: TARGET_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          total_buy_notional: "20.00",
          realized_cash: "0",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition()],
    });

    expect(groups).toHaveLength(1);
    const line = groups[0]?.lines[0];
    expect(line).toBeDefined();
    const sides = line?.participants.map((p) => p.side).sort();
    expect(sides).toEqual(["copy_target", "our_wallet"]);
    // edgeGap fields are populated using the new (Modified-Dietz) math but
    // emitted under the legacy contract field names — see the service's
    // OLD_CONTRACT_FIELD_MAPPING comment. Both sides have positive buy
    // notional in this test, so the values are non-null.
    expect(line?.edgeGapPct).not.toBeNull();
    expect(line?.edgeGapUsdc).not.toBeNull();
  });

  it("uses target snapshot cost basis when the fill rollup undercounts (backfill horizon)", async () => {
    // bug.5044: target wallets often have fill history that predates our
    // backfill horizon, so `poly_trader_fills` rollups undercount target
    // cost basis. Snapshot cost basis (Polymarket-published) is the truth.
    // When rollup < snapshot, snapshot wins — otherwise `targetEntryValueUsdc`
    // becomes a fraction of `targetValueUsdc` and Δ% inflates ~10×.
    const db = fakeDb([
      [
        {
          wallet_address: TARGET_WALLET,
          label: "swisstony",
          condition_id: "0xCOND1",
          token_id: "tok-no-1",
          market_title: "Will Qatar win on 2026-06-13?",
          event_title: null,
          market_slug: "fifwc-qat-che",
          event_slug: null,
          outcome: "No",
          shares: "1035.08",
          cost_basis_usdc: "929.43",
          current_value_usdc: "937.27",
          avg_price: "0.898",
          last_observed_at: new Date("2026-05-10T12:30:00.000Z"),
          lifecycle: "active",
        },
      ],
      [
        {
          wallet_address: TARGET_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          total_buy_notional: "85.54",
          realized_cash: "0",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition()],
    });

    expect(groups).toHaveLength(1);
    const line = groups[0]?.lines[0];
    expect(line?.targetEntryValueUsdc).toBe(929.43);
  });

  it("uses snapshot cost basis when the fill rollup is inflated by negRisk merges (market-maker target)", async () => {
    // swisstony-shaped: target bought BOTH outcomes ($36k of BUY fills, 0
    // SELLs lifetime) and merged matched YES+NO pairs back to USDC via the
    // NegRiskAdapter (~$33k recovered). Polymarket's vendor cost_basis on
    // the held shares is $3,200 — the rollup BUY notional of $36k is the
    // wrong P/L denominator (would compute return ≈ −86%, false negative).
    //
    // After SINGLE_BASIS_SNAPSHOT_COST, the row's "Entry" column uses the
    // snapshot ($3,200), the new `targetGrossBuyNotionalUsdc` field carries
    // the rollup ($36,215) for any future "Lifetime BUY" UI column, and
    // Δ% / target return are computed on the snapshot basis.
    const db = fakeDb([
      [
        {
          wallet_address: TARGET_WALLET,
          label: "swisstony",
          condition_id: "0xCOND1",
          token_id: "tok-no-1",
          market_title: "Parma: Camila Osorio vs Barbora Krejcikova",
          event_title: null,
          market_slug: "wta-osorio-krejcik-2026-05-15",
          event_slug: null,
          outcome: "Barbora Krejcikova",
          shares: "4834.27",
          cost_basis_usdc: "3200.75",
          current_value_usdc: "4832.44",
          avg_price: "0.6622",
          last_observed_at: new Date("2026-05-15T15:30:00.000Z"),
          lifecycle: "active",
        },
      ],
      [
        {
          wallet_address: TARGET_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-no-1",
          total_buy_notional: "36215.52",
          realized_cash: "0",
          net_shares: "4834.27",
          market_outcome: null,
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition()],
    });

    expect(groups).toHaveLength(1);
    const line = groups[0]?.lines[0];
    // Cost basis (the P/L denominator) is snapshot, not rollup.
    expect(line?.targetEntryValueUsdc).toBe(3200.75);
    // Lifetime BUY activity is exposed separately, never mixed.
    expect(line?.targetGrossBuyNotionalUsdc).toBe(36215.52);
    // Target's participant-level cost basis flows through `pivotParticipants`
    // from the same snapshot, so per-trader expansion and outer row agree.
    const targetRow = line?.participants.find((p) => p.side === "copy_target");
    expect(targetRow?.net.costBasisUsdc).toBe(3200.75);
    // The legacy max(rollup, snapshot) policy would have produced
    // targetEntryValueUsdc = 36215.52 here — exactly the inconsistency
    // the Osorio Krejcik investigation surfaced. SINGLE_BASIS_SNAPSHOT_COST
    // forbids that outcome.
  });

  it("preserves entry notional for closed lines so 'Our value' is non-zero after exit", async () => {
    // Regression for bug.5037: closed-line `ourValueUsdc` collapses to 0
    // because currentValue is 0 after we exit. The dashboard displays
    // `ourEntryValueUsdc` (Σ BUY fills) instead, which must survive the
    // exit unchanged. Same invariant target-side.
    const closedPosition = ourPosition({
      positionId: "p-closed",
      status: "closed",
      currentValue: 0,
      pnlUsd: -47.94,
      size: 0,
    });
    const db = fakeDb([
      // No target snapshots — keep the assertion focused on entry-value math.
      [],
      // Both wallets have BUY fills on this condition.
      [
        {
          wallet_address: OUR_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "42.00",
          realized_cash: "0",
          net_shares: "0",
          market_outcome: null,
        },
        {
          wallet_address: TARGET_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "1234.50",
          realized_cash: "0",
          net_shares: "0",
          market_outcome: null,
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [],
      closedPositions: [closedPosition],
    });

    expect(groups).toHaveLength(1);
    const group = groups[0];
    const line = group?.lines[0];
    expect(line?.status).toBe("closed");
    // Current mark-to-market is correctly $0 (we exited).
    expect(line?.ourValueUsdc).toBe(0);
    // Entry value = snapshot cost (pnl-derived $47.94 for closedPosition
    // legs, per the same SINGLE_BASIS_SNAPSHOT_COST policy applied to
    // target wallets). Rollup BUY notional $42 is now exposed separately
    // as `ourGrossBuyNotionalUsdc` for any future "Lifetime BUY" column.
    expect(line?.ourEntryValueUsdc).toBe(47.94);
    expect(line?.ourGrossBuyNotionalUsdc).toBe(42);
    expect(line?.targetEntryValueUsdc).toBe(0);
    expect(group?.ourValueUsdc).toBe(0);
    expect(group?.ourEntryValueUsdc).toBe(47.94);
  });

  it("reports realized P/L for a closed loser as -total_buy_notional", async () => {
    // bug: closed-position P/L hardcoded to $0 across the dashboard.
    // After the fix: a fully-resolved loser whose shares paid $0 should
    // surface a P/L equal to -Σ BUY notional, not $0.
    const closedPosition = ourPosition({
      positionId: "p-closed-loser",
      status: "closed",
      currentValue: 0,
      pnlUsd: 0,
      size: 0,
    });
    const db = fakeDb([
      [], // No target snapshots — keep the assertion on our P/L only.
      [
        {
          wallet_address: OUR_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "100.00",
          realized_cash: "0",
          net_shares: "500",
          market_outcome: "loser",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [],
      closedPositions: [closedPosition],
    });

    const group = groups[0];
    const line = group?.lines[0];
    expect(line?.status).toBe("closed");
    // Closed loser: full investment lost → $-100 realized.
    const ourParticipant = line?.participants.find(
      (p) => p.side === "our_wallet"
    );
    expect(ourParticipant?.net.pnlUsdc).toBe(-100);
    expect(group?.pnlUsd).toBe(-100);
  });

  it("reports realized P/L for a redeemed winner as netShares - total_buy", async () => {
    // Redeemed winner: shares were burned at $1/share by CTF redemption.
    // Polymarket's fills feed doesn't emit a SELL for redemption, so we
    // infer the credit from (outcome=winner, current_mark≈0, netShares).
    // Bought 500 shares for $80, redeemed all 500 at $1 → +$420 P/L.
    const closedPosition = ourPosition({
      positionId: "p-closed-winner",
      status: "closed",
      currentValue: 0,
      pnlUsd: 0,
      size: 0,
    });
    const db = fakeDb([
      [],
      [
        {
          wallet_address: OUR_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "80.00",
          realized_cash: "0",
          net_shares: "500",
          market_outcome: "winner",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [],
      closedPositions: [closedPosition],
    });

    const line = groups[0]?.lines[0];
    const ourParticipant = line?.participants.find(
      (p) => p.side === "our_wallet"
    );
    expect(ourParticipant?.net.pnlUsdc).toBe(420);
  });

  it("recovers realized P/L for a partial-sell-then-resolve winner", async () => {
    // Bought 1000 shares for $200 ($0.20 each), sold 400 for $200 cash
    // pre-resolution, redeemed remaining 600 at $1. Total in: $200,
    // total out: $200 (sells) + $600 (redemption) = $800. P/L = +$600.
    const closedPosition = ourPosition({
      positionId: "p-partial-winner",
      status: "closed",
      currentValue: 0,
      pnlUsd: 0,
      size: 0,
    });
    const db = fakeDb([
      [],
      [
        {
          wallet_address: OUR_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "200.00",
          realized_cash: "200.00",
          net_shares: "600",
          market_outcome: "winner",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [],
      closedPositions: [closedPosition],
    });

    const line = groups[0]?.lines[0];
    const ourParticipant = line?.participants.find(
      (p) => p.side === "our_wallet"
    );
    expect(ourParticipant?.net.pnlUsdc).toBe(600);
  });

  it("does not double-count redemption when winning shares are still on chain", async () => {
    // Pre-redemption winner: market resolved, shares not yet burned.
    // current_mark still ≈ shares × $1, so redemption_proceeds must be 0
    // or we'd count the payout twice. Bought 100 @ $0.30 = $30; market
    // resolved YES, mark = 100 × $1 = $100 (held). P/L should be +$70.
    const livePosition = ourPosition({
      positionId: "p-pending-redeem",
      status: "redeemable",
      currentValue: 100,
      pnlUsd: 70,
      size: 100,
    });
    const db = fakeDb([
      [],
      [
        {
          wallet_address: OUR_WALLET.toLowerCase(),
          condition_id: "0xCOND1",
          token_id: "tok-yes-1",
          total_buy_notional: "30.00",
          realized_cash: "0",
          net_shares: "100",
          market_outcome: "winner",
        },
      ],
    ]);

    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: "ba-1",
      walletAddress: OUR_WALLET,
      livePositions: [livePosition],
    });

    const line = groups[0]?.lines[0];
    const ourParticipant = line?.participants.find(
      (p) => p.side === "our_wallet"
    );
    expect(ourParticipant?.net.pnlUsdc).toBe(70);
  });
});
