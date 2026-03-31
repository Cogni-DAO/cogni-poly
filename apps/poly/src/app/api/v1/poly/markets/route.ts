// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `poly/api/v1/poly/markets`
 * Purpose: GET /api/v1/poly/markets — live market listings from Polymarket + Kalshi via market-provider.
 * Scope: Public API route. Does not require auth. Returns MarketResponse[] matching frontend Market type.
 * Invariants: Response shape must match MarketCards.tsx Market interface exactly.
 * Side-effects: IO (fetches from market-provider adapters)
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import { PolymarketAdapter } from "@cogni/market-provider/adapters/polymarket";
import { marketToResponse } from "@cogni/poly-core";
import { NextResponse } from "next/server";

export const revalidate = 60; // ISR: cache for 60s then revalidate

export async function GET(): Promise<NextResponse> {
  try {
    const polymarket = new PolymarketAdapter();
    const allMarkets = await polymarket.listMarkets({
      limit: 50,
      activeOnly: true,
    });

    // Convert to frontend MarketResponse shape
    // change24h is 0 for now — needs observation history to compute
    const markets = allMarkets.map((m) => marketToResponse(m, [0, 0]));

    return NextResponse.json({
      markets,
      nextCursor: null,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch markets" },
      { status: 500 }
    );
  }
}
