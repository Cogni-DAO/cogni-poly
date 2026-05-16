// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests/unit/features/wallet-analysis/realized-pnl-service
 * Purpose: Pin the per-(condition, token) realized P/L semantics for one
 *   wallet — the canonical formula every dashboard surface routes through.
 * Scope: Pure unit. Drizzle DB is faked via `db.execute()` returning canned
 *   rows from the helper's SQL aggregation.
 */

import { describe, expect, it, vi } from "vitest";

import {
  readWalletTokenPnlMap,
  tokenPnlKey,
} from "@/features/wallet-analysis/server/realized-pnl-service";

type Db = Parameters<typeof readWalletTokenPnlMap>[0]["db"];

function fakeDb(rows: ReadonlyArray<Record<string, unknown>>): Db {
  return {
    execute: vi.fn(() => Promise.resolve({ rows })),
  } as unknown as Db;
}

const WALLET = "0xabc0000000000000000000000000000000000001";
const CONDITION = "0xCOND1";
const TOKEN = "tok-yes-1";

describe("readWalletTokenPnlMap", () => {
  it("closed loser → pnlUsd = −total_buy_notional", async () => {
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: CONDITION,
          token_id: TOKEN,
          total_buy_notional: "100",
          realized_cash: "0",
          net_shares: "500",
          current_value_usdc: "0",
          market_outcome: "loser",
        },
      ]),
      walletAddress: WALLET,
    });

    const entry = map.get(tokenPnlKey(CONDITION, TOKEN));
    expect(entry).toBeDefined();
    expect(entry?.pnlUsd).toBe(-100);
    expect(entry?.redemptionProceedsUsdc).toBe(0);
    expect(entry?.marketOutcome).toBe("loser");
  });

  it("redeemed winner → pnlUsd = netShares − total_buy_notional", async () => {
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: CONDITION,
          token_id: TOKEN,
          total_buy_notional: "80",
          realized_cash: "0",
          net_shares: "500",
          current_value_usdc: "0",
          market_outcome: "winner",
        },
      ]),
      walletAddress: WALLET,
    });

    const entry = map.get(tokenPnlKey(CONDITION, TOKEN));
    expect(entry?.pnlUsd).toBe(420);
    expect(entry?.redemptionProceedsUsdc).toBe(500);
  });

  it("partial-sell winner: cash + redemption − cost", async () => {
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: CONDITION,
          token_id: TOKEN,
          total_buy_notional: "200",
          realized_cash: "200",
          net_shares: "600",
          current_value_usdc: "0",
          market_outcome: "winner",
        },
      ]),
      walletAddress: WALLET,
    });

    expect(map.get(tokenPnlKey(CONDITION, TOKEN))?.pnlUsd).toBe(600);
  });

  it("unresolved market: MTM (mark − cost), no redemption credit", async () => {
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: CONDITION,
          token_id: TOKEN,
          total_buy_notional: "50",
          realized_cash: "0",
          net_shares: "100",
          current_value_usdc: "80",
          market_outcome: null,
        },
      ]),
      walletAddress: WALLET,
    });

    const entry = map.get(tokenPnlKey(CONDITION, TOKEN));
    expect(entry?.pnlUsd).toBe(30);
    expect(entry?.redemptionProceedsUsdc).toBe(0);
    expect(entry?.marketOutcome).toBeNull();
  });

  it("skips entries with no BUY history (fall-through to caller MTM)", async () => {
    // A row with zero buy notional carries no realized-PnL signal;
    // omitting it lets the consuming read model fall back to its own
    // unrealized calculation rather than overwriting with a spurious $0.
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: CONDITION,
          token_id: TOKEN,
          total_buy_notional: "0",
          realized_cash: "0",
          net_shares: "0",
          current_value_usdc: "0",
          market_outcome: null,
        },
      ]),
      walletAddress: WALLET,
    });

    expect(map.size).toBe(0);
  });

  it("keys are case-insensitive on conditionId", async () => {
    const map = await readWalletTokenPnlMap({
      db: fakeDb([
        {
          condition_id: "0xMixedCaseCondition",
          token_id: TOKEN,
          total_buy_notional: "10",
          realized_cash: "0",
          net_shares: "20",
          current_value_usdc: "0",
          market_outcome: "loser",
        },
      ]),
      walletAddress: WALLET,
    });

    expect(map.get(tokenPnlKey("0xMIXEDCASECONDITION", TOKEN))).toBeDefined();
    expect(map.get(tokenPnlKey("0xmixedcasecondition", TOKEN))).toBeDefined();
  });
});
