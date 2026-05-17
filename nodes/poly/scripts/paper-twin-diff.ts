#!/usr/bin/env tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@nodes/poly/scripts/paper-twin-diff`
 * Purpose: Diff a preview paper-twin tenant against a PROD live tenant on per-market positions + sized exposure.
 *   Joins `/api/v1/poly/research/copy-trade-pnl` responses from both deploys
 *   keyed on `market_id`. The honest "is paper tracking live" loop.
 * Scope: Read-only CLI; does not touch the DB, place orders, or modify state.
 *   Hits the research endpoint on two deploys; bearers + tenant ids come from
 *   env vars (typically the user's main-workspace `.env.cogni`).
 * Invariants: TWIN_AND_LIVE_FROM_SAME_ENDPOINT — both calls use the same
 *   contract shape, so the per-market join is structural.
 * Side-effects: IO (HTTP GETs to preview + PROD; stdout writes).
 * Links: docs/spec/poly-copy-trade-execution.md · work/projects/proj.poly-paper-trading.md
 * @public
 */

// Inputs come from env vars (typically the user's main-workspace .env.cogni)
// or CLI flags. Two halves: TWIN (paper, on preview) and LIVE (PROD).
//
// Required:
//   POLY_PREVIEW_TRUST_TWIN_API_KEY         — bearer for preview tenant
//   POLY_PREVIEW_TRUST_TWIN_BILLING_ACCOUNT_ID
//   POLY_PROD_TENANT_API_KEY                — bearer for Derek's PROD tenant
//   POLY_PROD_TENANT_BILLING_ACCOUNT_ID
// Optional:
//   POLY_PREVIEW_BASE_URL      (default https://poly-preview.cognidao.org)
//   POLY_PROD_BASE_URL         (default https://poly.cognidao.org)
//   PAPER_TWIN_DIFF_TOP_N      (default 10) — markets to print in detail
//   PAPER_TWIN_DIFF_JSON       ("1" to emit JSON to stdout instead of table)
//   PAPER_TWIN_DIFF_SINCE      ISO-8601 — only count fills observed at/after this
//                              instant on both sides. Strongly recommended:
//                              set to the trust-twin registration time so the
//                              comparison excludes PROD history the twin
//                              never had a chance to mirror.
//   PAPER_TWIN_DIFF_UNTIL      ISO-8601 — only count fills observed before this
//                              instant (exclusive). Optional.
//
// Usage:
//   pnpm tsx scripts/paper-twin-diff.ts
//   PAPER_TWIN_DIFF_JSON=1 pnpm tsx scripts/paper-twin-diff.ts > diff.json

type MarketRow = {
  market_id: string;
  target_id: string;
  target_wallet: string | null;
  fills_count: number;
  filled_count: number;
  open_count: number;
  pending_count: number;
  canceled_count: number;
  error_count: number;
  buy_count: number;
  sell_count: number;
  intent_usdc: number;
  realized_size_usdc: number;
  has_open_position: boolean;
  position_lifecycle: string | null;
  first_fill_at: string | null;
  last_fill_at: string | null;
};

type CopyTradePnlResponse = {
  billing_account_id: string;
  mode: "live" | "paper" | "all";
  since: string | null;
  until: string | null;
  captured_at: string;
  summary: {
    fills_count: number;
    filled_count: number;
    open_count: number;
    pending_count: number;
    canceled_count: number;
    error_count: number;
    markets_count: number;
    markets_with_open_position: number;
    total_intent_usdc: number;
    total_realized_size_usdc: number;
    first_fill_at: string | null;
    last_fill_at: string | null;
  };
  markets: MarketRow[];
};

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function fetchPnl(
  baseUrl: string,
  bearer: string,
  billingAccountId: string,
  mode: "paper" | "live",
  window: { since?: string; until?: string }
): Promise<CopyTradePnlResponse> {
  const url = new URL("/api/v1/poly/research/copy-trade-pnl", baseUrl);
  url.searchParams.set("billing_account_id", billingAccountId);
  url.searchParams.set("mode", mode);
  if (window.since) url.searchParams.set("since", window.since);
  if (window.until) url.searchParams.set("until", window.until);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(
      `${baseUrl} returned ${res.status} ${res.statusText}: ${await res.text()}`
    );
  }
  return (await res.json()) as CopyTradePnlResponse;
}

type Diff = {
  market_id: string;
  target_wallet: string | null;
  twin: MarketRow | null;
  live: MarketRow | null;
  intent_diff_usdc: number; // twin − live
  realized_diff_usdc: number; // twin − live
  fills_diff: number; // twin − live
  position_state: "both_open" | "twin_only" | "live_only" | "both_closed";
};

function buildDiff(
  twin: CopyTradePnlResponse,
  live: CopyTradePnlResponse
): Diff[] {
  const twinByMarket = new Map(twin.markets.map((m) => [m.market_id, m]));
  const liveByMarket = new Map(live.markets.map((m) => [m.market_id, m]));
  const allKeys = new Set([...twinByMarket.keys(), ...liveByMarket.keys()]);
  const diffs: Diff[] = [];
  for (const market_id of allKeys) {
    const t = twinByMarket.get(market_id) ?? null;
    const l = liveByMarket.get(market_id) ?? null;
    const tOpen = t?.has_open_position ?? false;
    const lOpen = l?.has_open_position ?? false;
    let position_state: Diff["position_state"];
    if (tOpen && lOpen) position_state = "both_open";
    else if (tOpen && !lOpen) position_state = "twin_only";
    else if (!tOpen && lOpen) position_state = "live_only";
    else position_state = "both_closed";
    diffs.push({
      market_id,
      target_wallet: t?.target_wallet ?? l?.target_wallet ?? null,
      twin: t,
      live: l,
      intent_diff_usdc: (t?.intent_usdc ?? 0) - (l?.intent_usdc ?? 0),
      realized_diff_usdc:
        (t?.realized_size_usdc ?? 0) - (l?.realized_size_usdc ?? 0),
      fills_diff: (t?.fills_count ?? 0) - (l?.fills_count ?? 0),
      position_state,
    });
  }
  // Sort by absolute realized divergence desc.
  diffs.sort(
    (a, b) => Math.abs(b.realized_diff_usdc) - Math.abs(a.realized_diff_usdc)
  );
  return diffs;
}

function fmt$(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : " ";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function printTable(diffs: Diff[], topN: number): void {
  console.log("\n=== Per-market diff (top by |realized Δ|) ===");
  console.log(
    [
      "market_id".padEnd(70),
      "state".padEnd(11),
      "twin_fills".padStart(11),
      "live_fills".padStart(11),
      "twin_real$".padStart(11),
      "live_real$".padStart(11),
      "Δreal$".padStart(11),
    ].join("  ")
  );
  for (const d of diffs.slice(0, topN)) {
    console.log(
      [
        d.market_id.slice(0, 70).padEnd(70),
        d.position_state.padEnd(11),
        String(d.twin?.fills_count ?? "—").padStart(11),
        String(d.live?.fills_count ?? "—").padStart(11),
        (d.twin?.realized_size_usdc.toFixed(2) ?? "—").padStart(11),
        (d.live?.realized_size_usdc.toFixed(2) ?? "—").padStart(11),
        fmt$(d.realized_diff_usdc).padStart(11),
      ].join("  ")
    );
  }
  if (diffs.length > topN) {
    console.log(`  …and ${diffs.length - topN} more markets`);
  }
}

function printSummary(
  twin: CopyTradePnlResponse,
  live: CopyTradePnlResponse,
  diffs: Diff[]
): void {
  const both = diffs.filter((d) => d.position_state === "both_open").length;
  const twinOnly = diffs.filter((d) => d.position_state === "twin_only").length;
  const liveOnly = diffs.filter((d) => d.position_state === "live_only").length;
  const closed = diffs.filter((d) => d.position_state === "both_closed").length;
  const totalIntentDiff =
    twin.summary.total_intent_usdc - live.summary.total_intent_usdc;
  const totalRealizedDiff =
    twin.summary.total_realized_size_usdc -
    live.summary.total_realized_size_usdc;
  const sharedMarkets = both + closed;
  const matchedFills = diffs.reduce((s, d) => {
    if (d.twin && d.live) {
      return s + Math.min(d.twin.fills_count, d.live.fills_count);
    }
    return s;
  }, 0);
  const totalFills = twin.summary.fills_count + live.summary.fills_count;
  const fillMatchPct =
    totalFills === 0 ? null : (2 * matchedFills) / totalFills;

  console.log("\n=== Summary ===");
  const winLabel =
    twin.since || twin.until
      ? `window: since=${twin.since ?? "−∞"}  until=${twin.until ?? "now"}`
      : "window: ALL-TIME (no since/until filter)";
  console.log(`  ${winLabel}`);
  console.log(`  Twin (paper, preview)`);
  console.log(`    billing_account_id: ${twin.billing_account_id}`);
  console.log(
    `    fills=${twin.summary.fills_count}  markets=${twin.summary.markets_count}  open_positions=${twin.summary.markets_with_open_position}`
  );
  console.log(
    `    intent_usdc=$${twin.summary.total_intent_usdc.toFixed(2)}  realized_size_usdc=$${twin.summary.total_realized_size_usdc.toFixed(2)}`
  );
  console.log(`  Live (PROD)`);
  console.log(`    billing_account_id: ${live.billing_account_id}`);
  console.log(
    `    fills=${live.summary.fills_count}  markets=${live.summary.markets_count}  open_positions=${live.summary.markets_with_open_position}`
  );
  console.log(
    `    intent_usdc=$${live.summary.total_intent_usdc.toFixed(2)}  realized_size_usdc=$${live.summary.total_realized_size_usdc.toFixed(2)}`
  );
  console.log("");
  console.log(`  Position diff:`);
  console.log(
    `    both_open=${both}  twin_only=${twinOnly}  live_only=${liveOnly}  both_closed=${closed}  shared_markets=${sharedMarkets}`
  );
  console.log("  Sized exposure diff (twin − live):");
  console.log(
    `    Δ intent_usdc=${fmt$(totalIntentDiff)}  Δ realized_size_usdc=${fmt$(totalRealizedDiff)}`
  );
  console.log(
    `  Fill-overlap ratio (2·min/total): ${
      fillMatchPct === null ? "n/a" : `${(fillMatchPct * 100).toFixed(1)}%`
    }`
  );
}

async function main(): Promise<void> {
  const previewBase =
    process.env.POLY_PREVIEW_BASE_URL ?? "https://poly-preview.cognidao.org";
  const prodBase =
    process.env.POLY_PROD_BASE_URL ?? "https://poly.cognidao.org";
  const twinBearer = envRequired("POLY_PREVIEW_TRUST_TWIN_API_KEY");
  const twinAccount = envRequired("POLY_PREVIEW_TRUST_TWIN_BILLING_ACCOUNT_ID");
  const liveBearer = envRequired("POLY_PROD_TENANT_API_KEY");
  const liveAccount = envRequired("POLY_PROD_TENANT_BILLING_ACCOUNT_ID");
  const topN = Number(process.env.PAPER_TWIN_DIFF_TOP_N ?? 10);
  const sinceRaw = process.env.PAPER_TWIN_DIFF_SINCE;
  const untilRaw = process.env.PAPER_TWIN_DIFF_UNTIL;
  // Quick validation; the server also validates but a CLI typo fails noisily here.
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
    console.error(`PAPER_TWIN_DIFF_SINCE is not a valid ISO timestamp: ${sinceRaw}`);
    process.exit(2);
  }
  if (untilRaw && Number.isNaN(Date.parse(untilRaw))) {
    console.error(`PAPER_TWIN_DIFF_UNTIL is not a valid ISO timestamp: ${untilRaw}`);
    process.exit(2);
  }
  const window: { since?: string; until?: string } = {
    ...(sinceRaw ? { since: sinceRaw } : {}),
    ...(untilRaw ? { until: untilRaw } : {}),
  };
  if (!sinceRaw) {
    console.warn(
      "WARNING: PAPER_TWIN_DIFF_SINCE not set — comparing ALL-TIME fills. PROD pre-twin history will dominate the diff. Set PAPER_TWIN_DIFF_SINCE=<twin-registration-time-ISO> for a meaningful comparison."
    );
  }

  const [twin, live] = await Promise.all([
    fetchPnl(previewBase, twinBearer, twinAccount, "paper", window),
    fetchPnl(prodBase, liveBearer, liveAccount, "live", window),
  ]);
  const diffs = buildDiff(twin, live);

  if (process.env.PAPER_TWIN_DIFF_JSON === "1") {
    process.stdout.write(
      JSON.stringify(
        {
          twin: { summary: twin.summary, captured_at: twin.captured_at },
          live: { summary: live.summary, captured_at: live.captured_at },
          diffs,
        },
        null,
        2
      )
    );
    return;
  }
  printSummary(twin, live, diffs);
  printTable(diffs, topN);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
