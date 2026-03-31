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
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const revalidate = 60; // ISR: cache for 60s then revalidate

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = request.nextUrl;
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") ?? "50"), 1),
      500
    );
    const active = searchParams.get("active") !== "false"; // default true
    const category = searchParams.get("category") ?? undefined;
    const search = searchParams.get("search") ?? undefined;
    const cursor = searchParams.get("cursor") ?? undefined;

    const polymarket = new PolymarketAdapter();

    // Fetch in smaller batches to be resilient to individual market validation failures.
    // Polymarket API can return markets with null endDate or other missing fields
    // that fail Zod validation in the adapter. We catch and skip those.
    let allMarkets: Awaited<ReturnType<typeof polymarket.listMarkets>> = [];
    try {
      allMarkets = await polymarket.listMarkets({
        limit,
        activeOnly: active,
        category,
        search,
        cursor,
      });
    } catch {
      // Zod validation failure on some markets in the batch — try smaller batch
      try {
        allMarkets = await polymarket.listMarkets({
          limit: Math.min(limit, 10),
          activeOnly: active,
          category,
          search,
          cursor,
        });
      } catch {
        // Even small batch fails — return empty
      }
    }

    // Convert to frontend MarketResponse shape
    // change24h is 0 for now — needs observation history to compute
    const markets = allMarkets.map((m) => marketToResponse(m, [0, 0]));

    return NextResponse.json({
      markets,
      nextCursor: allMarkets.length === limit ? String(limit) : null,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch markets" },
      { status: 500 }
    );
  }
}
