#!/usr/bin/env tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@nodes/poly/scripts/tenant-matrix-evaluator`
 * Purpose: Cross-policy A/B evaluator across the per-(env, tenant) paper-trading
 *   accounts enumerated in chr.poly-algo-tenant-matrix. Reads every
 *   POLY_<ENV>_TENANT_<ROLE>_* block from `.env.cogni`, queries each tenant's
 *   decisions + fills over a window, computes per-tenant metrics, A/B compares
 *   against the control, and emits an HTML report + bundle.json + findings.json.
 * Scope: Read-only research/observation tool. GET-only HTTP + SELECT-only SQL
 *   via the Grafana Postgres datasource. Does NOT mutate any tenant.
 * Invariants:
 *   - TENANT_SET_FROM_ENV: tenants discovered by globbing process.env, never hardcoded.
 *   - EVALUATOR_IS_READ_ONLY: every fetch must be GET; every SQL must start SELECT/WITH.
 *   - BUNDLE_IS_SOURCE_OF_TRUTH: every cell the report shows is derivable from bundle.json.
 *   - FINDING_IS_LLM_AUTHORED: script writes stubs; the running agent fills the TAKEAWAY + findings.json.
 * Side-effects: IO (HTTP GETs to per-env poly deploys; Grafana DS query POST;
 *   filesystem writes under `nodes/poly/research/tenant-matrix/<iso>/`).
 * Links: docs/spec/poly-tenant-matrix-evaluator.md · work/charters/POLY_ALGO_TENANT_MATRIX.md
 *   · nodes/poly/scripts/paper-twin-diff.ts · .claude/skills/tenant-matrix-evaluator/SKILL.md
 * @public
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const POLY_TARGET_WALLET_NAMESPACE = "e2a38b91-7b7d-5f8e-9c0d-4a1e6f8b2c3d";

// Inline UUIDv5 — keeps the script dependency-free across the workspace boundary.
// RFC 4122 §4.3: hash = sha1(namespace_bytes || name_bytes), set version/variant bits.
// Matches the `uuid` npm package's `v5` output bit-for-bit and the `target_id` shape
// the live mirror uses (`nodes/poly/app/src/features/copy-trade/target-id.ts`).
function uuidv5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (nsBytes.length !== 16) throw new Error(`bad namespace: ${namespace}`);
  const digest = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ─── Tenant discovery ────────────────────────────────────────────────────────

export type Tenant = {
  envLabel: string; // PROD | PREVIEW | CANDIDATE_A (raw env-key segment)
  role: string; // LIVE | TRUST_TWIN | GAP | VALIDATION (raw env-key segment)
  envSlug: "production" | "preview" | "candidate-a";
  apiBaseUrl: string;
  dsUid: string;
  apiKey: string;
  billingAccountId: string;
  envKeyPrefix: string;
};

export type TenantDiscoveryError = {
  envKeyPrefix: string;
  missing: "API_KEY" | "BILLING_ACCOUNT_ID";
};

const ENV_LABEL_TO_SLUG: Record<string, Tenant["envSlug"]> = {
  PROD: "production",
  PREVIEW: "preview",
  CANDIDATE_A: "candidate-a",
};

const ENV_SLUG_TO_BASE_URL: Record<Tenant["envSlug"], string> = {
  production: "https://poly.cognidao.org",
  preview: "https://poly-preview.cognidao.org",
  "candidate-a": "https://poly-test.cognidao.org",
};

export function discoverTenants(env: NodeJS.ProcessEnv): {
  tenants: Tenant[];
  errors: TenantDiscoveryError[];
} {
  const re = /^POLY_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_TENANT_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_API_KEY$/;
  const blocks = new Map<
    string,
    { envLabel: string; role: string; apiKey?: string; billingAccountId?: string }
  >();
  for (const [name, value] of Object.entries(env)) {
    const m = re.exec(name);
    if (!m || !value) continue;
    const envLabel = m[1];
    const role = m[2];
    if (!envLabel || !role) continue;
    const prefix = `POLY_${envLabel}_TENANT_${role}`;
    const cur = blocks.get(prefix) ?? { envLabel, role };
    cur.apiKey = value;
    blocks.set(prefix, cur);
  }
  const billingRe = /^POLY_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_TENANT_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_BILLING_ACCOUNT_ID$/;
  for (const [name, value] of Object.entries(env)) {
    const m = billingRe.exec(name);
    if (!m || !value) continue;
    const envLabel = m[1];
    const role = m[2];
    if (!envLabel || !role) continue;
    const prefix = `POLY_${envLabel}_TENANT_${role}`;
    const cur = blocks.get(prefix) ?? { envLabel, role };
    cur.billingAccountId = value;
    blocks.set(prefix, cur);
  }
  const tenants: Tenant[] = [];
  const errors: TenantDiscoveryError[] = [];
  for (const [prefix, cur] of blocks.entries()) {
    if (!cur.apiKey) {
      errors.push({ envKeyPrefix: prefix, missing: "API_KEY" });
      continue;
    }
    if (!cur.billingAccountId) {
      errors.push({ envKeyPrefix: prefix, missing: "BILLING_ACCOUNT_ID" });
      continue;
    }
    const envSlug = ENV_LABEL_TO_SLUG[cur.envLabel];
    if (!envSlug) {
      errors.push({ envKeyPrefix: prefix, missing: "API_KEY" }); // unknown env shape
      continue;
    }
    tenants.push({
      envLabel: cur.envLabel,
      role: cur.role,
      envSlug,
      apiBaseUrl: ENV_SLUG_TO_BASE_URL[envSlug],
      dsUid: `cogni-${envSlug}-poly-postgres`,
      apiKey: cur.apiKey,
      billingAccountId: cur.billingAccountId,
      envKeyPrefix: prefix,
    });
  }
  // Stable ordering: env then role.
  tenants.sort((a, b) =>
    a.envSlug === b.envSlug
      ? a.role.localeCompare(b.role)
      : a.envSlug.localeCompare(b.envSlug)
  );
  return { tenants, errors };
}

// ─── HTTP + SQL helpers (read-only) ──────────────────────────────────────────

async function getJson<T>(url: string, bearer: string): Promise<T> {
  // EVALUATOR_IS_READ_ONLY — method asserted GET at the wrapper.
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(
      `GET ${url} → ${res.status} ${res.statusText}: ${await res.text()}`
    );
  }
  return (await res.json()) as T;
}

type GrafanaQueryResponse = {
  results: Record<
    string,
    {
      frames?: Array<{
        schema: { fields: Array<{ name: string; type: string }> };
        data: { values: unknown[][] };
      }>;
    }
  >;
};

async function grafanaPgQuery(
  grafanaUrl: string,
  saToken: string,
  dsUid: string,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  if (!/^\s*(select|with)\s/i.test(sql)) {
    throw new Error(`refusing non-read SQL: ${sql.slice(0, 60)}`);
  }
  const body = {
    from: "now-5m",
    to: "now",
    queries: [
      {
        refId: "A",
        datasource: { uid: dsUid, type: "grafana-postgresql-datasource" },
        rawSql: sql,
        format: "table",
        maxDataPoints: 10000,
        intervalMs: 1000,
      },
    ],
  };
  const url = `${grafanaUrl.replace(/\/$/, "")}/api/ds/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${saToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `grafana pg query → ${res.status} ${res.statusText}: ${await res.text()}`
    );
  }
  const json = (await res.json()) as GrafanaQueryResponse;
  const frame = json.results?.A?.frames?.[0];
  if (!frame) return [];
  const cols = frame.schema.fields.map((f) => f.name);
  const rowCount = frame.data.values[0]?.length ?? 0;
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < cols.length; c++) {
      const colName = cols[c];
      if (colName === undefined) continue;
      row[colName] = frame.data.values[c]?.[i];
    }
    rows.push(row);
  }
  return rows;
}

// ─── Per-tenant data shapes ──────────────────────────────────────────────────

type CopyTradePnlMarketRow = {
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
  markets: CopyTradePnlMarketRow[];
};

type DecisionAgg = {
  decisions: number;
  placed: number;
  skipped: number;
  errored: number;
  skip_reasons: Record<string, number>;
  error_reasons: Record<string, number>;
};

export type TenantMetrics = {
  tenant: Pick<
    Tenant,
    "envLabel" | "role" | "envSlug" | "billingAccountId" | "envKeyPrefix"
  >;
  target_id: string;
  target_wallet: string;
  window: { since: string; until: string };
  decisions: DecisionAgg;
  placement_rate: number | null; // placed / decisions, null when decisions=0
  fills: {
    markets_count: number;
    markets_with_open_position: number;
    fills_count: number;
    filled_count: number;
    intent_usdc: number;
    realized_size_usdc: number;
  };
  // bundle includes the raw filtered markets so the agent can dig in.
  markets: CopyTradePnlMarketRow[];
  // Sample-size discipline: spec floors decisions<50 OR resolved_markets<3.
  low_sample: boolean;
  errors: string[];
};

// ─── Pure metric calculators (unit-testable) ─────────────────────────────────

export function filterMarketsByTargetWallet(
  resp: CopyTradePnlResponse,
  targetWallet: string
): CopyTradePnlMarketRow[] {
  const wantedLower = targetWallet.toLowerCase();
  return resp.markets.filter(
    (m) => m.target_wallet?.toLowerCase() === wantedLower
  );
}

export function aggregateFillsForTarget(
  rows: CopyTradePnlMarketRow[]
): TenantMetrics["fills"] {
  return {
    markets_count: rows.length,
    markets_with_open_position: rows.filter((m) => m.has_open_position).length,
    fills_count: rows.reduce((s, m) => s + m.fills_count, 0),
    filled_count: rows.reduce((s, m) => s + m.filled_count, 0),
    intent_usdc: rows.reduce((s, m) => s + m.intent_usdc, 0),
    realized_size_usdc: rows.reduce((s, m) => s + m.realized_size_usdc, 0),
  };
}

export function aggregateDecisions(
  rows: Array<{ outcome: string; reason: string | null; n: number }>
): DecisionAgg {
  const agg: DecisionAgg = {
    decisions: 0,
    placed: 0,
    skipped: 0,
    errored: 0,
    skip_reasons: {},
    error_reasons: {},
  };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    agg.decisions += n;
    if (r.outcome === "placed") agg.placed += n;
    else if (r.outcome === "skipped") {
      agg.skipped += n;
      const key = r.reason ?? "_null";
      agg.skip_reasons[key] = (agg.skip_reasons[key] ?? 0) + n;
    } else if (r.outcome === "error") {
      agg.errored += n;
      const key = r.reason ?? "_null";
      agg.error_reasons[key] = (agg.error_reasons[key] ?? 0) + n;
    }
  }
  return agg;
}

export function placementRate(agg: DecisionAgg): number | null {
  return agg.decisions === 0 ? null : agg.placed / agg.decisions;
}

export function isLowSample(
  agg: DecisionAgg,
  resolvedMarketsCount: number
): boolean {
  return agg.decisions < 50 || resolvedMarketsCount < 3;
}

// ─── A/B compare ─────────────────────────────────────────────────────────────

export type AbAxis =
  | "decisions"
  | "placed"
  | "placement_rate"
  | "intent_usdc"
  | "realized_size_usdc"
  | "markets_with_open_position";

export type AbDelta = {
  axis: AbAxis;
  control: number | null;
  treatment: number | null;
  delta: number | null;
  delta_pct: number | null; // (t - c) / |c|; null if c is 0 or null
};

export function compareTenants(
  control: TenantMetrics,
  treatment: TenantMetrics
): AbDelta[] {
  const pick = (m: TenantMetrics, axis: AbAxis): number | null => {
    switch (axis) {
      case "decisions":
        return m.decisions.decisions;
      case "placed":
        return m.decisions.placed;
      case "placement_rate":
        return m.placement_rate;
      case "intent_usdc":
        return m.fills.intent_usdc;
      case "realized_size_usdc":
        return m.fills.realized_size_usdc;
      case "markets_with_open_position":
        return m.fills.markets_with_open_position;
    }
  };
  const axes: AbAxis[] = [
    "decisions",
    "placed",
    "placement_rate",
    "intent_usdc",
    "realized_size_usdc",
    "markets_with_open_position",
  ];
  return axes.map((axis) => {
    const c = pick(control, axis);
    const t = pick(treatment, axis);
    const delta = c === null || t === null ? null : t - c;
    const delta_pct =
      delta === null || c === null || c === 0
        ? null
        : delta / Math.abs(c);
    return { axis, control: c, treatment: t, delta, delta_pct };
  });
}

// ─── SVG bar chart helpers ───────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type BarRow = { label: string; value: number; meta?: string; isControl?: boolean; lowSample?: boolean };

function svgBars(args: {
  title: string;
  rows: BarRow[];
  unit?: string;
  signed?: boolean;
  width?: number;
  rowH?: number;
  fmt?: (v: number) => string;
}): string {
  const width = args.width ?? 720;
  const rowH = args.rowH ?? 28;
  const labelW = 220;
  const valueW = 110;
  const padTop = 36;
  const padBottom = 12;
  const chartW = width - labelW - valueW - 24;
  const height = padTop + args.rows.length * rowH + padBottom;
  const max = Math.max(
    1,
    ...args.rows.map((r) => Math.abs(r.value || 0))
  );
  const fmt = args.fmt ?? ((v) => `${args.unit ?? ""}${v.toFixed(2)}`);
  const bars = args.rows
    .map((r, i) => {
      const y = padTop + i * rowH;
      const ymid = y + rowH / 2;
      const v = r.value || 0;
      const scaled = max === 0 ? 0 : (Math.abs(v) / max) * chartW;
      const x0 = labelW + 8 + (args.signed ? chartW / 2 : 0);
      const barX = args.signed ? (v < 0 ? x0 - scaled : x0) : labelW + 8;
      const barW = scaled;
      const color =
        r.isControl
          ? "#fbbf24"
          : v < 0
            ? "#ef4444"
            : v > 0
              ? "#22c55e"
              : "#6b7280";
      const labelClass = r.isControl ? "label control" : "label";
      const lowMark = r.lowSample ? ` <tspan fill="#fbbf24">🟡</tspan>` : "";
      return `
  <text class="${labelClass}" x="${labelW}" y="${ymid + 4}" text-anchor="end">${escapeHtml(r.label)}${lowMark}</text>
  <rect class="bar" x="${barX}" y="${y + 6}" width="${Math.max(2, barW)}" height="${rowH - 12}" fill="${color}" rx="2"/>
  <text class="value" x="${width - 8}" y="${ymid + 4}" text-anchor="end">${escapeHtml(fmt(v))}</text>
  ${r.meta ? `<text class="meta" x="${labelW + 8 + chartW + 4}" y="${ymid + 4}" text-anchor="start">${escapeHtml(r.meta)}</text>` : ""}`;
    })
    .join("");
  const axis = args.signed
    ? `<line x1="${labelW + 8 + chartW / 2}" y1="${padTop - 2}" x2="${labelW + 8 + chartW / 2}" y2="${height - padBottom + 2}" stroke="#1f2937"/>`
    : "";
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text class="title" x="12" y="20">${escapeHtml(args.title)}</text>
  ${axis}
  ${bars}
</svg>`;
}

// ─── Report writer ───────────────────────────────────────────────────────────

function fmt$(n: number, signed = false): string {
  const sign = !signed ? "" : n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function renderReportHtml(args: {
  capturedAt: string;
  targetWallet: string;
  targetId: string;
  window: { since: string; until: string };
  control: TenantMetrics;
  metrics: TenantMetrics[];
  abMatrix: Record<string, AbDelta[]>; // keyed by envKeyPrefix
}): string {
  const { capturedAt, targetWallet, targetId, window, control, metrics, abMatrix } =
    args;
  const tenantLabel = (m: TenantMetrics): string =>
    `${m.tenant.role} · ${m.tenant.envSlug}`;

  const sortedRows = [...metrics].sort((a, b) =>
    a.tenant.envKeyPrefix === control.tenant.envKeyPrefix
      ? -1
      : b.tenant.envKeyPrefix === control.tenant.envKeyPrefix
        ? 1
        : a.tenant.envKeyPrefix.localeCompare(b.tenant.envKeyPrefix)
  );

  const barRow = (m: TenantMetrics, value: number, meta?: string): BarRow => ({
    label: tenantLabel(m),
    value,
    isControl: m.tenant.envKeyPrefix === control.tenant.envKeyPrefix,
    lowSample: m.low_sample,
    ...(meta ? { meta } : {}),
  });

  const decisionsSvg = svgBars({
    title: "decisions (window)",
    rows: sortedRows.map((m) => barRow(m, m.decisions.decisions)),
    fmt: (v) => v.toFixed(0),
  });
  const placedSvg = svgBars({
    title: "placed (window)",
    rows: sortedRows.map((m) => barRow(m, m.decisions.placed)),
    fmt: (v) => v.toFixed(0),
  });
  const placementRateSvg = svgBars({
    title: "placement rate (placed / decisions)",
    rows: sortedRows.map((m) =>
      barRow(m, m.placement_rate ?? 0, m.placement_rate === null ? "n/a" : "")
    ),
    fmt: (v) => `${(v * 100).toFixed(1)}%`,
  });
  const intentSvg = svgBars({
    title: "intent USDC (window)",
    rows: sortedRows.map((m) => barRow(m, m.fills.intent_usdc)),
    fmt: (v) => fmt$(v),
  });
  const realizedSvg = svgBars({
    title: "realized size USDC (window)",
    rows: sortedRows.map((m) => barRow(m, m.fills.realized_size_usdc)),
    fmt: (v) => fmt$(v),
  });
  const openPosSvg = svgBars({
    title: "open positions (markets w/ open position)",
    rows: sortedRows.map((m) => barRow(m, m.fills.markets_with_open_position)),
    fmt: (v) => v.toFixed(0),
  });
  const marketsCountSvg = svgBars({
    title: "markets touched (with ≥1 fill row)",
    rows: sortedRows.map((m) => barRow(m, m.fills.markets_count)),
    fmt: (v) => v.toFixed(0),
  });

  // Compact A/B delta table — control vs each treatment, headline axes only.
  const deltaRows = sortedRows
    .filter((m) => m.tenant.envKeyPrefix !== control.tenant.envKeyPrefix)
    .map((m) => {
      const ab = abMatrix[m.tenant.envKeyPrefix] ?? [];
      const byAxis = (axis: AbAxis): AbDelta | undefined =>
        ab.find((d) => d.axis === axis);
      const renderCell = (axis: AbAxis): string => {
        const d = byAxis(axis);
        if (!d) return "—";
        if (d.delta_pct === null) {
          return `Δ ${d.delta === null ? "—" : d.delta.toFixed(2)}`;
        }
        const cls = d.delta_pct > 0 ? "pos" : d.delta_pct < 0 ? "neg" : "";
        return `<span class="${cls}">${(d.delta_pct * 100).toFixed(1)}%</span>`;
      };
      return `<tr>
  <td class="role">${escapeHtml(tenantLabel(m))}${m.low_sample ? " 🟡" : ""}</td>
  <td class="num">${renderCell("decisions")}</td>
  <td class="num">${renderCell("placed")}</td>
  <td class="num">${renderCell("placement_rate")}</td>
  <td class="num">${renderCell("intent_usdc")}</td>
  <td class="num">${renderCell("realized_size_usdc")}</td>
  <td class="num">${renderCell("markets_with_open_position")}</td>
</tr>`;
    })
    .join("\n");

  const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; margin: 0 auto; padding: 20px; max-width: 1280px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
.sub { color: #94a3b8; font-size: 12px; margin-bottom: 14px; }
.sub a { color: #60a5fa; text-decoration: none; }
.sub code { background: #131826; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.takeaway { background: linear-gradient(180deg, #1f1410 0%, #131826 100%); border: 1px solid #f59e0b; border-radius: 8px; padding: 16px 20px; margin: 8px 0 18px; }
.takeaway h2 { margin: 0 0 10px; font-size: 12px; color: #fbbf24; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.takeaway .placeholder { color: #64748b; font-style: italic; font-size: 12px; }
.bars-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 8px 0 18px; }
.chart { background: #0e1422; border: 1px solid #1f2937; border-radius: 6px; padding: 4px 6px; }
.chart svg { display: block; width: 100%; height: auto; }
svg .title { fill: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
svg .label { fill: #cbd5e1; font-size: 11px; font-family: 'SF Mono', Menlo, monospace; }
svg .label.control { fill: #fbbf24; font-weight: 600; }
svg .value { fill: #e5e7eb; font-size: 11px; font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; }
svg .meta { fill: #6b7280; font-size: 10px; }
svg .bar { opacity: 0.85; }
table.ab { width: 100%; border-collapse: collapse; font-size: 12px; }
table.ab th { font-size: 10px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 6px 8px; background: #0e1422; border-bottom: 1px solid #1f2937; }
table.ab td { padding: 6px 8px; border-bottom: 1px solid #1f2937; font-variant-numeric: tabular-nums; }
table.ab td.num { text-align: right; font-family: 'SF Mono', Menlo, monospace; }
table.ab td.role { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; color: #cbd5e1; }
.pos { color: #22c55e; } .neg { color: #ef4444; }
h3.section { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 6px; }
.footer-note { margin-top: 20px; padding-top: 14px; border-top: 1px solid #1f2937; font-size: 11px; color: #6b7280; }
.footer-note a { color: #60a5fa; }
.legend { font-size: 11px; color: #94a3b8; }
.legend code { background: #131826; padding: 1px 4px; border-radius: 3px; }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Tenant Matrix · ${escapeHtml(targetWallet.slice(0, 10))} · ${escapeHtml(capturedAt)}</title>
<style>${css}</style>
</head>
<body>
<h1>Tenant Matrix Evaluator</h1>
<div class="sub">
  Target wallet: <code>${escapeHtml(targetWallet)}</code> · target_id: <code>${escapeHtml(targetId)}</code><br/>
  Window: <code>${escapeHtml(window.since)}</code> → <code>${escapeHtml(window.until)}</code> · Captured: <code>${escapeHtml(capturedAt)}</code><br/>
  Control: <strong style="color:#fbbf24">${escapeHtml(tenantLabel(control))}</strong> · ${metrics.length} tenants · Spec: <a href="../../../../docs/spec/poly-tenant-matrix-evaluator.md">poly-tenant-matrix-evaluator</a> · Charter: <a href="../../../../work/charters/POLY_ALGO_TENANT_MATRIX.md">poly-algo-tenant-matrix</a>
</div>

<!-- TAKEAWAY:START -->
<div class="takeaway">
  <h2>↗ Top finding</h2>
  <div class="placeholder">Awaiting LLM-authored takeaway. Read bundle.json + the bar charts below, pick ONE primary finding (max two), cite file:line for any planner claim, include % confidence, acknowledge sample-size floor (decisions &lt; 50 or resolved_markets &lt; 3 → 🟡). Replace between TAKEAWAY:START and TAKEAWAY:END.</div>
</div>
<!-- TAKEAWAY:END -->

<div class="bars-grid">
  <div class="chart">${decisionsSvg}</div>
  <div class="chart">${placedSvg}</div>
  <div class="chart">${placementRateSvg}</div>
  <div class="chart">${intentSvg}</div>
  <div class="chart">${realizedSvg}</div>
  <div class="chart">${openPosSvg}</div>
  <div class="chart">${marketsCountSvg}</div>
</div>

<h3 class="section">A/B vs control (% delta — treatment − control / |control|)</h3>
<table class="ab">
  <thead>
    <tr>
      <th>tenant</th>
      <th class="num">Δ decisions</th>
      <th class="num">Δ placed</th>
      <th class="num">Δ placement rate</th>
      <th class="num">Δ intent $</th>
      <th class="num">Δ realized $</th>
      <th class="num">Δ open positions</th>
    </tr>
  </thead>
  <tbody>
${deltaRows || `<tr><td colspan="7" style="color:#6b7280">No treatment tenants (control-only matrix).</td></tr>`}
  </tbody>
</table>

<div class="legend" style="margin-top: 8px">
  🟡 = low sample (decisions &lt; 50 OR resolved markets &lt; 3) · control row highlighted in <span style="color:#fbbf24">amber</span> · NB: resolved-PnL + winrate axes are v0 deferred (require <code>poly_market_outcomes</code> join — see bundle.json &amp; SKILL.md).
</div>

<div class="footer-note">
  <a href="bundle.json">bundle.json</a> · <a href="findings.json">findings.json</a> · Tool: <code>nodes/poly/scripts/tenant-matrix-evaluator.ts</code> · Skill: <code>/tenant-matrix-evaluator</code>
</div>

</body>
</html>`;
}

// ─── Main orchestration ──────────────────────────────────────────────────────

type CliArgs = {
  targetWallet: string;
  since: string;
  until: string;
  controlEnvKeyPrefix: string | null;
  outDir: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  let since: string | undefined;
  let until: string | undefined;
  let control: string | null = null;
  let out: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--since") since = argv[++i];
    else if (a === "--until") until = argv[++i];
    else if (a === "--control") control = argv[++i] ?? null;
    else if (a === "--out") out = argv[++i] ?? null;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else positional.push(a);
  }
  const target = positional[0];
  if (!target) {
    console.error(
      "usage: tsx nodes/poly/scripts/tenant-matrix-evaluator.ts <target-wallet> [--since ISO] [--until ISO] [--control POLY_<ENV>_TENANT_<ROLE>] [--out path]"
    );
    process.exit(2);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
    console.error(`target-wallet must be 0x + 40 hex: got ${target}`);
    process.exit(2);
  }
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  return {
    targetWallet: target.toLowerCase(),
    since: since ?? dayAgo.toISOString(),
    until: until ?? now.toISOString(),
    controlEnvKeyPrefix: control,
    outDir: out,
  };
}

function pickControl(
  tenants: Tenant[],
  argControl: string | null
): Tenant | null {
  if (argControl) {
    const m = tenants.find((t) => t.envKeyPrefix === argControl);
    if (!m) {
      console.error(
        `--control ${argControl} not found among discovered tenants`
      );
      process.exit(2);
    }
    return m;
  }
  // Default: preview trust-twin per spec.
  return (
    tenants.find(
      (t) => t.envSlug === "preview" && t.role === "TRUST_TWIN"
    ) ?? tenants[0] ?? null
  );
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ event, ts: new Date().toISOString(), ...fields })
  );
}

async function fetchTenantMetrics(
  tenant: Tenant,
  targetWallet: string,
  targetId: string,
  window: { since: string; until: string },
  grafana: { url: string; saToken: string }
): Promise<TenantMetrics> {
  logEvent("evaluator.tenant_query.start", {
    role: tenant.role,
    env: tenant.envSlug,
  });
  const errors: string[] = [];
  // 1. Per-tenant copy-trade-pnl rollup (fills side).
  const pnlUrl = new URL(
    "/api/v1/poly/research/copy-trade-pnl",
    tenant.apiBaseUrl
  );
  pnlUrl.searchParams.set("billing_account_id", tenant.billingAccountId);
  pnlUrl.searchParams.set("mode", "all");
  pnlUrl.searchParams.set("since", window.since);
  pnlUrl.searchParams.set("until", window.until);

  let filteredMarkets: CopyTradePnlMarketRow[] = [];
  let fillsAgg: TenantMetrics["fills"] = {
    markets_count: 0,
    markets_with_open_position: 0,
    fills_count: 0,
    filled_count: 0,
    intent_usdc: 0,
    realized_size_usdc: 0,
  };
  try {
    const resp = await getJson<CopyTradePnlResponse>(
      pnlUrl.toString(),
      tenant.apiKey
    );
    filteredMarkets = filterMarketsByTargetWallet(resp, targetWallet);
    fillsAgg = aggregateFillsForTarget(filteredMarkets);
  } catch (e) {
    errors.push(
      `pnl_fetch_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 2. Per-tenant decisions aggregate (Grafana Postgres).
  const sql = `
    SELECT outcome, reason, COUNT(*)::int AS n
    FROM poly_copy_trade_decisions
    WHERE billing_account_id = '${tenant.billingAccountId}'
      AND target_id = '${targetId}'
      AND decided_at >= '${window.since}'::timestamptz
      AND decided_at <  '${window.until}'::timestamptz
    GROUP BY outcome, reason
    ORDER BY n DESC
  `;
  let decisions: DecisionAgg = {
    decisions: 0,
    placed: 0,
    skipped: 0,
    errored: 0,
    skip_reasons: {},
    error_reasons: {},
  };
  try {
    const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
    decisions = aggregateDecisions(
      rows.map((r) => ({
        outcome: String(r.outcome ?? ""),
        reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
        n: Number(r.n) || 0,
      }))
    );
  } catch (e) {
    errors.push(
      `decisions_query_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const rate = placementRate(decisions);
  // resolved_markets count is v0-deferred (requires market_outcomes join);
  // sample-size floor relies on decisions count for now.
  const low = isLowSample(decisions, /*resolvedMarkets*/ 999);
  const trulyLow = decisions.decisions < 50;

  const result: TenantMetrics = {
    tenant: {
      envLabel: tenant.envLabel,
      role: tenant.role,
      envSlug: tenant.envSlug,
      billingAccountId: tenant.billingAccountId,
      envKeyPrefix: tenant.envKeyPrefix,
    },
    target_id: targetId,
    target_wallet: targetWallet,
    window,
    decisions,
    placement_rate: rate,
    fills: fillsAgg,
    markets: filteredMarkets,
    low_sample: trulyLow || low === true ? trulyLow : false,
    errors,
  };
  logEvent("evaluator.tenant_query.complete", {
    role: tenant.role,
    env: tenant.envSlug,
    decisions: decisions.decisions,
    placed: decisions.placed,
    fills: fillsAgg.fills_count,
    errors: errors.length,
  });
  return result;
}

async function main(): Promise<void> {
  logEvent("evaluator.start");
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const { tenants, errors: discoveryErrors } = discoverTenants(process.env);
  if (discoveryErrors.length > 0) {
    for (const e of discoveryErrors) {
      console.error(
        `half-block detected: ${e.envKeyPrefix}_${e.missing} missing`
      );
    }
    process.exit(2);
  }
  if (tenants.length === 0) {
    console.error(
      "no POLY_<ENV>_TENANT_<ROLE>_* tenant blocks found in process.env — source .env.cogni first"
    );
    process.exit(2);
  }
  const control = pickControl(tenants, args.controlEnvKeyPrefix);
  if (!control) {
    console.error("could not pick a control tenant");
    process.exit(2);
  }

  const grafanaUrl = process.env.GRAFANA_URL;
  const saToken = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  if (!grafanaUrl || !saToken) {
    console.error(
      "GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN required (source .env.cogni)"
    );
    process.exit(2);
  }

  const targetId = uuidv5(
    args.targetWallet.toLowerCase(),
    POLY_TARGET_WALLET_NAMESPACE
  );

  const metrics: TenantMetrics[] = [];
  for (const t of tenants) {
    metrics.push(
      await fetchTenantMetrics(
        t,
        args.targetWallet,
        targetId,
        { since: args.since, until: args.until },
        { url: grafanaUrl, saToken }
      )
    );
  }

  const controlMetrics = metrics.find(
    (m) => m.tenant.envKeyPrefix === control.envKeyPrefix
  );
  if (!controlMetrics) {
    console.error("control metrics missing after fetch");
    process.exit(1);
  }
  const abMatrix: Record<string, AbDelta[]> = {};
  for (const m of metrics) {
    if (m.tenant.envKeyPrefix === control.envKeyPrefix) continue;
    abMatrix[m.tenant.envKeyPrefix] = compareTenants(controlMetrics, m);
  }

  const capturedAt = new Date().toISOString();
  const tsSafe = capturedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir =
    args.outDir ??
    join(REPO_ROOT, "nodes/poly/research/tenant-matrix", tsSafe);
  mkdirSync(outDir, { recursive: true });

  const html = renderReportHtml({
    capturedAt,
    targetWallet: args.targetWallet,
    targetId,
    window: { since: args.since, until: args.until },
    control: controlMetrics,
    metrics,
    abMatrix,
  });
  writeFileSync(join(outDir, "report.html"), html);
  logEvent("evaluator.report.written", { path: join(outDir, "report.html") });

  writeFileSync(
    join(outDir, "bundle.json"),
    JSON.stringify(
      {
        captured_at: capturedAt,
        input: {
          target_wallet: args.targetWallet,
          target_id: targetId,
          control_env_key_prefix: control.envKeyPrefix,
        },
        window: { since: args.since, until: args.until },
        tenants: tenants.map((t) => ({
          envKeyPrefix: t.envKeyPrefix,
          envSlug: t.envSlug,
          role: t.role,
          billingAccountId: t.billingAccountId,
          dsUid: t.dsUid,
          apiBaseUrl: t.apiBaseUrl,
        })),
        control: control.envKeyPrefix,
        metrics,
        ab: abMatrix,
      },
      null,
      2
    )
  );
  logEvent("evaluator.bundle.written", { path: join(outDir, "bundle.json") });

  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify(
      {
        report_path: join(outDir, "report.html"),
        primary_class: "matrix-ab",
        primary_confidence: null,
        primary_one_liner: null,
        secondary_class: null,
        secondary_confidence: null,
        secondary_one_liner: null,
        authored_at: null,
      },
      null,
      2
    )
  );

  logEvent("evaluator.complete", {
    tenants: metrics.length,
    control: control.envKeyPrefix,
    out: outDir,
  });
  console.error(`[tenant-matrix-evaluator] report.html → ${join(outDir, "report.html")}`);
  console.error(`[tenant-matrix-evaluator] bundle.json → ${join(outDir, "bundle.json")}`);
  console.error(`[tenant-matrix-evaluator] findings.json → ${join(outDir, "findings.json")}`);
}

// Only run when invoked directly (tsx ... script.ts), not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
