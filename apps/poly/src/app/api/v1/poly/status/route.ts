// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `poly/api/v1/poly/status`
 * Purpose: GET /api/v1/poly/status — pipeline status for the AI awareness engine.
 * Scope: Public API route. Does not require auth. Returns BrainStatus matching frontend BrainFeed type.
 * Invariants: Response shape must match BrainFeed.tsx BrainStatus interface exactly.
 * Side-effects: IO (reads from analysis_runs when DB is wired; live market count for now)
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import { PolymarketAdapter } from "@cogni/market-provider/adapters/polymarket";
import { NextResponse } from "next/server";

export const revalidate = 30; // ISR: cache for 30s then revalidate

export async function GET(): Promise<NextResponse> {
  try {
    // Fetch a small batch to prove connectivity + get a real count
    const polymarket = new PolymarketAdapter();
    const markets = await polymarket.listMarkets({
      limit: 50,
      activeOnly: true,
    });

    // When DB is wired (P5), this reads from analysis_runs + observation_events.
    return NextResponse.json({
      status: {
        state: markets.length > 0 ? "scanning" : "idle",
        marketsScanned: markets.length,
        signalsGenerated: 0, // No signals until poly-synth is wired (P4)
        lastHeartbeat: new Date().toISOString(),
      },
    });
  } catch {
    return NextResponse.json({
      status: {
        state: "idle" as const,
        marketsScanned: 0,
        signalsGenerated: 0,
        lastHeartbeat: new Date().toISOString(),
      },
    });
  }
}
