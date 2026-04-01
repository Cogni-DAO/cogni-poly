// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `poly/api/v1/poly/signals`
 * Purpose: GET /api/v1/poly/signals — AI analysis signals from the decision plane.
 * Scope: Public API route. Does not require auth. Returns MarketSignal[] matching frontend BrainFeed type.
 * Invariants: Response shape must match BrainFeed.tsx MarketSignal interface exactly.
 * Side-effects: IO (reads from analysis_signals when DB is wired; empty array for now)
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // Signals are produced by poly-synth via Temporal (P4/P5).
  // Until that pipeline is wired, return empty array.
  // The frontend will show "no signals yet" state.
  return NextResponse.json({
    signals: [],
    nextCursor: null,
  });
}
