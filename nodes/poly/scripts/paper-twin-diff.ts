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
 * Side-effects: IO (HTTP GETs to preview + PROD; filesystem writes under nodes/poly/research/paper-twin-diff/<iso>/).
 * Links: docs/spec/poly-copy-trade-execution.md · work/projects/proj.poly-paper-trading.md · .claude/skills/paper-trade-diff-analysis/SKILL.md
 * @public
 */

// Inputs come from env vars (typically the user's main-workspace .env.cogni).
// Two halves: TWIN (paper, on preview) and LIVE (PROD).
//
// Required:
//   POLY_PREVIEW_TRUST_TWIN_API_KEY         — bearer for preview tenant
//   POLY_PREVIEW_TRUST_TWIN_BILLING_ACCOUNT_ID
//   POLY_PROD_TENANT_API_KEY                — bearer for Derek's PROD tenant
//   POLY_PROD_TENANT_BILLING_ACCOUNT_ID
// Optional:
//   POLY_PREVIEW_BASE_URL      (default https://poly-preview.cognidao.org)
//   POLY_PROD_BASE_URL         (default https://poly.cognidao.org)
//   PAPER_TWIN_DIFF_TOP_N      (default 25) — markets in the report table
//   PAPER_TWIN_DIFF_SINCE      ISO-8601 — only count fills observed at/after this
//                              instant on both sides. Strongly recommended:
//                              set to the trust-twin registration time so the
//                              comparison excludes PROD history the twin
//                              never had a chance to mirror.
//   PAPER_TWIN_DIFF_UNTIL      ISO-8601 — only count fills observed before this
//                              instant (exclusive). Optional.
//   PAPER_TWIN_DIFF_STDOUT     "1" to also print a terminal summary + table
//                              (default: write report dir only, log path to stderr).
//
// Default behavior: writes `nodes/poly/research/paper-twin-diff/<iso>/{report.html,
// bundle.json, findings.json}` (mirrors delta-minimizer's tool shape) and logs the
// path to stderr. The HTML has a TAKEAWAY placeholder the LLM fills via the
// /paper-trade-diff-analysis skill.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

// ─── HTML report writer ───────────────────────────────────────────────────────

function renderReportHtml(args: {
  twin: CopyTradePnlResponse;
  live: CopyTradePnlResponse;
  diffs: Diff[];
  window: { since?: string; until?: string };
  topN: number;
  capturedAt: string;
}): string {
  const { twin, live, diffs, window, topN, capturedAt } = args;
  const targetWallet =
    diffs.find((d) => d.target_wallet)?.target_wallet ?? "(unknown)";

  const both = diffs.filter((d) => d.position_state === "both_open").length;
  const twinOnly = diffs.filter((d) => d.position_state === "twin_only").length;
  const liveOnly = diffs.filter((d) => d.position_state === "live_only").length;
  const closed = diffs.filter((d) => d.position_state === "both_closed").length;
  const totalIntentDiff =
    twin.summary.total_intent_usdc - live.summary.total_intent_usdc;
  const totalRealizedDiff =
    twin.summary.total_realized_size_usdc -
    live.summary.total_realized_size_usdc;
  const matchedFills = diffs.reduce(
    (s, d) =>
      d.twin && d.live
        ? s + Math.min(d.twin.fills_count, d.live.fills_count)
        : s,
    0
  );
  const totalFills = twin.summary.fills_count + live.summary.fills_count;
  const fillOverlapPct =
    totalFills === 0 ? null : (2 * matchedFills) / totalFills;

  const fmt$ = (n: number, signed = false): string => {
    const sign = !signed ? "" : n < 0 ? "-" : n > 0 ? "+" : " ";
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  };
  const cls = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "");

  const windowLabel =
    window.since || window.until
      ? `since=<code>${escapeHtml(window.since ?? "−∞")}</code> until=<code>${escapeHtml(window.until ?? "now")}</code>`
      : "<strong style='color:#f87171'>ALL-TIME (no since filter — PROD pre-twin history dominates the diff)</strong>";

  const rows = diffs.slice(0, topN);

  const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; margin: 0 auto; padding: 24px; max-width: 1320px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
.sub { color: #94a3b8; font-size: 13px; margin-bottom: 18px; }
.sub a { color: #60a5fa; text-decoration: none; }
.sub code { background: #131826; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.kpis { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 12px 0 18px; }
.kpi { background: #131826; border: 1px solid #1f2937; border-radius: 8px; padding: 14px 16px; }
.kpi h3 { margin: 0 0 6px; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.kpi .big { font-size: 24px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi .row { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; margin-top: 6px; }
.kpi.twin { border-left: 3px solid #3b82f6; }
.kpi.live { border-left: 3px solid #10b981; }
.kpi.delta { border-left: 3px solid #f59e0b; }
.pos { color: #22c55e; } .neg { color: #ef4444; }
.bucket-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 12px 0 22px; }
.bucket { background: #131826; border: 1px solid #1f2937; border-radius: 6px; padding: 10px 12px; text-align: center; }
.bucket .n { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bucket .l { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
.bucket.both_open  { border-left: 3px solid #34d399; }
.bucket.twin_only  { border-left: 3px solid #60a5fa; }
.bucket.live_only  { border-left: 3px solid #f87171; }
.bucket.both_closed { border-left: 3px solid #6b7280; }
.takeaway { background: linear-gradient(180deg, #1f1410 0%, #131826 100%); border: 1px solid #f59e0b; border-radius: 8px; padding: 18px 22px; margin: 12px 0 26px; }
.takeaway h2 { margin: 0 0 12px; font-size: 13px; color: #fbbf24; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.takeaway .placeholder { color: #64748b; font-style: italic; font-size: 13px; }
table.markets { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
table.markets th { font-size: 10px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 7px 9px; background: #0e1422; border-bottom: 1px solid #1f2937; position: sticky; top: 0; }
table.markets td { padding: 7px 9px; border-bottom: 1px solid #1f2937; }
table.markets td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.markets td.market { font-family: 'SF Mono', Menlo, monospace; font-size: 10px; color: #94a3b8; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.markets td.state { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.state-both_open { color: #34d399; }
.state-twin_only { color: #60a5fa; }
.state-live_only { color: #f87171; }
.state-both_closed { color: #6b7280; }
.footer-note { margin-top: 24px; padding-top: 18px; border-top: 1px solid #1f2937; font-size: 11px; color: #6b7280; }
.footer-note a { color: #60a5fa; }`;

  const rowsHtml = rows
    .map((d) => {
      const tw = d.twin;
      const lv = d.live;
      return `<tr>
  <td class="market" title="${escapeHtml(d.market_id)}">${escapeHtml(d.market_id.slice(-44))}</td>
  <td class="state state-${d.position_state}">${d.position_state.replace("_", " ")}</td>
  <td class="num">${tw?.fills_count ?? "—"}</td>
  <td class="num">${lv?.fills_count ?? "—"}</td>
  <td class="num ${cls(d.fills_diff)}">${d.fills_diff > 0 ? "+" : ""}${d.fills_diff}</td>
  <td class="num">${tw ? `$${tw.intent_usdc.toFixed(2)}` : "—"}</td>
  <td class="num">${lv ? `$${lv.intent_usdc.toFixed(2)}` : "—"}</td>
  <td class="num ${cls(d.intent_diff_usdc)}">${fmt$(d.intent_diff_usdc, true)}</td>
  <td class="num">${tw ? `$${tw.realized_size_usdc.toFixed(2)}` : "—"}</td>
  <td class="num">${lv ? `$${lv.realized_size_usdc.toFixed(2)}` : "—"}</td>
  <td class="num ${cls(d.realized_diff_usdc)}">${fmt$(d.realized_diff_usdc, true)}</td>
</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Paper-Twin Diff · ${escapeHtml(capturedAt)}</title>
<style>${css}</style>
</head>
<body>
<h1>Paper-Twin Diff Report</h1>
<div class="sub">
  Twin (paper, preview): <code>${escapeHtml(twin.billing_account_id)}</code> · Live (PROD): <code>${escapeHtml(live.billing_account_id)}</code> · Target wallet: <code>${escapeHtml(targetWallet)}</code><br/>
  Captured: <code>${escapeHtml(capturedAt)}</code> · Window: ${windowLabel}<br/>
  Project: <a href="../../../../work/projects/proj.poly-paper-trading.md">proj.poly-paper-trading</a> · Spec: <a href="../../../../docs/spec/poly-copy-trade-execution.md">poly-copy-trade-execution</a> · Skill: <code>/paper-trade-diff-analysis</code>
</div>

<!-- TAKEAWAY:START -->
<div class="takeaway">
  <h2>↗ Top finding</h2>
  <div class="placeholder">Awaiting LLM-authored takeaway. Tool produces data + visualization; agent reads <code>bundle.json</code>, buckets each material divergence per the skill's four categories (paper-fidelity bug / structural ceiling / algo divergence / state mismatch), drafts/refines/critiques, then fills this block with the headline finding(s) + confidence + Pareto next-fix. Replace between TAKEAWAY:START and TAKEAWAY:END.</div>
</div>
<!-- TAKEAWAY:END -->

<div class="kpis">
  <div class="kpi twin">
    <h3>Twin · paper · preview</h3>
    <div class="big">${twin.summary.fills_count} <span style="font-size:12px;color:#94a3b8">fills</span></div>
    <div class="row"><span>markets</span><span>${twin.summary.markets_count}</span></div>
    <div class="row"><span>open positions</span><span>${twin.summary.markets_with_open_position}</span></div>
    <div class="row"><span>intent $</span><span>$${twin.summary.total_intent_usdc.toFixed(2)}</span></div>
    <div class="row"><span>realized $</span><span>$${twin.summary.total_realized_size_usdc.toFixed(2)}</span></div>
  </div>
  <div class="kpi live">
    <h3>Live · PROD</h3>
    <div class="big">${live.summary.fills_count} <span style="font-size:12px;color:#94a3b8">fills</span></div>
    <div class="row"><span>markets</span><span>${live.summary.markets_count}</span></div>
    <div class="row"><span>open positions</span><span>${live.summary.markets_with_open_position}</span></div>
    <div class="row"><span>intent $</span><span>$${live.summary.total_intent_usdc.toFixed(2)}</span></div>
    <div class="row"><span>realized $</span><span>$${live.summary.total_realized_size_usdc.toFixed(2)}</span></div>
  </div>
  <div class="kpi delta">
    <h3>Δ · twin − live</h3>
    <div class="big ${cls(totalRealizedDiff)}">${fmt$(totalRealizedDiff, true)}</div>
    <div class="row"><span>Δ intent $</span><span class="${cls(totalIntentDiff)}">${fmt$(totalIntentDiff, true)}</span></div>
    <div class="row"><span>Δ fills</span><span>${twin.summary.fills_count - live.summary.fills_count}</span></div>
    <div class="row"><span>fill overlap (2·min/total)</span><span>${fillOverlapPct === null ? "—" : `${(fillOverlapPct * 100).toFixed(1)}%`}</span></div>
  </div>
</div>

<div class="bucket-strip">
  <div class="bucket both_open"><div class="n">${both}</div><div class="l">both open</div></div>
  <div class="bucket twin_only"><div class="n">${twinOnly}</div><div class="l">twin only</div></div>
  <div class="bucket live_only"><div class="n">${liveOnly}</div><div class="l">live only</div></div>
  <div class="bucket both_closed"><div class="n">${closed}</div><div class="l">both closed</div></div>
</div>

<h2 style="font-size:14px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin:24px 0 6px">Top ${rows.length} markets by |Δ realized $|</h2>
<table class="markets">
  <thead>
    <tr>
      <th>market_id</th><th>state</th>
      <th class="num">twin fills</th><th class="num">live fills</th><th class="num">Δ fills</th>
      <th class="num">twin intent $</th><th class="num">live intent $</th><th class="num">Δ intent $</th>
      <th class="num">twin real $</th><th class="num">live real $</th><th class="num">Δ real $</th>
    </tr>
  </thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>
${diffs.length > rows.length ? `<div style="margin-top:10px;font-size:11px;color:#6b7280">…and ${diffs.length - rows.length} more markets in <a href="bundle.json">bundle.json</a></div>` : ""}

<div class="footer-note">
  <a href="bundle.json">bundle.json</a> (AI read surface) · <a href="findings.json">findings.json</a> (LLM scratchpad) · Tool: <code>nodes/poly/scripts/paper-twin-diff.ts</code>
</div>

</body>
</html>`;
}

function writeReportDir(args: {
  twin: CopyTradePnlResponse;
  live: CopyTradePnlResponse;
  diffs: Diff[];
  window: { since?: string; until?: string };
  topN: number;
}): string {
  const capturedAt = new Date().toISOString();
  const tsSafe = capturedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(
    REPO_ROOT,
    "nodes/poly/research/paper-twin-diff",
    tsSafe
  );
  mkdirSync(outDir, { recursive: true });

  const html = renderReportHtml({ ...args, capturedAt });
  writeFileSync(join(outDir, "report.html"), html);

  writeFileSync(
    join(outDir, "bundle.json"),
    JSON.stringify(
      {
        captured_at: capturedAt,
        window: args.window,
        twin: args.twin,
        live: args.live,
        diffs: args.diffs,
      },
      null,
      2
    )
  );

  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify(
      {
        report_path: join(outDir, "report.html"),
        bucket_breakdown: null,
        primary_class: null,
        primary_confidence: null,
        primary_one_liner: null,
        secondary_class: null,
        secondary_confidence: null,
        secondary_one_liner: null,
        recommended_next_fix: null,
        authored_at: null,
      },
      null,
      2
    )
  );

  return outDir;
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
  const topN = Number(process.env.PAPER_TWIN_DIFF_TOP_N ?? 25);
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

  // Default behavior: write the report dir (mirrors delta-minimizer tool shape).
  const outDir = writeReportDir({ twin, live, diffs, window, topN });
  console.error(`[paper-twin-diff] report.html → ${join(outDir, "report.html")}`);
  console.error(`[paper-twin-diff] bundle.json → ${join(outDir, "bundle.json")}`);
  console.error(`[paper-twin-diff] findings.json → ${join(outDir, "findings.json")}`);

  // Opt-in terminal summary for human-shell use.
  if (process.env.PAPER_TWIN_DIFF_STDOUT === "1") {
    printSummary(twin, live, diffs);
    printTable(diffs, topN);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
