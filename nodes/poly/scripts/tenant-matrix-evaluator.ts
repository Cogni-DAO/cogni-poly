#!/usr/bin/env tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@nodes/poly/scripts/tenant-matrix-evaluator`
 * Purpose: Cross-policy A/B evaluator across the per-(env, tenant) paper-trading
 *   accounts enumerated in chr.poly-algo-tenant-matrix. Pulls every tenant's
 *   fills + decisions + cumulative time-series over a window, plus the target
 *   wallet's own cumulative trade volume, and renders a paper-accuracy
 *   deep-dive (trust-twin ↔ prod-live) on top of layered line charts for the
 *   outcome-side comparison (cumulative realized $, intent $, fills, vs target).
 * Scope: Read-only research/observation tool. SELECT-only SQL via the Grafana
 *   Postgres datasource (per-env UID). Does NOT mutate any tenant. Does NOT
 *   read the broken `/api/v1/poly/research/copy-trade-pnl` route — every metric
 *   reads `poly_copy_trade_fills` / `poly_copy_trade_decisions` /
 *   `poly_trader_fills` directly.
 * Invariants:
 *   - TENANT_SET_FROM_ENV: tenants discovered by globbing process.env, never hardcoded.
 *   - EVALUATOR_IS_READ_ONLY: every SQL must start SELECT/WITH; no network writes.
 *   - BUNDLE_IS_SOURCE_OF_TRUTH: every cell the report shows is derivable from bundle.json.
 *   - FINDING_IS_LLM_AUTHORED: script writes stubs; the running agent fills the TAKEAWAY + findings.json.
 * Side-effects: IO (Grafana DS query POSTs; filesystem writes under
 *   `nodes/poly/research/tenant-matrix/<iso>/`).
 * Links: docs/spec/poly-tenant-matrix-evaluator.md · work/charters/POLY_ALGO_TENANT_MATRIX.md
 *   · nodes/poly/app/src/features/wallet-analysis/server/copy-trade-pnl-service.ts (SQL mirrored here)
 *   · nodes/poly/app/src/features/wallet-analysis/components/TraderPnlOverlayChart.tsx (visual style reused)
 *   · .claude/skills/tenant-matrix-evaluator/SKILL.md
 * @public
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const POLY_TARGET_WALLET_NAMESPACE = "e2a38b91-7b7d-5f8e-9c0d-4a1e6f8b2c3d";

// Inline UUIDv5 — keeps the script dependency-free across the workspace
// boundary. RFC 4122 §4.3 — matches `uuid` npm v5 + `target-id.ts`.
function uuidv5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (nsBytes.length !== 16) throw new Error(`bad namespace: ${namespace}`);
  const digest = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ─── Tenant discovery ────────────────────────────────────────────────────────

export type Tenant = {
  envLabel: string;
  role: string;
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
  const apiRe =
    /^POLY_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_TENANT_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_API_KEY$/;
  const billingRe =
    /^POLY_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_TENANT_([A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_BILLING_ACCOUNT_ID$/;
  const blocks = new Map<
    string,
    { envLabel: string; role: string; apiKey?: string; billingAccountId?: string }
  >();
  for (const [name, value] of Object.entries(env)) {
    const m = apiRe.exec(name);
    if (!m || !value) continue;
    const envLabel = m[1];
    const role = m[2];
    if (!envLabel || !role) continue;
    const prefix = `POLY_${envLabel}_TENANT_${role}`;
    const cur = blocks.get(prefix) ?? { envLabel, role };
    cur.apiKey = value;
    blocks.set(prefix, cur);
  }
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
      errors.push({ envKeyPrefix: prefix, missing: "API_KEY" });
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
  tenants.sort((a, b) =>
    a.envSlug === b.envSlug
      ? a.role.localeCompare(b.role)
      : a.envSlug.localeCompare(b.envSlug)
  );
  return { tenants, errors };
}

// ─── Grafana Postgres helper (read-only) ─────────────────────────────────────

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

// ─── Types ───────────────────────────────────────────────────────────────────

export type FillsAgg = {
  fills_count: number;
  filled_count: number;
  open_count: number;
  canceled_count: number;
  error_count: number;
  markets_count: number;
  markets_with_open_position: number;
  intent_usdc: number;
  realized_size_usdc: number;
  first_fill_at: string | null;
  last_fill_at: string | null;
};

export type PnlAgg = {
  realized_pnl_usdc: number;
  resolved_markets: number;
  markets_won: number;
  markets_lost: number;
};

export type DecisionAgg = {
  decisions: number;
  placed: number;
  skipped: number;
  errored: number;
  skip_reasons: Record<string, number>;
  error_reasons: Record<string, number>;
};

export type TsPoint = { ts: string; value: number };

export type TenantMetrics = {
  tenant: Pick<
    Tenant,
    "envLabel" | "role" | "envSlug" | "billingAccountId" | "envKeyPrefix"
  >;
  target_id: string;
  target_wallet: string;
  window: { since: string; until: string };
  decisions: DecisionAgg;
  placement_rate: number | null;
  fills: FillsAgg;
  pnl: PnlAgg;
  // Set of bare conditionIds the tenant actually filled into within the window.
  // Used (with target_market_set) to compute market_coverage_pct = shared / target.
  our_market_set: string[];
  market_coverage_pct: number | null; // null when target_market_set is empty
  cumulative: {
    intent_usdc: TsPoint[];
    realized_usdc: TsPoint[];
    fills_count: TsPoint[];
  };
  low_sample: boolean;
  errors: string[];
};

export type TargetSeries = {
  wallet: string;
  cumulative_usdc: TsPoint[];
  market_set: string[]; // bare conditionIds the target traded in window
};

// ─── Pure metric helpers (unit-testable) ─────────────────────────────────────

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

export function isLowSample(agg: DecisionAgg, resolvedMarketsCount: number): boolean {
  return agg.decisions < 50 || resolvedMarketsCount < 3;
}

/**
 * Accumulate hourly buckets into cumulative time-series points. Buckets MUST
 * be ordered ascending. Returns sorted points with running totals.
 */
export function cumulativeFromBuckets(
  buckets: Array<{ ts: string; value: number }>
): TsPoint[] {
  let running = 0;
  return buckets.map((b) => {
    running += b.value;
    return { ts: b.ts, value: running };
  });
}

// ─── Per-tenant queries ──────────────────────────────────────────────────────

async function fetchTenantFillsAgg(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<FillsAgg> {
  // SQL mirrors `copy-trade-pnl-service.ts` but filtered by target_id (not
  // billing_account_id alone) so we only see fills mirrored from this target.
  // observed_at window matches WINDOW_ON_OBSERVED_AT in that service.
  const sql = `
    WITH rolled AS (
      SELECT
        market_id,
        COUNT(*)::int AS fills_count,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS filled_count,
        COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
        COUNT(*) FILTER (WHERE status IN ('canceled','partial'))::int AS canceled_count,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
        COALESCE(SUM(
          CASE WHEN attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (attributes->>'size_usdc')::numeric
               ELSE 0 END
        ), 0)::float8 AS intent_usdc,
        COALESCE(SUM(
          CASE WHEN status IN ('filled','partial')
                AND attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (attributes->>'filled_size_usdc')::numeric
               ELSE 0 END
        ), 0)::float8 AS realized_usdc,
        BOOL_OR(
          (position_lifecycle IS NULL OR position_lifecycle IN ('unresolved','open','closing'))
          AND attributes->>'closed_at' IS NULL
          AND status IN ('pending','open','partial','filled')
        ) AS has_open_position,
        MIN(observed_at) AS first_fill_at,
        MAX(observed_at) AS last_fill_at
      FROM poly_copy_trade_fills
      WHERE billing_account_id = '${tenant.billingAccountId}'
        AND target_id = '${targetId}'
        AND observed_at >= '${window.since}'::timestamptz
        AND observed_at <  '${window.until}'::timestamptz
      GROUP BY market_id
    )
    SELECT
      COALESCE(SUM(fills_count), 0)::int AS fills_count,
      COALESCE(SUM(filled_count), 0)::int AS filled_count,
      COALESCE(SUM(open_count), 0)::int AS open_count,
      COALESCE(SUM(canceled_count), 0)::int AS canceled_count,
      COALESCE(SUM(error_count), 0)::int AS error_count,
      COUNT(*)::int AS markets_count,
      COUNT(*) FILTER (WHERE has_open_position)::int AS markets_with_open_position,
      COALESCE(SUM(intent_usdc), 0)::float8 AS intent_usdc,
      COALESCE(SUM(realized_usdc), 0)::float8 AS realized_size_usdc,
      MIN(first_fill_at) AS first_fill_at,
      MAX(last_fill_at) AS last_fill_at
    FROM rolled
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  const r = rows[0] ?? {};
  return {
    fills_count: Number(r.fills_count) || 0,
    filled_count: Number(r.filled_count) || 0,
    open_count: Number(r.open_count) || 0,
    canceled_count: Number(r.canceled_count) || 0,
    error_count: Number(r.error_count) || 0,
    markets_count: Number(r.markets_count) || 0,
    markets_with_open_position: Number(r.markets_with_open_position) || 0,
    intent_usdc: Number(r.intent_usdc) || 0,
    realized_size_usdc: Number(r.realized_size_usdc) || 0,
    first_fill_at: toIsoMaybe(r.first_fill_at),
    last_fill_at: toIsoMaybe(r.last_fill_at),
  };
}

// Grafana returns timestamp columns as epoch ms (number); jsonb / text columns
// as strings. Accept both.
function toIsoMaybe(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string") {
    // Could be already-ISO or numeric-string epoch.
    if (/^\d+$/.test(v)) return new Date(Number(v)).toISOString();
    return v;
  }
  return null;
}

async function fetchTenantHourlyBuckets(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<{
  intent: Array<{ ts: string; value: number }>;
  realized: Array<{ ts: string; value: number }>;
  fills: Array<{ ts: string; value: number }>;
}> {
  const sql = `
    SELECT
      date_trunc('hour', observed_at) AS bucket,
      COUNT(*)::int AS fills_in_bucket,
      COALESCE(SUM(
        CASE WHEN attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (attributes->>'size_usdc')::numeric
             ELSE 0 END
      ), 0)::float8 AS intent_in_bucket,
      COALESCE(SUM(
        CASE WHEN status IN ('filled','partial')
              AND attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (attributes->>'filled_size_usdc')::numeric
             ELSE 0 END
      ), 0)::float8 AS realized_in_bucket
    FROM poly_copy_trade_fills
    WHERE billing_account_id = '${tenant.billingAccountId}'
      AND target_id = '${targetId}'
      AND observed_at >= '${window.since}'::timestamptz
      AND observed_at <  '${window.until}'::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  const intent: Array<{ ts: string; value: number }> = [];
  const realized: Array<{ ts: string; value: number }> = [];
  const fills: Array<{ ts: string; value: number }> = [];
  for (const r of rows) {
    const ts = toIsoMaybe(r.bucket);
    if (!ts) continue;
    intent.push({ ts, value: Number(r.intent_in_bucket) || 0 });
    realized.push({ ts, value: Number(r.realized_in_bucket) || 0 });
    fills.push({ ts, value: Number(r.fills_in_bucket) || 0 });
  }
  return { intent, realized, fills };
}

async function fetchTenantRealizedPnl(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<PnlAgg> {
  // Realized PnL only — open positions are NOT priced.
  // Resolved markets: outcome ∈ {winner, loser}; payout defaults to $1 for winners.
  // For paper rows v0 stamps filled_size_usdc = intent.size_usdc, so PnL math
  // uses (filled_size_usdc / limit_price) as shares.
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN o.outcome = 'winner'
            AND f.attributes->>'limit_price' ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'limit_price')::numeric > 0
          THEN ((f.attributes->>'filled_size_usdc')::numeric / (f.attributes->>'limit_price')::numeric)
               * COALESCE(o.payout, 1.0)::numeric
               - (f.attributes->>'filled_size_usdc')::numeric
          WHEN o.outcome = 'loser'
          THEN -(f.attributes->>'filled_size_usdc')::numeric
          ELSE 0
        END
      ), 0)::float8 AS realized_pnl_usdc,
      COUNT(DISTINCT f.market_id) FILTER (WHERE o.outcome IN ('winner','loser'))::int AS resolved_markets,
      COUNT(DISTINCT f.market_id) FILTER (WHERE o.outcome = 'winner')::int AS markets_won,
      COUNT(DISTINCT f.market_id) FILTER (WHERE o.outcome = 'loser')::int AS markets_lost
    FROM poly_copy_trade_fills f
    LEFT JOIN poly_market_outcomes o
      ON o.condition_id = f.attributes->>'condition_id'
     AND o.token_id     = f.attributes->>'token_id'
    WHERE f.billing_account_id = '${tenant.billingAccountId}'
      AND f.target_id = '${targetId}'
      AND f.observed_at >= '${window.since}'::timestamptz
      AND f.observed_at <  '${window.until}'::timestamptz
      AND f.status IN ('filled','partial')
      AND f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  const r = rows[0] ?? {};
  return {
    realized_pnl_usdc: Number(r.realized_pnl_usdc) || 0,
    resolved_markets: Number(r.resolved_markets) || 0,
    markets_won: Number(r.markets_won) || 0,
    markets_lost: Number(r.markets_lost) || 0,
  };
}

async function fetchTenantMarketSet(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<string[]> {
  const sql = `
    SELECT DISTINCT attributes->>'condition_id' AS cond
    FROM poly_copy_trade_fills
    WHERE billing_account_id = '${tenant.billingAccountId}'
      AND target_id = '${targetId}'
      AND status IN ('filled','partial')
      AND observed_at >= '${window.since}'::timestamptz
      AND observed_at <  '${window.until}'::timestamptz
      AND attributes->>'condition_id' IS NOT NULL
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  return rows
    .map((r) => (typeof r.cond === "string" ? r.cond : null))
    .filter((c): c is string => c !== null);
}

async function fetchTargetMarketSet(
  grafana: { url: string; saToken: string },
  targetDsUid: string,
  targetWallet: string,
  window: { since: string; until: string }
): Promise<string[]> {
  const sql = `
    SELECT DISTINCT f.condition_id AS cond
    FROM poly_trader_fills f
    JOIN poly_trader_wallets w ON w.id = f.trader_wallet_id
    WHERE LOWER(w.wallet_address) = LOWER('${targetWallet}')
      AND f.observed_at >= '${window.since}'::timestamptz
      AND f.observed_at <  '${window.until}'::timestamptz
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, targetDsUid, sql);
  return rows
    .map((r) => (typeof r.cond === "string" ? r.cond : null))
    .filter((c): c is string => c !== null);
}

export function marketCoverage(
  ourSet: string[],
  targetSet: string[]
): number | null {
  if (targetSet.length === 0) return null;
  const target = new Set(targetSet);
  let shared = 0;
  for (const c of ourSet) if (target.has(c)) shared++;
  return shared / targetSet.length;
}

// Per-fill decision list — used for true paper-fidelity check (twin ↔ live by fill_id).
async function fetchTenantDecisionList(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<Array<{ fill_id: string; outcome: string; reason: string | null }>> {
  const sql = `
    SELECT fill_id, outcome, reason
    FROM poly_copy_trade_decisions
    WHERE billing_account_id = '${tenant.billingAccountId}'
      AND target_id = '${targetId}'
      AND decided_at >= '${window.since}'::timestamptz
      AND decided_at <  '${window.until}'::timestamptz
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  return rows
    .map((r) => ({
      fill_id: typeof r.fill_id === "string" ? r.fill_id : "",
      outcome: typeof r.outcome === "string" ? r.outcome : "",
      reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    }))
    .filter((d) => d.fill_id !== "");
}

export type DecisionFidelity = {
  shared_fills: number; // fill_ids both tenants decided on
  exact_match: number; // same outcome + same reason
  outcome_match_reason_diff: number; // same outcome, different reason
  outcome_disagree: number; // different outcome
  twin_only_fills: number; // fill_id in twin but not live (poll-timing miss)
  live_only_fills: number;
  // Top mismatch reasons — what's actually causing the drift?
  top_mismatches: Array<{ twin_outcome: string; twin_reason: string | null; live_outcome: string; live_reason: string | null; count: number }>;
};

export function decisionFidelity(
  twin: Array<{ fill_id: string; outcome: string; reason: string | null }>,
  live: Array<{ fill_id: string; outcome: string; reason: string | null }>
): DecisionFidelity {
  // Group by fill_id; a tenant can decide on the same fill multiple times
  // (followups within the same target fill_id). Take the FIRST decision per
  // fill_id per tenant as canonical for the match check.
  const twinByFill = new Map<string, { outcome: string; reason: string | null }>();
  for (const d of twin) if (!twinByFill.has(d.fill_id)) twinByFill.set(d.fill_id, d);
  const liveByFill = new Map<string, { outcome: string; reason: string | null }>();
  for (const d of live) if (!liveByFill.has(d.fill_id)) liveByFill.set(d.fill_id, d);

  let exact = 0;
  let outcomeMatch = 0;
  let outcomeDiff = 0;
  let twinOnly = 0;
  let liveOnly = 0;
  const mismatchCounts = new Map<string, { twin_outcome: string; twin_reason: string | null; live_outcome: string; live_reason: string | null; count: number }>();
  const allFills = new Set([...twinByFill.keys(), ...liveByFill.keys()]);
  for (const fid of allFills) {
    const t = twinByFill.get(fid);
    const l = liveByFill.get(fid);
    if (t && !l) {
      twinOnly++;
      continue;
    }
    if (l && !t) {
      liveOnly++;
      continue;
    }
    if (!t || !l) continue; // unreachable but TS
    if (t.outcome === l.outcome && (t.reason ?? "") === (l.reason ?? "")) {
      exact++;
    } else if (t.outcome === l.outcome) {
      outcomeMatch++;
      const key = `${t.outcome}:${t.reason ?? ""}|${l.outcome}:${l.reason ?? ""}`;
      const ex = mismatchCounts.get(key);
      if (ex) ex.count++;
      else
        mismatchCounts.set(key, {
          twin_outcome: t.outcome,
          twin_reason: t.reason,
          live_outcome: l.outcome,
          live_reason: l.reason,
          count: 1,
        });
    } else {
      outcomeDiff++;
      const key = `${t.outcome}:${t.reason ?? ""}|${l.outcome}:${l.reason ?? ""}`;
      const ex = mismatchCounts.get(key);
      if (ex) ex.count++;
      else
        mismatchCounts.set(key, {
          twin_outcome: t.outcome,
          twin_reason: t.reason,
          live_outcome: l.outcome,
          live_reason: l.reason,
          count: 1,
        });
    }
  }
  const shared = exact + outcomeMatch + outcomeDiff;
  const top_mismatches = [...mismatchCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    shared_fills: shared,
    exact_match: exact,
    outcome_match_reason_diff: outcomeMatch,
    outcome_disagree: outcomeDiff,
    twin_only_fills: twinOnly,
    live_only_fills: liveOnly,
    top_mismatches,
  };
}

async function fetchTenantDecisionsAgg(
  grafana: { url: string; saToken: string },
  tenant: Tenant,
  targetId: string,
  window: { since: string; until: string }
): Promise<DecisionAgg> {
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
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, tenant.dsUid, sql);
  return aggregateDecisions(
    rows.map((r) => ({
      outcome: String(r.outcome ?? ""),
      reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
      n: Number(r.n) || 0,
    }))
  );
}

// Target wallet's own cumulative trade volume from poly_trader_fills.
// Joined to poly_trader_wallets by wallet_address. Always queried against the
// production DS — target activity is identical across envs.
async function fetchTargetHourlyVolume(
  grafana: { url: string; saToken: string },
  targetDsUid: string,
  targetWallet: string,
  window: { since: string; until: string }
): Promise<Array<{ ts: string; value: number }>> {
  const sql = `
    SELECT
      date_trunc('hour', f.observed_at) AS bucket,
      COALESCE(SUM(f.size_usdc), 0)::float8 AS usdc_in_bucket
    FROM poly_trader_fills f
    JOIN poly_trader_wallets w ON w.id = f.trader_wallet_id
    WHERE LOWER(w.wallet_address) = LOWER('${targetWallet}')
      AND f.observed_at >= '${window.since}'::timestamptz
      AND f.observed_at <  '${window.until}'::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;
  const rows = await grafanaPgQuery(grafana.url, grafana.saToken, targetDsUid, sql);
  return rows
    .map((r) => ({
      ts: toIsoMaybe(r.bucket) ?? "",
      value: Number(r.usdc_in_bucket) || 0,
    }))
    .filter((p) => p.ts !== "");
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
  delta_pct: number | null;
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
      delta === null || c === null || c === 0 ? null : delta / Math.abs(c);
    return { axis, control: c, treatment: t, delta, delta_pct };
  });
}

// ─── SVG rendering ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt$(n: number, signed = false): string {
  const abs = Math.abs(n);
  const s = !signed ? "" : n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1000) return `${s}$${(abs / 1000).toFixed(1)}k`;
  return `${s}$${abs.toFixed(abs >= 10 ? 0 : 2)}`;
}

function fmtTickDate(ts: string): string {
  const d = new Date(ts);
  const mo = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hr = d.getUTCHours().toString().padStart(2, "0");
  return `${mo} ${day} ${hr}:00`;
}

const SERIES_COLORS = [
  "#fbbf24", // amber — reserved for control
  "#60a5fa", // sky-blue
  "#34d399", // emerald
  "#f472b6", // pink
  "#a78bfa", // purple
  "#fb7185", // rose
  "#22d3ee", // cyan
];

type Series = { label: string; color: string; points: TsPoint[] };

function svgLineChart(args: {
  title: string;
  series: Series[];
  xRange: { since: Date; until: Date };
  yFmt?: (v: number) => string;
  height?: number;
  yLabel?: string;
}): string {
  const W = 1100;
  const H = args.height ?? 280;
  const PAD = { top: 44, right: 24, bottom: 36, left: 76 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const tStart = args.xRange.since.getTime();
  const tEnd = args.xRange.until.getTime();
  const tSpan = Math.max(1, tEnd - tStart);

  let maxV = 0;
  let minV = 0;
  for (const s of args.series) {
    for (const p of s.points) {
      if (p.value > maxV) maxV = p.value;
      if (p.value < minV) minV = p.value;
    }
  }
  if (maxV === 0 && minV === 0) maxV = 1;
  const vSpan = Math.max(1, maxV - minV);

  const x = (ts: string): number => {
    const t = new Date(ts).getTime();
    return PAD.left + ((t - tStart) / tSpan) * cW;
  };
  const y = (v: number): number =>
    PAD.top + cH - ((v - minV) / vSpan) * cH;
  const yFmt = args.yFmt ?? ((v) => fmt$(v));

  // Y-axis ticks at 0, 25, 50, 75, 100% of range.
  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) yTicks.push(minV + (vSpan * i) / 4);

  // X-axis: 5 ticks evenly spaced.
  const xTicks: number[] = [];
  for (let i = 0; i <= 4; i++) xTicks.push(tStart + (tSpan * i) / 4);

  const gridLines = yTicks
    .map(
      (v) =>
        `<line x1="${PAD.left}" y1="${y(v)}" x2="${PAD.left + cW}" y2="${y(v)}" stroke="#1f2937" stroke-width="0.5"/>`
    )
    .join("");

  const yLabels = yTicks
    .map(
      (v) =>
        `<text x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">${escapeHtml(yFmt(v))}</text>`
    )
    .join("");

  const xLabels = xTicks
    .map((t) => {
      const ts = new Date(t).toISOString();
      const xc = PAD.left + ((t - tStart) / tSpan) * cW;
      return `<text x="${xc}" y="${PAD.top + cH + 20}" text-anchor="middle" class="axis">${escapeHtml(fmtTickDate(ts))}</text>`;
    })
    .join("");

  // Build polyline + area for each series.
  let paths = "";
  let gradients = "";
  args.series.forEach((s, i) => {
    if (s.points.length === 0) return;
    const pts = s.points
      .slice()
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const linePts = pts.map((p) => `${x(p.ts)},${y(p.value)}`).join(" ");
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return;
    const areaPath =
      `M ${x(first.ts)},${y(0)} ` +
      pts.map((p) => `L ${x(p.ts)},${y(p.value)}`).join(" ") +
      ` L ${x(last.ts)},${y(0)} Z`;
    gradients += `<linearGradient id="grad-${i}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0.0"/>
    </linearGradient>`;
    paths += `<path d="${areaPath}" fill="url(#grad-${i})" />`;
    paths += `<polyline points="${linePts}" fill="none" stroke="${s.color}" stroke-width="1.75" stroke-linejoin="round"/>`;
  });

  // Zero line emphasis if min crosses 0.
  const zeroLine =
    minV <= 0 && maxV >= 0
      ? `<line x1="${PAD.left}" y1="${y(0)}" x2="${PAD.left + cW}" y2="${y(0)}" stroke="#475569" stroke-width="1"/>`
      : "";

  // Legend at top-left of chart area.
  const legend = args.series
    .map((s, i) => {
      const xOff = PAD.left + i * 168;
      return `<g transform="translate(${xOff}, ${PAD.top - 22})">
        <rect width="10" height="10" rx="2" fill="${s.color}"/>
        <text x="16" y="9" class="legend">${escapeHtml(s.label)}</text>
      </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" class="line-chart">
  <defs>${gradients}</defs>
  <text x="12" y="20" class="chart-title">${escapeHtml(args.title)}${args.yLabel ? ` <tspan fill="#6b7280" font-weight="400"> · ${escapeHtml(args.yLabel)}</tspan>` : ""}</text>
  ${legend}
  ${gridLines}
  ${zeroLine}
  ${paths}
  ${yLabels}
  ${xLabels}
</svg>`;
}

// ─── HTML report ─────────────────────────────────────────────────────────────

function renderReportHtml(args: {
  capturedAt: string;
  targetWallet: string;
  targetId: string;
  window: { since: string; until: string };
  metrics: TenantMetrics[];
  control: TenantMetrics;
  prodLive: TenantMetrics | null;
  target: TargetSeries;
  abMatrix: Record<string, AbDelta[]>;
  fidelity: DecisionFidelity | null;
}): string {
  const {
    capturedAt,
    targetWallet,
    window,
    metrics,
    control,
    prodLive,
    target,
    abMatrix,
    fidelity,
  } = args;

  const since = new Date(window.since);
  const until = new Date(window.until);

  const tenantLabel = (m: TenantMetrics): string =>
    `${m.tenant.role} · ${m.tenant.envSlug}`;
  const colorFor = (m: TenantMetrics): string => {
    if (m.tenant.envKeyPrefix === control.tenant.envKeyPrefix) return SERIES_COLORS[0]!;
    const idx = metrics
      .filter((x) => x.tenant.envKeyPrefix !== control.tenant.envKeyPrefix)
      .findIndex((x) => x.tenant.envKeyPrefix === m.tenant.envKeyPrefix);
    return SERIES_COLORS[(idx + 1) % SERIES_COLORS.length]!;
  };

  // ── Q1: paper fidelity ─────────────────────────────────────────────────────
  const exactPct = fidelity && fidelity.shared_fills > 0
    ? fidelity.exact_match / fidelity.shared_fills
    : null;
  const q1Cls = exactPct === null ? "" : exactPct >= 0.99 ? "pos" : "neg";
  const q1Number = exactPct === null ? "—" : `${(exactPct * 100).toFixed(1)}%`;
  const q1Verdict =
    exactPct === null
      ? "no shared fills to compare"
      : exactPct >= 0.99
        ? "YES — paper twin matches prod"
        : "NO — paper twin does NOT match prod";
  const topMm = fidelity?.top_mismatches[0];
  const q1Cause = topMm
    ? `Biggest mismatch: <code>${topMm.count}</code> fills where TWIN said <code>${escapeHtml(topMm.twin_outcome)}${topMm.twin_reason ? `(${escapeHtml(topMm.twin_reason)})` : ""}</code> but LIVE said <code>${escapeHtml(topMm.live_outcome)}${topMm.live_reason ? `(${escapeHtml(topMm.live_reason)})` : ""}</code>.`
    : "";

  // ── Q2: best paper algo ────────────────────────────────────────────────────
  const isProdLive = (m: TenantMetrics): boolean =>
    m.tenant.envSlug === "production" && m.tenant.role === "LIVE";
  const paperRows = metrics
    .filter((m) => !isProdLive(m))
    .sort((a, b) => {
      const pnlDiff = b.pnl.realized_pnl_usdc - a.pnl.realized_pnl_usdc;
      if (pnlDiff !== 0) return pnlDiff;
      return (b.market_coverage_pct ?? -1) - (a.market_coverage_pct ?? -1);
    });
  const prodLiveRow = metrics.find(isProdLive) ?? null;
  const winner = paperRows[0];
  const ranksTrustworthy = exactPct !== null && exactPct >= 0.99;
  const fmtPnl = (n: number): string => {
    const sign = n < 0 ? "−" : n > 0 ? "+" : "";
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  };
  const winnerPnl = winner?.pnl.realized_pnl_usdc ?? 0;
  const winnerLow = (winner?.pnl.resolved_markets ?? 0) < 3;
  const q2Cls = !ranksTrustworthy
    ? "gated"
    : winnerPnl > 0
      ? "pos"
      : winnerPnl < 0
        ? "neg"
        : "";
  const q2Number = !ranksTrustworthy
    ? "GATED"
    : winnerLow
      ? "LOW SAMPLE"
      : winner
        ? fmtPnl(winnerPnl)
        : "—";
  const q2Verdict = !ranksTrustworthy
    ? `wait — Q1 must pass first (currently ${q1Number})`
    : winnerLow
      ? `${winner ? tenantLabel(winner) : "—"} leads but only ${winner?.pnl.resolved_markets ?? 0} resolved markets`
      : winner
        ? `${tenantLabel(winner)} — ${winner.pnl.markets_won}W / ${winner.pnl.markets_lost}L`
        : "no paper tenants in matrix";
  const q2Ref = prodLiveRow
    ? `prod LIVE reference: <code>${fmtPnl(prodLiveRow.pnl.realized_pnl_usdc)}</code> over <code>${prodLiveRow.pnl.resolved_markets}</code> resolved markets`
    : "";

  // ── Appendix bits (computed once) ──────────────────────────────────────────
  const mismatchTable =
    fidelity && fidelity.top_mismatches.length > 0
      ? `<table class="ab"><thead><tr><th>twin said</th><th>live said</th><th class="num">count</th></tr></thead><tbody>${fidelity.top_mismatches
          .map(
            (m) =>
              `<tr><td>${escapeHtml(m.twin_outcome)}${m.twin_reason ? ` <span class="muted">(${escapeHtml(m.twin_reason)})</span>` : ""}</td><td>${escapeHtml(m.live_outcome)}${m.live_reason ? ` <span class="muted">(${escapeHtml(m.live_reason)})</span>` : ""}</td><td class="num"><strong>${m.count}</strong></td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="muted">no mismatch data</p>`;

  const fidelitySummary = fidelity
    ? `<p class="muted">shared fills: <code>${fidelity.shared_fills}</code> · exact match: <code>${fidelity.exact_match}</code> · outcome match but reason differs: <code>${fidelity.outcome_match_reason_diff}</code> · outcome disagree: <code>${fidelity.outcome_disagree}</code> · twin-only: <code>${fidelity.twin_only_fills}</code> · live-only: <code>${fidelity.live_only_fills}</code></p>`
    : "";

  const targetVol =
    target.cumulative_usdc.length > 0
      ? target.cumulative_usdc[target.cumulative_usdc.length - 1]!.value
      : 0;
  const targetMarketCount = target.market_set.length;
  const rankRows = [...paperRows, ...(prodLiveRow ? [prodLiveRow] : [])];
  const algoTable = `<table class="ab algo"><thead><tr><th>tenant</th><th class="num">PnL $</th><th class="num">resolved</th><th class="num">W/L</th><th class="num">Δ vs swisstony</th><th class="num">$ filled</th><th class="num">capture %</th></tr></thead><tbody>${rankRows
    .map((m, idx) => {
      const pnl = m.pnl.realized_pnl_usdc;
      const pnlCls = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "";
      const cov = m.market_coverage_pct;
      const delta = cov === null ? null : 1 - cov;
      const lowSample = m.pnl.resolved_markets < 3;
      const refRow = isProdLive(m);
      const trCls = refRow ? "ref" : idx === 0 && !refRow ? "rank-1" : "";
      const capture = targetVol === 0 ? null : m.fills.realized_size_usdc / targetVol;
      const refTag = refRow ? " (prod ref)" : "";
      const ctlTag = m.tenant.envKeyPrefix === control.tenant.envKeyPrefix ? " (control)" : "";
      const trophy = idx === 0 && !refRow && ranksTrustworthy ? " 🏆" : "";
      return `<tr class="${trCls}"><td class="role" style="color:${colorFor(m)}">${escapeHtml(tenantLabel(m))}${ctlTag}${refTag}${trophy}</td><td class="num ${pnlCls}"><strong>${fmtPnl(pnl)}</strong>${lowSample ? " 🟡" : ""}</td><td class="num">${m.pnl.resolved_markets}</td><td class="num">${m.pnl.markets_won}/${m.pnl.markets_lost}</td><td class="num">${delta === null ? "—" : `${(delta * 100).toFixed(1)}%`}</td><td class="num">$${m.fills.realized_size_usdc.toFixed(2)}</td><td class="num">${capture === null ? "—" : `${(capture * 100).toFixed(3)}%`}</td></tr>`;
    })
    .join("")}</tbody></table>`;

  const filledChartTwinLive = prodLive
    ? svgLineChart({
        title: "$ filled — twin vs live",
        series: [
          { label: "TWIN · paper", color: SERIES_COLORS[0]!, points: control.cumulative.realized_usdc },
          { label: "LIVE · real", color: SERIES_COLORS[2]!, points: prodLive.cumulative.realized_usdc },
        ],
        xRange: { since, until },
        height: 260,
      })
    : "";
  const filledChartAllTenants = svgLineChart({
    title: "$ filled — all paper tenants",
    series: metrics.map((m) => ({
      label: tenantLabel(m),
      color: colorFor(m),
      points: m.cumulative.realized_usdc,
    })),
    xRange: { since, until },
    height: 280,
  });

  const decisionsRefRows = [...metrics]
    .sort((a, b) =>
      a.tenant.envKeyPrefix === control.tenant.envKeyPrefix
        ? -1
        : b.tenant.envKeyPrefix === control.tenant.envKeyPrefix
          ? 1
          : a.tenant.envKeyPrefix.localeCompare(b.tenant.envKeyPrefix)
    )
    .map((m) => {
      const skipKeys = Object.keys(m.decisions.skip_reasons).sort(
        (a, b) =>
          (m.decisions.skip_reasons[b] ?? 0) - (m.decisions.skip_reasons[a] ?? 0)
      );
      const top3 = skipKeys.slice(0, 3).map((k) => `${k}=${m.decisions.skip_reasons[k]}`).join(" · ");
      const ab = abMatrix[m.tenant.envKeyPrefix] ?? [];
      const dRate = ab.find((d) => d.axis === "placement_rate");
      const ratePctCell =
        m.tenant.envKeyPrefix === control.tenant.envKeyPrefix
          ? "—"
          : dRate?.delta_pct === null || dRate === undefined
            ? "—"
            : `${(dRate.delta_pct * 100).toFixed(1)}%`;
      return `<tr><td class="role" style="color:${colorFor(m)}">${escapeHtml(tenantLabel(m))}${m.low_sample ? " 🟡" : ""}</td><td class="num">${m.decisions.decisions}</td><td class="num">${m.decisions.placed}</td><td class="num">${m.placement_rate === null ? "—" : `${(m.placement_rate * 100).toFixed(2)}%`}</td><td class="num">${ratePctCell}</td><td class="skips">${escapeHtml(top3)}</td></tr>`;
    })
    .join("");

  const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; margin: 0 auto; padding: 22px; max-width: 1100px; line-height: 1.45; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 2px; }
.header-sub { color: #6b7280; font-size: 11px; margin-bottom: 16px; }
.header-sub code { background: #131826; padding: 1px 5px; border-radius: 3px; }
.header-sub a { color: #60a5fa; }
.q { background: linear-gradient(180deg, #0f172a 0%, #131826 100%); border: 2px solid #475569; border-radius: 10px; padding: 22px 26px; margin: 0 0 16px; }
.q.pos { border-color: #22c55e; }
.q.neg { border-color: #ef4444; }
.q.gated { border-color: #6b7280; border-style: dashed; opacity: 0.85; }
.q-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700; }
.q-number { font-size: 56px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.0; margin: 6px 0 0; color: #e5e7eb; }
.q.pos .q-number { color: #22c55e; }
.q.neg .q-number { color: #ef4444; }
.q.gated .q-number { color: #94a3b8; font-size: 36px; letter-spacing: 0.04em; }
.q-verdict { font-size: 15px; font-weight: 600; color: #e5e7eb; margin: 4px 0 8px; }
.q-cause { font-size: 12px; color: #cbd5e1; }
.q-cause code { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; color: #fbbf24; font-size: 11px; }
.q-ref { font-size: 11px; color: #94a3b8; margin-top: 6px; }
.q-ref code { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; color: #cbd5e1; }
.takeaway { background: linear-gradient(180deg, #1f1410 0%, #131826 100%); border: 1px solid #f59e0b; border-radius: 8px; padding: 14px 18px; margin: 0 0 16px; }
.takeaway h2 { margin: 0 0 8px; font-size: 11px; color: #fbbf24; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.takeaway .placeholder { color: #64748b; font-style: italic; font-size: 11px; }
details { background: #0e1422; border: 1px solid #1f2937; border-radius: 6px; padding: 0; margin: 10px 0; }
details > summary { cursor: pointer; padding: 12px 16px; font-size: 12px; color: #cbd5e1; font-weight: 600; user-select: none; }
details > summary:hover { background: #131826; }
details[open] > summary { border-bottom: 1px solid #1f2937; color: #fbbf24; }
details > .details-body { padding: 14px 16px; }
.muted { color: #6b7280; font-size: 11px; }
.muted code { background: #131826; padding: 1px 4px; border-radius: 3px; color: #cbd5e1; }
table.ab { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0; }
table.ab th { font-size: 10px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 7px 9px; background: #131826; border-bottom: 1px solid #1f2937; }
table.ab td { padding: 7px 9px; border-bottom: 1px solid #1f2937; font-variant-numeric: tabular-nums; }
table.ab td.num { text-align: right; font-family: 'SF Mono', Menlo, monospace; }
table.ab td.role { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; }
table.ab td.skips { font-family: 'SF Mono', Menlo, monospace; font-size: 10px; color: #94a3b8; max-width: 380px; }
table.ab.algo tr.rank-1 td { background: rgba(251,191,36,0.08); }
table.ab.algo tr.rank-1 td.role { color: #fbbf24 !important; font-weight: 600; }
table.ab.algo tr.ref td { background: rgba(16,185,129,0.05); border-top: 2px solid #1f2937; }
table.ab.algo tr.ref td.role { color: #34d399 !important; font-style: italic; }
.pos { color: #22c55e; } .neg { color: #ef4444; }
.chart { background: #0e1422; border: 1px solid #1f2937; border-radius: 6px; padding: 6px; margin: 10px 0; }
.chart svg { display: block; width: 100%; height: auto; }
.line-chart .chart-title { fill: #cbd5e1; font-size: 13px; font-weight: 600; }
.line-chart .axis { fill: #94a3b8; font-size: 10px; font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; }
.line-chart .legend { fill: #cbd5e1; font-size: 11px; font-family: 'SF Mono', Menlo, monospace; }
.footer-note { margin-top: 18px; padding-top: 12px; border-top: 1px solid #1f2937; font-size: 10px; color: #6b7280; }
.footer-note a { color: #60a5fa; }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Tenant Matrix · ${escapeHtml(targetWallet.slice(0, 10))}</title>
<style>${css}</style>
</head>
<body>
<h1>Tenant Matrix Evaluator</h1>
<div class="header-sub">
  Target: <code>${escapeHtml(targetWallet)}</code> · Window: <code>${escapeHtml(window.since)}</code> → <code>${escapeHtml(window.until)}</code> · ${metrics.length} tenants · <a href="#appendix">↓ jump to appendix</a>
</div>

<!-- TAKEAWAY:START -->
<div class="takeaway">
  <h2>↗ LLM takeaway (optional)</h2>
  <div class="placeholder">One primary finding (max two), % confidence, cite file:line for any planner claim.</div>
</div>
<!-- TAKEAWAY:END -->

<div class="q ${q1Cls}">
  <div class="q-label">Q1 · Does paper twin match prod live?</div>
  <div class="q-number">${q1Number}</div>
  <div class="q-verdict">${escapeHtml(q1Verdict)}</div>
  <div class="q-cause">${q1Cause}</div>
</div>

<div class="q ${q2Cls}">
  <div class="q-label">Q2 · Best paper algo (PnL on resolved markets)</div>
  <div class="q-number">${q2Number}</div>
  <div class="q-verdict">${escapeHtml(q2Verdict)}</div>
  ${q2Ref ? `<div class="q-ref">${q2Ref}</div>` : ""}
</div>

<a id="appendix"></a>

<details>
  <summary>📊 Q1 detail — top decision mismatches (twin vs live)</summary>
  <div class="details-body">
    ${fidelitySummary}
    ${mismatchTable}
    <p class="muted" style="margin-top: 12px">Visual sanity check — cumulative <code>$ filled</code> by tenant. Visual diverges from numbers when one tenant filled mostly outside the window; trust the table above.</p>
    <div class="chart">${filledChartTwinLive}</div>
  </div>
</details>

<details>
  <summary>📊 Q2 detail — full ranking (all paper tenants + prod reference)</summary>
  <div class="details-body">
    <p class="muted">swisstony traded <code>${targetMarketCount}</code> markets totaling <code>$${targetVol.toFixed(2)}</code>. <code>PnL $</code> = realized gain/loss on markets resolved in window. <code>Δ vs swisstony</code> = 100% − (our markets ∩ swisstony's markets) ÷ swisstony's markets.</p>
    ${algoTable}
    <div class="chart">${filledChartAllTenants}</div>
  </div>
</details>

<details>
  <summary>🔍 Decisions reference — skip-reason breakdown per tenant</summary>
  <div class="details-body">
    <p class="muted">Why did orders not place? Decision-side counts and top 3 skip reasons per tenant. Explanatory only — NOT a ranking surface.</p>
    <table class="ab">
      <thead><tr><th>tenant</th><th class="num">decisions</th><th class="num">placed</th><th class="num">placement rate</th><th class="num">Δ rate vs control</th><th>top skip reasons</th></tr></thead>
      <tbody>${decisionsRefRows}</tbody>
    </table>
  </div>
</details>

<details>
  <summary>🤖 AI agent appendix — what to investigate next</summary>
  <div class="details-body">
    <p class="muted">If <strong>Q1 &lt; 99%</strong>: paper sidecar is missing planner gates. Top mismatch reason names the gate (e.g. <code>followup_position_too_small</code> means the paper sidecar's planner is letting through orders the live planner correctly skips). Cite <code>nodes/poly/sidecars/paper-trader/server.py</code> or the planner gate in <code>nodes/poly/app/src/features/copy-trade/plan-mirror.ts</code> in the LLM finding.</p>
    <p class="muted">If <strong>Q2 is GATED</strong>: do NOT promote any paper policy. Fix Q1 first. If Q2 is ungated and a paper tenant beats prod ref with ≥3 resolved markets, that's the promotion candidate.</p>
    <p class="muted">Many <strong>live-only fills</strong> (in mismatch summary) = twin's wallet-watch missed entire chunks of target activity. Check poll cadence + websocket health.</p>
    <p class="muted">Full structured data: <a href="bundle.json">bundle.json</a> · LLM stub: <a href="findings.json">findings.json</a>.</p>
  </div>
</details>

<div class="footer-note">
  Tool: <code>nodes/poly/scripts/tenant-matrix-evaluator.ts</code> · Skill: <code>/tenant-matrix-evaluator</code> · Captured: <code>${escapeHtml(capturedAt)}</code>
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

function pickControl(tenants: Tenant[], argControl: string | null): Tenant | null {
  if (argControl) {
    const m = tenants.find((t) => t.envKeyPrefix === argControl);
    if (!m) {
      console.error(`--control ${argControl} not found among discovered tenants`);
      process.exit(2);
    }
    return m;
  }
  return (
    tenants.find((t) => t.envSlug === "preview" && t.role === "TRUST_TWIN") ??
    tenants[0] ??
    null
  );
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

async function fetchTenant(
  tenant: Tenant,
  targetWallet: string,
  targetId: string,
  targetMarketSet: string[],
  window: { since: string; until: string },
  grafana: { url: string; saToken: string }
): Promise<TenantMetrics> {
  logEvent("evaluator.tenant_query.start", {
    role: tenant.role,
    env: tenant.envSlug,
  });
  const errors: string[] = [];
  let fills: FillsAgg = {
    fills_count: 0,
    filled_count: 0,
    open_count: 0,
    canceled_count: 0,
    error_count: 0,
    markets_count: 0,
    markets_with_open_position: 0,
    intent_usdc: 0,
    realized_size_usdc: 0,
    first_fill_at: null,
    last_fill_at: null,
  };
  let buckets: {
    intent: Array<{ ts: string; value: number }>;
    realized: Array<{ ts: string; value: number }>;
    fills: Array<{ ts: string; value: number }>;
  } = { intent: [], realized: [], fills: [] };
  let decisions: DecisionAgg = {
    decisions: 0,
    placed: 0,
    skipped: 0,
    errored: 0,
    skip_reasons: {},
    error_reasons: {},
  };
  try {
    fills = await fetchTenantFillsAgg(grafana, tenant, targetId, window);
  } catch (e) {
    errors.push(`fills_agg_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    buckets = await fetchTenantHourlyBuckets(grafana, tenant, targetId, window);
  } catch (e) {
    errors.push(`buckets_query_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    decisions = await fetchTenantDecisionsAgg(grafana, tenant, targetId, window);
  } catch (e) {
    errors.push(
      `decisions_query_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  let pnl: PnlAgg = {
    realized_pnl_usdc: 0,
    resolved_markets: 0,
    markets_won: 0,
    markets_lost: 0,
  };
  try {
    pnl = await fetchTenantRealizedPnl(grafana, tenant, targetId, window);
  } catch (e) {
    errors.push(`pnl_query_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let ourMarketSet: string[] = [];
  try {
    ourMarketSet = await fetchTenantMarketSet(grafana, tenant, targetId, window);
  } catch (e) {
    errors.push(
      `market_set_query_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const coverage = marketCoverage(ourMarketSet, targetMarketSet);
  const cumulative = {
    intent_usdc: cumulativeFromBuckets(buckets.intent),
    realized_usdc: cumulativeFromBuckets(buckets.realized),
    fills_count: cumulativeFromBuckets(buckets.fills),
  };
  logEvent("evaluator.tenant_query.complete", {
    role: tenant.role,
    env: tenant.envSlug,
    decisions: decisions.decisions,
    placed: decisions.placed,
    fills: fills.fills_count,
    realized_usdc: fills.realized_size_usdc,
    markets: fills.markets_count,
    pnl_usdc: pnl.realized_pnl_usdc,
    resolved_markets: pnl.resolved_markets,
    coverage_pct: coverage,
    errors: errors.length,
  });
  return {
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
    placement_rate: placementRate(decisions),
    fills,
    pnl,
    our_market_set: ourMarketSet,
    market_coverage_pct: coverage,
    cumulative,
    low_sample: decisions.decisions < 50,
    errors,
  };
}

async function main(): Promise<void> {
  logEvent("evaluator.start");
  const args = parseArgs(process.argv.slice(2));

  const { tenants, errors: discoveryErrors } = discoverTenants(process.env);
  if (discoveryErrors.length > 0) {
    for (const e of discoveryErrors) {
      console.error(`half-block detected: ${e.envKeyPrefix}_${e.missing} missing`);
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
  const prodLive =
    tenants.find((t) => t.envSlug === "production" && t.role === "LIVE") ?? null;

  const grafanaUrl = process.env.GRAFANA_URL;
  const saToken = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  if (!grafanaUrl || !saToken) {
    console.error(
      "GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN required (source .env.cogni)"
    );
    process.exit(2);
  }
  const grafana = { url: grafanaUrl, saToken };

  const targetId = uuidv5(args.targetWallet.toLowerCase(), POLY_TARGET_WALLET_NAMESPACE);

  // Pull target's market set + cumulative volume FIRST (production DS) so each
  // tenant can compute market_coverage_pct against the same target reference.
  let targetBuckets: Array<{ ts: string; value: number }> = [];
  let targetMarketSet: string[] = [];
  try {
    targetBuckets = await fetchTargetHourlyVolume(
      grafana,
      "cogni-production-poly-postgres",
      args.targetWallet,
      { since: args.since, until: args.until }
    );
  } catch (e) {
    console.error(
      `target_volume_query_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  try {
    targetMarketSet = await fetchTargetMarketSet(
      grafana,
      "cogni-production-poly-postgres",
      args.targetWallet,
      { since: args.since, until: args.until }
    );
  } catch (e) {
    console.error(
      `target_market_set_query_failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const target: TargetSeries = {
    wallet: args.targetWallet,
    cumulative_usdc: cumulativeFromBuckets(targetBuckets),
    market_set: targetMarketSet,
  };
  logEvent("evaluator.target.complete", {
    wallet: args.targetWallet,
    buckets: targetBuckets.length,
    final_volume_usdc:
      target.cumulative_usdc[target.cumulative_usdc.length - 1]?.value ?? 0,
    target_markets: targetMarketSet.length,
  });

  const metrics: TenantMetrics[] = [];
  for (const t of tenants) {
    metrics.push(
      await fetchTenant(
        t,
        args.targetWallet,
        targetId,
        targetMarketSet,
        { since: args.since, until: args.until },
        grafana
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
  const prodLiveMetrics = prodLive
    ? metrics.find((m) => m.tenant.envKeyPrefix === prodLive.envKeyPrefix) ?? null
    : null;
  const abMatrix: Record<string, AbDelta[]> = {};
  for (const m of metrics) {
    if (m.tenant.envKeyPrefix === control.envKeyPrefix) continue;
    abMatrix[m.tenant.envKeyPrefix] = compareTenants(controlMetrics, m);
  }

  // Per-fill decision fidelity check — the true "is twin == live?" answer.
  // Pull decision lists from BOTH tenants and join in JS by fill_id.
  let fidelity: DecisionFidelity | null = null;
  if (prodLive) {
    try {
      const twinDecs = await fetchTenantDecisionList(
        grafana,
        control,
        targetId,
        { since: args.since, until: args.until }
      );
      const liveDecs = await fetchTenantDecisionList(
        grafana,
        prodLive,
        targetId,
        { since: args.since, until: args.until }
      );
      fidelity = decisionFidelity(twinDecs, liveDecs);
      logEvent("evaluator.fidelity.complete", {
        shared: fidelity.shared_fills,
        exact: fidelity.exact_match,
        outcome_diff: fidelity.outcome_disagree,
        twin_only: fidelity.twin_only_fills,
        live_only: fidelity.live_only_fills,
      });
    } catch (e) {
      console.error(
        `fidelity_query_failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const capturedAt = new Date().toISOString();
  const tsSafe = capturedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outDir =
    args.outDir ?? join(REPO_ROOT, "nodes/poly/research/tenant-matrix", tsSafe);
  mkdirSync(outDir, { recursive: true });

  const html = renderReportHtml({
    capturedAt,
    targetWallet: args.targetWallet,
    targetId,
    window: { since: args.since, until: args.until },
    metrics,
    control: controlMetrics,
    prodLive: prodLiveMetrics,
    target,
    abMatrix,
    fidelity,
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
        })),
        control: control.envKeyPrefix,
        prod_live: prodLive?.envKeyPrefix ?? null,
        metrics,
        target,
        ab: abMatrix,
        fidelity,
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
    prod_live: prodLive?.envKeyPrefix ?? null,
    out: outDir,
  });
  console.error(`[tenant-matrix-evaluator] report.html → ${join(outDir, "report.html")}`);
  console.error(`[tenant-matrix-evaluator] bundle.json → ${join(outDir, "bundle.json")}`);
  console.error(`[tenant-matrix-evaluator] findings.json → ${join(outDir, "findings.json")}`);
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
