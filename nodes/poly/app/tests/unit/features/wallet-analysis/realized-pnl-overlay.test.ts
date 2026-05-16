// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests/unit/features/wallet-analysis/realized-pnl-overlay
 * Purpose: Pin the `applyRealizedPnl` overlay — the single point at which
 *   token-level realized P/L from `readWalletTokenPnlMap` replaces the
 *   per-row unrealized fallback emitted by upstream read models. Earlier
 *   code zeroed `pnlUsd` for `status === "closed"` rows in two places,
 *   producing the "closed positions all show $0.00" dashboard bug.
 * Scope: Pure unit. No DB, no SQL — just composable helpers.
 */

import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

import {
  applyRealizedPnl,
  tokenPnlKey,
  type WalletTokenPnl,
} from "@/features/wallet-analysis/server/realized-pnl-service";

const CONDITION = "0xcond1";
const TOKEN = "tok-yes-1";

function basePosition(
  overrides: Partial<WalletExecutionPosition> = {}
): WalletExecutionPosition {
  return {
    positionId: "p1",
    conditionId: CONDITION,
    asset: TOKEN,
    marketTitle: "test market",
    eventTitle: null,
    marketSlug: null,
    eventSlug: null,
    marketUrl: null,
    outcome: "YES",
    status: "closed",
    lifecycleState: null,
    openedAt: "2026-05-01T00:00:00.000Z",
    closedAt: "2026-05-02T00:00:00.000Z",
    resolvesAt: null,
    gameStartTime: null,
    heldMinutes: 1440,
    entryPrice: 0.2,
    currentPrice: 0,
    size: 0,
    currentValue: 0,
    pnlUsd: 0, // pre-overlay (the bug)
    pnlPct: 0,
    syncedAt: null,
    syncAgeMs: null,
    syncStale: false,
    timeline: [],
    events: [],
    ...overrides,
  };
}

function pnl(overrides: Partial<WalletTokenPnl>): WalletTokenPnl {
  return {
    conditionId: CONDITION,
    tokenId: TOKEN,
    totalBuyNotionalUsdc: 0,
    realizedCashUsdc: 0,
    netShares: 0,
    currentMarkUsdc: 0,
    marketOutcome: null,
    redemptionProceedsUsdc: 0,
    pnlUsd: 0,
    pnlPct: null,
    ...overrides,
  };
}

describe("applyRealizedPnl", () => {
  it("overlays realized P/L from the map onto a closed-loser position", async () => {
    const positions = [basePosition({ pnlUsd: 0 })];
    const map = new Map<string, WalletTokenPnl>([
      [
        tokenPnlKey(CONDITION, TOKEN),
        pnl({
          totalBuyNotionalUsdc: 100,
          marketOutcome: "loser",
          pnlUsd: -100,
          pnlPct: -1.0,
        }),
      ],
    ]);

    const [overlaid] = applyRealizedPnl(positions, map);
    expect(overlaid.pnlUsd).toBe(-100);
    expect(overlaid.pnlPct).toBe(-100);
  });

  it("overlays realized P/L from the map onto a redeemed-winner position", async () => {
    const positions = [basePosition()];
    const map = new Map<string, WalletTokenPnl>([
      [
        tokenPnlKey(CONDITION, TOKEN),
        pnl({
          totalBuyNotionalUsdc: 80,
          netShares: 500,
          marketOutcome: "winner",
          redemptionProceedsUsdc: 500,
          pnlUsd: 420,
          pnlPct: 5.25,
        }),
      ],
    ]);

    const [overlaid] = applyRealizedPnl(positions, map);
    expect(overlaid.pnlUsd).toBe(420);
    expect(overlaid.pnlPct).toBe(525);
  });

  it("leaves positions untouched when no map entry exists", async () => {
    const positions = [basePosition({ pnlUsd: 6, pnlPct: 60 })];
    const overlaid = applyRealizedPnl(positions, new Map());
    expect(overlaid[0].pnlUsd).toBe(6);
    expect(overlaid[0].pnlPct).toBe(60);
  });

  it("preserves all non-pnl fields on overlay", async () => {
    const input = basePosition({
      positionId: "custom-id",
      marketTitle: "preserved",
      openedAt: "2026-04-01T00:00:00.000Z",
      heldMinutes: 999,
      entryPrice: 0.42,
      size: 12.34,
    });
    const map = new Map<string, WalletTokenPnl>([
      [
        tokenPnlKey(CONDITION, TOKEN),
        pnl({ totalBuyNotionalUsdc: 10, pnlUsd: -5 }),
      ],
    ]);
    const [overlaid] = applyRealizedPnl([input], map);
    expect(overlaid.positionId).toBe("custom-id");
    expect(overlaid.marketTitle).toBe("preserved");
    expect(overlaid.openedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(overlaid.heldMinutes).toBe(999);
    expect(overlaid.entryPrice).toBe(0.42);
    expect(overlaid.size).toBe(12.34);
  });
});
