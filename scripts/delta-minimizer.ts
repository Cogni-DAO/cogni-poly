// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/delta-minimizer`
 * Purpose: One-shot Δ-investigator CLI. Takes a market identifier (event slug,
 *   conditionId, comma-list, or fuzzy title), pulls dashboard-equivalent data
 *   sources, and writes an HTML report + JSON bundle for an LLM to author the
 *   takeaway against.
 * Scope: Read-only — does not write any DB row, place orders, or modify the
 *   charter; auto-detects the single copy-target from the decision ledger.
 * Invariants: READ_ONLY_DB — uses scripts/grafana-postgres-query.sh which refuses
 *   non-SELECT/WITH/SHOW/EXPLAIN. OUR_POSITIONS_ANCHOR_GROUPS — only markets
 *   where the cogni_wallet holds a snapshot row are reported.
 * Side-effects: IO (Postgres reads, CLOB HTTP, filesystem writes under research/delta-minimizing).
 * Links: .claude/skills/delta-minimizer/SKILL.md · work/charters/POLY_COPY_DELTA.md
 * @public
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- Argv ----------

type Args = { market: string; target?: string; json: boolean; env: string };

function parseArgs(argv: string[]): Args {
  const out: Args = {
    market: "",
    target: undefined,
    json: false,
    env: "production",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--env") out.env = argv[++i];
    else if (!a.startsWith("--") && !out.market) out.market = a;
  }
  if (!out.market) {
    console.error(
      "usage: tsx scripts/delta-minimizer.ts <event_slug | condition_id | fuzzy_title> [--target <wallet>] [--json] [--env production]"
    );
    process.exit(2);
  }
  return out;
}

// ---------- DB helper ----------

type GrafanaFrame = {
  schema: { fields: { name: string }[] };
  data: { values: unknown[][] };
};
function runSql(sql: string, env: string): Record<string, unknown>[] {
  const out = execFileSync(
    "bash",
    [
      join(REPO_ROOT, "scripts/grafana-postgres-query.sh"),
      sql,
      "--env",
      env,
      "--node",
      "poly",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  const frame: GrafanaFrame | undefined = parsed?.results?.A?.frames?.[0];
  if (parsed?.results?.A?.error)
    throw new Error(
      `SQL error: ${parsed.results.A.error}\nSQL: ${sql.slice(0, 200)}`
    );
  if (!frame) return [];
  const fields = frame.schema.fields.map((f) => f.name);
  const cols = frame.data.values;
  const nRows = cols[0]?.length ?? 0;
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < nRows; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < fields.length; c++) row[fields[c]] = cols[c][r];
    rows.push(row);
  }
  return rows;
}

// ---------- Market resolution ----------

type Market = {
  condition_id: string;
  event_title: string | null;
  event_slug: string | null;
  market_title: string;
  market_slug: string | null;
  end_date: number | null;
};

function resolveMarkets(input: string, env: string): Market[] {
  const trimmed = input.trim().toLowerCase();
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allHex =
    ids.length > 0 && ids.every((id) => /^0x[0-9a-f]{64}$/.test(id));
  let where: string;
  if (allHex) {
    where = `condition_id in (${ids.map((id) => `'${id}'`).join(",")})`;
  } else if (trimmed.includes("-") && /\d/.test(trimmed)) {
    // Prefix match — `lal-bet-elc-2026-05-12` should catch the
    // `-more-markets` and `-halftime-result` siblings too.
    where = `event_slug = '${trimmed}' or event_slug like '${trimmed}-%' or market_slug = '${trimmed}'`;
  } else {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const ilikes = parts
      .map((p) => `event_title ilike '%${p.replace(/'/g, "''")}%'`)
      .join(" and ");
    where = ilikes || "false";
  }
  const sql = `
    select condition_id, event_title, event_slug, market_title, market_slug,
           extract(epoch from end_date)*1000 as end_ms
    from poly_market_metadata
    where ${where}
    order by end_date desc nulls last
    limit 50
  `;
  const rows = runSql(sql, env);
  return rows.map((r) => ({
    condition_id: String(r.condition_id),
    event_title: r.event_title as string | null,
    event_slug: r.event_slug as string | null,
    market_title: String(r.market_title),
    market_slug: r.market_slug as string | null,
    end_date: (r.end_ms as number | null) ?? null,
  }));
}

// ---------- Single copy-target auto-detection ----------

type Target = {
  wallet: string;
  label: string;
  target_id: string;
  n_decisions: number;
};

function detectTarget(
  conditionIds: string[],
  env: string,
  explicit: string | undefined
): Target {
  const marketIds = conditionIds
    .map((c) => `'prediction-market:polymarket:${c}'`)
    .join(",");
  const whereWallet = explicit
    ? `and intent->>'target_wallet' = '${explicit.toLowerCase()}'`
    : "";
  const rows = runSql(
    `select intent->>'target_wallet' as wallet, target_id, count(*) as n
     from poly_copy_trade_decisions
     where intent->>'market_id' in (${marketIds}) ${whereWallet}
     group by wallet, target_id
     order by n desc
     limit 1`,
    env
  );
  if (rows.length === 0)
    throw new Error(
      `No copy-trade decisions on these markets${explicit ? ` for ${explicit}` : ""}.`
    );
  const wallet = String(rows[0].wallet);
  const lbl = runSql(
    `select label from poly_trader_wallets where wallet_address = '${wallet}' limit 1`,
    env
  );
  return {
    wallet,
    label: (lbl[0]?.label as string) ?? wallet,
    target_id: String(rows[0].target_id),
    n_decisions: Number(rows[0].n),
  };
}

// ---------- Outcome + labels (CLOB authoritative) ----------

type OutcomeRow = {
  condition_id: string;
  token_id: string;
  outcome: "winner" | "loser" | null;
  label: string | null;
};

async function fetchOutcomesAndLabels(
  conditionIds: string[]
): Promise<OutcomeRow[]> {
  if (conditionIds.length === 0) return [];
  const out: OutcomeRow[] = [];
  await Promise.all(
    conditionIds.map(async (cond) => {
      try {
        const r = await fetch(`https://clob.polymarket.com/markets/${cond}`);
        if (!r.ok) return;
        const m = (await r.json()) as {
          tokens: { token_id: string; outcome: string; winner: boolean }[];
        };
        for (const t of m.tokens ?? [])
          out.push({
            condition_id: cond,
            token_id: t.token_id,
            label: t.outcome,
            outcome:
              t.winner === true
                ? "winner"
                : t.winner === false
                  ? "loser"
                  : null,
          });
      } catch {
        /* non-fatal */
      }
    })
  );
  return out;
}

// ---------- Position legs (dashboard-equivalent sources) ----------

type Leg = {
  side: "ours" | "target";
  wallet_label: string;
  condition_id: string;
  token_id: string;
  shares: number;
  cost_basis_usdc: number; // raw snapshot cost
  current_value_usdc: number; // dashboard-displayed value (with closed=0 override for ours)
  vwap: number | null;
  lifecycle: "active" | "inactive";
};

function fetchOurLegs(
  walletAddress: string,
  conditionIds: string[],
  env: string
): Leg[] {
  if (conditionIds.length === 0) return [];
  const inCond = conditionIds.map((c) => `'${c}'`).join(",");
  // OWN-WALLET LEGS COME FROM SNAPSHOTS, NOT current_positions.
  //   poly_trader_current_positions filters active=true, which DROPS loser-side
  //   legs (the observer deactivates them once shares go to $0). For Δ-analysis
  //   we need every leg that ever existed, including the losers — same source we
  //   use for the target wallet. poly_market_outcomes is the chain truth on
  //   winner/loser; we apply only the "loser → value 0" override (NOT the
  //   dashboard's "winner+redeemed → 0" — that hides realized P/L on our hedges).
  const sql = `
    select distinct on (s.trader_wallet_id, s.condition_id, s.token_id)
      w.label,
      s.condition_id, s.token_id,
      s.shares::float8 as shares,
      s.cost_basis_usdc::float8 as cost_basis,
      s.current_value_usdc::float8 as current_value,
      s.avg_price::float8 as avg_price,
      pmo.outcome as market_outcome
    from poly_trader_position_snapshots s
    join poly_trader_wallets w on w.id = s.trader_wallet_id
    left join poly_market_outcomes pmo
      on lower(pmo.condition_id) = lower(s.condition_id) and pmo.token_id = s.token_id
    where lower(w.wallet_address) = '${walletAddress.toLowerCase()}'
      and w.kind = 'cogni_wallet'
      and s.condition_id in (${inCond})
    order by s.trader_wallet_id, s.condition_id, s.token_id, s.captured_at desc
  `;
  const rows = runSql(sql, env);
  return rows.map((r) => {
    const shares = Number(r.shares ?? 0);
    const costBasis = Number(r.cost_basis ?? 0);
    const currentValueRaw = Number(r.current_value ?? 0);
    const outcome = r.market_outcome as "winner" | "loser" | null;
    const displayValue = outcome === "loser" ? 0 : currentValueRaw;
    return {
      side: "ours" as const,
      wallet_label: String(r.label),
      condition_id: String(r.condition_id),
      token_id: String(r.token_id),
      shares,
      cost_basis_usdc: costBasis,
      current_value_usdc: displayValue,
      vwap:
        r.avg_price != null && Number(r.avg_price) > 0
          ? Number(r.avg_price)
          : null,
      lifecycle: displayValue > 0 || outcome === null ? "active" : "inactive",
    };
  });
}

function fetchTargetLegs(
  targetWallet: string,
  conditionIds: string[],
  env: string
): Leg[] {
  if (conditionIds.length === 0) return [];
  const inCond = conditionIds.map((c) => `'${c}'`).join(",");
  // Dashboard uses poly_trader_position_snapshots (append-only), DISTINCT ON
  // (wallet, condition, token) latest by captured_at. Survives target redemption.
  const sql = `
    select distinct on (s.trader_wallet_id, s.condition_id, s.token_id)
      w.label,
      s.condition_id, s.token_id,
      s.shares::float8 as shares,
      s.cost_basis_usdc::float8 as cost_basis,
      s.current_value_usdc::float8 as current_value,
      s.avg_price::float8 as avg_price
    from poly_trader_position_snapshots s
    join poly_trader_wallets w on w.id = s.trader_wallet_id
    where lower(w.wallet_address) = '${targetWallet.toLowerCase()}'
      and s.condition_id in (${inCond})
    order by s.trader_wallet_id, s.condition_id, s.token_id, s.captured_at desc
  `;
  const rows = runSql(sql, env);
  return rows.map((r) => {
    const shares = Number(r.shares ?? 0);
    const costBasis = Number(r.cost_basis ?? 0);
    const currentValue = Number(r.current_value ?? 0);
    return {
      side: "target" as const,
      wallet_label: String(r.label),
      condition_id: String(r.condition_id),
      token_id: String(r.token_id),
      shares,
      cost_basis_usdc: costBasis,
      current_value_usdc: currentValue,
      vwap:
        r.avg_price != null && Number(r.avg_price) > 0
          ? Number(r.avg_price)
          : null,
      lifecycle: currentValue > 0 ? "active" : "inactive",
    };
  });
}

// ---------- Fill rollups (for max(rollup, snapshot) cost-basis denominator) ----------

type Rollup = {
  wallet_address: string;
  condition_id: string;
  buy_notional: number;
  realized_cash: number;
};

function fetchFillRollups(
  conditionIds: string[],
  wallets: string[],
  env: string
): Map<string, Rollup> {
  const out = new Map<string, Rollup>();
  if (conditionIds.length === 0 || wallets.length === 0) return out;
  const inCond = conditionIds.map((c) => `'${c}'`).join(",");
  const inWallet = wallets.map((w) => `'${w.toLowerCase()}'`).join(",");
  const sql = `
    select lower(w.wallet_address) as wallet_address, f.condition_id,
           coalesce(sum(f.size_usdc) filter (where f.side = 'BUY'), 0)::float8 as buy_notional,
           coalesce(sum(f.size_usdc) filter (where f.side = 'SELL'), 0)::float8 as realized_cash
    from poly_trader_fills f
    join poly_trader_wallets w on w.id = f.trader_wallet_id
    where f.condition_id in (${inCond})
      and lower(w.wallet_address) in (${inWallet})
    group by lower(w.wallet_address), f.condition_id
  `;
  for (const r of runSql(sql, env)) {
    const k = `${String(r.wallet_address)}|${String(r.condition_id)}`;
    out.set(k, {
      wallet_address: String(r.wallet_address),
      condition_id: String(r.condition_id),
      buy_notional: Number(r.buy_notional ?? 0),
      realized_cash: Number(r.realized_cash ?? 0),
    });
  }
  return out;
}

// ---------- Raw fills (for timeline) ----------

type RawFill = {
  wallet_label: string;
  condition_id: string;
  token_id: string;
  side: "BUY" | "SELL";
  price: number;
  shares: number;
  size_usdc: number;
  observed_at: number;
};

function fetchRawFills(
  conditionIds: string[],
  wallets: string[],
  env: string
): RawFill[] {
  if (conditionIds.length === 0 || wallets.length === 0) return [];
  const inCond = conditionIds.map((c) => `'${c}'`).join(",");
  const inWallet = wallets.map((w) => `'${w.toLowerCase()}'`).join(",");
  const sql = `
    select w.label as wallet_label, f.condition_id, f.token_id, f.side,
           f.price::float8 as price, f.shares::float8 as shares, f.size_usdc::float8 as size_usdc,
           extract(epoch from f.observed_at)*1000 as observed_at
    from poly_trader_fills f
    join poly_trader_wallets w on w.id = f.trader_wallet_id
    where f.condition_id in (${inCond})
      and lower(w.wallet_address) in (${inWallet})
    order by f.observed_at asc
  `;
  return runSql(sql, env) as unknown as RawFill[];
}

// ---------- Decisions ----------

type DecisionRow = {
  decided_at: number;
  condition_id: string;
  outcome: string;
  reason: string;
  outc_label: string | null;
  fill_price_target: number | null;
  fill_size_usdc_target: number | null;
  target_position_usdc: number | null;
  target_side_fraction: number | null;
  position_branch: string | null;
  target_dominant_token_id: string | null;
  position_token_id: string | null;
};

function fetchDecisions(
  targetId: string,
  conditionIds: string[],
  env: string
): DecisionRow[] {
  if (conditionIds.length === 0) return [];
  const marketIds = conditionIds
    .map((c) => `'prediction-market:polymarket:${c}'`)
    .join(",");
  const sql = `
    select extract(epoch from decided_at)*1000 as decided_at,
           substring(intent->>'market_id' from 30) as condition_id,
           outcome, reason,
           intent->>'outcome' as outc_label,
           (intent->>'fill_price_target')::numeric as fill_price_target,
           (intent->>'fill_size_usdc_target')::numeric as fill_size_usdc_target,
           (intent->>'target_position_usdc')::numeric as target_position_usdc,
           (intent->>'target_side_fraction')::numeric as target_side_fraction,
           intent->>'position_branch' as position_branch,
           intent->>'target_dominant_token_id' as target_dominant_token_id,
           intent->>'position_token_id' as position_token_id
    from poly_copy_trade_decisions
    where target_id = '${targetId}'
      and intent->>'market_id' in (${marketIds})
    order by decided_at asc
  `;
  return runSql(sql, env) as unknown as DecisionRow[];
}

type PlacedHisto = {
  condition_id: string;
  status: string;
  n: number;
  total_size_attempted: number;
};

function fetchPlacedOrders(
  targetId: string,
  conditionIds: string[],
  env: string
): PlacedHisto[] {
  if (conditionIds.length === 0) return [];
  const marketIds = conditionIds
    .map((c) => `'prediction-market:polymarket:${c}'`)
    .join(",");
  const sql = `
    select substring(market_id from 30) as condition_id, status, count(*) as n,
           sum((attributes->>'size_usdc')::numeric) as total_size_attempted
    from poly_copy_trade_fills
    where target_id = '${targetId}' and market_id in (${marketIds})
    group by condition_id, status
    order by condition_id, status
  `;
  return runSql(sql, env) as unknown as PlacedHisto[];
}

// ---------- Per-condition metric (dashboard math: max(rollup, snapshot)) ----------

type ConditionMetric = {
  condition_id: string;
  primary_token_id: string | null;
  hedge_token_id: string | null;
  ours: PerWalletMetric;
  target: PerWalletMetric;
};

type PerWalletMetric = {
  primary_value: number;
  primary_cost: number;
  primary_vwap: number | null;
  primary_pnl: number;
  hedge_value: number;
  hedge_cost: number;
  hedge_vwap: number | null;
  hedge_pnl: number;
  net_value: number;
  net_cost: number;
  net_pnl: number;
  return_pct: number | null; // Modified-Dietz: (realized + currentMark - buyNotional) / buyNotional
  total_buy_notional: number; // max(rollup_buy, snapshot_cost)
};

function buildPerWalletMetric(
  legs: Leg[],
  primary_token_id: string | null,
  hedge_token_id: string | null,
  rollup: Rollup | undefined
): PerWalletMetric {
  const primary = legs.find((l) => l.token_id === primary_token_id);
  const hedge = legs.find((l) => l.token_id === hedge_token_id);
  const snapshotCost = legs.reduce((s, l) => s + l.cost_basis_usdc, 0);
  const currentMark = legs.reduce((s, l) => s + l.current_value_usdc, 0);
  const buyNotional = Math.max(rollup?.buy_notional ?? 0, snapshotCost);
  const realizedCash = rollup?.realized_cash ?? 0;
  const returnPct =
    buyNotional > 0
      ? (realizedCash + currentMark - buyNotional) / buyNotional
      : null;
  return {
    primary_value: primary?.current_value_usdc ?? 0,
    primary_cost: primary?.cost_basis_usdc ?? 0,
    primary_vwap: primary?.vwap ?? null,
    primary_pnl:
      (primary?.current_value_usdc ?? 0) - (primary?.cost_basis_usdc ?? 0),
    hedge_value: hedge?.current_value_usdc ?? 0,
    hedge_cost: hedge?.cost_basis_usdc ?? 0,
    hedge_vwap: hedge?.vwap ?? null,
    hedge_pnl: (hedge?.current_value_usdc ?? 0) - (hedge?.cost_basis_usdc ?? 0),
    net_value: currentMark,
    net_cost: snapshotCost,
    net_pnl: currentMark - snapshotCost,
    return_pct: returnPct,
    total_buy_notional: buyNotional,
  };
}

function buildConditionMetric(
  conditionId: string,
  ourLegs: Leg[],
  targetLegs: Leg[],
  rollups: Map<string, Rollup>,
  ourWallet: string,
  targetWallet: string
): ConditionMetric {
  // Primary = larger snapshot cost basis from TARGET's legs (their bet);
  // hedge = the other side. If target has only one leg, use that.
  const sortedTarget = [...targetLegs].sort(
    (a, b) => b.cost_basis_usdc - a.cost_basis_usdc
  );
  const primary_token_id =
    sortedTarget[0]?.token_id ?? ourLegs[0]?.token_id ?? null;
  const hedge_token_id = sortedTarget[1]?.token_id ?? null;
  return {
    condition_id: conditionId,
    primary_token_id,
    hedge_token_id,
    ours: buildPerWalletMetric(
      ourLegs,
      primary_token_id,
      hedge_token_id,
      rollups.get(`${ourWallet.toLowerCase()}|${conditionId}`)
    ),
    target: buildPerWalletMetric(
      targetLegs,
      primary_token_id,
      hedge_token_id,
      rollups.get(`${targetWallet.toLowerCase()}|${conditionId}`)
    ),
  };
}

// ---------- Group-level edge-gap (matches market-return-math.edgeGap) ----------

function edgeGap(args: {
  ourReturnPct: number | null;
  targetReturnPct: number | null;
  ourTotalBuyNotional: number;
}): { rateGapPct: number | null; sizeScaledGapUsdc: number | null } {
  if (args.ourReturnPct === null || args.targetReturnPct === null)
    return { rateGapPct: null, sizeScaledGapUsdc: null };
  const rateGapPct = args.targetReturnPct - args.ourReturnPct;
  const sizeScaledGapUsdc = rateGapPct * args.ourTotalBuyNotional;
  return { rateGapPct, sizeScaledGapUsdc };
}

function blendReturns(
  entries: { buyNotional: number; returnPct: number | null }[]
): number | null {
  const filtered = entries.filter(
    (e) => e.returnPct !== null && e.buyNotional > 0
  );
  const total = filtered.reduce((s, e) => s + e.buyNotional, 0);
  if (total === 0) return null;
  return filtered.reduce(
    (s, e) => s + (e.returnPct as number) * (e.buyNotional / total),
    0
  );
}

// ---------- Δ-class scoring (target-mirror framing) ----------

type CauseScore = {
  id: string;
  title: string;
  charter_class: string;
  score: number;
  evidence: string[];
};

function classifyCauses(
  decisions: DecisionRow[],
  placedOrders: PlacedHisto[],
  metrics: ConditionMetric[],
  targetLabel: string
): CauseScore[] {
  const primaryByCond = new Map<string, string | null>();
  for (const m of metrics)
    primaryByCond.set(m.condition_id, m.primary_token_id);

  const causes = new Map<string, CauseScore>();
  const push = (
    id: string,
    title: string,
    cls: string,
    weight: number,
    ev: string
  ) => {
    let c = causes.get(id);
    if (!c) {
      c = { id, title, charter_class: cls, score: 0, evidence: [] };
      causes.set(id, c);
    }
    c.score += weight;
    if (c.evidence.length < 5) c.evidence.push(ev);
  };

  let d4Total = 0,
    d4Primary = 0;
  for (const d of decisions)
    if (d.reason === "vwap_floor_breach") {
      d4Total++;
      if (primaryByCond.get(d.condition_id) === d.position_token_id)
        d4Primary++;
    }
  if (d4Total > 0)
    push(
      "D4",
      "VWAP gate bouncing",
      "D4",
      d4Primary * 3 + d4Total,
      `${d4Total} \`vwap_floor_breach\` skips total; ${d4Primary} were on ${targetLabel}'s primary side.`
    );

  let d3Total = 0,
    d3Primary = 0;
  for (const d of decisions)
    if (d.reason === "target_dominant_other_side") {
      d3Total++;
      if (primaryByCond.get(d.condition_id) === d.position_token_id)
        d3Primary++;
    }
  if (d3Total > 0)
    push(
      "D3",
      "Hedge blindness",
      "D3",
      d3Primary * 3 + d3Total,
      `${d3Total} \`target_dominant_other_side\` skips; ${d3Primary} on ${targetLabel}'s final primary side.`
    );

  const placedAgg = { filled: 0, canceled: 0, error: 0, other: 0 };
  for (const p of placedOrders) {
    if (p.status === "filled") placedAgg.filled += Number(p.n);
    else if (p.status === "canceled") placedAgg.canceled += Number(p.n);
    else if (p.status === "error") placedAgg.error += Number(p.n);
    else placedAgg.other += Number(p.n);
  }
  const totalPlaces =
    placedAgg.filled + placedAgg.canceled + placedAgg.error + placedAgg.other;
  if (totalPlaces > 0 && placedAgg.canceled / totalPlaces > 0.4)
    push(
      "D5",
      "Order staleness / churn",
      "D5",
      placedAgg.canceled * 2,
      `${placedAgg.canceled} of ${totalPlaces} placements canceled (${((placedAgg.canceled / totalPlaces) * 100).toFixed(0)}%).`
    );

  // D2: our cost on the OPPOSITE side from target's primary
  let ourPrimaryCost = 0,
    ourHedgeCost = 0;
  for (const m of metrics) {
    ourPrimaryCost += m.ours.primary_cost;
    ourHedgeCost += m.ours.hedge_cost;
  }
  const ourTotal = ourPrimaryCost + ourHedgeCost;
  if (ourTotal > 0 && ourHedgeCost / ourTotal > 0.3)
    push(
      "D2",
      "Wrong-side allocation vs target",
      "D2",
      Math.round(ourHedgeCost * 10),
      `Our wallet sank $${ourHedgeCost.toFixed(2)} into the side OPPOSITE ${targetLabel}'s primary (${((ourHedgeCost / ourTotal) * 100).toFixed(0)}% of our cost).`
    );

  return [...causes.values()].sort((a, b) => b.score - a.score);
}

// (paretoFix removed — Pareto fix is now part of the LLM-authored TAKEAWAY block
// in the report HTML, not auto-generated by the script.)

// ---------- Formatting ----------

function fmtUsd(
  n: number | null | undefined,
  opts: { sign?: boolean } = {}
): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = opts.sign && n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2)}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}
function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const REASON_COLOR: Record<string, string> = {
  placed: "#22c55e",
  low_signal: "#94a3b8",
  algo_block: "#f59e0b",
  error: "#ef4444",
};
function reasonCategory(
  outcome: string,
  reason: string
): keyof typeof REASON_COLOR {
  if (outcome === "placed") return "placed";
  if (outcome === "error") return "error";
  if (reason === "below_target_percentile" || reason === "already_resting")
    return "low_signal";
  return "algo_block";
}

// ---------- SVG timeline: log $ value Y-axis ----------

function svgTimeline(args: {
  market: Market;
  primary: {
    token_id: string;
    label: string | null;
    outcome: "winner" | "loser" | null;
  } | null;
  rawFills: RawFill[];
  decisions: DecisionRow[];
  globalT: { min: number; max: number };
  targetLabel: string;
  ourLabel: string;
}): string {
  const {
    market,
    primary,
    rawFills,
    decisions,
    globalT,
    targetLabel,
    ourLabel,
  } = args;
  if (!primary) return "";
  const tMin = globalT.min;
  const tMax = globalT.max;
  const span = Math.max(1, tMax - tMin);
  const W = 1200,
    H = 280,
    padL = 70,
    padR = 60,
    padT = 28,
    padB = 70;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;

  const here = rawFills.filter(
    (f) =>
      f.condition_id === market.condition_id && f.token_id === primary.token_id
  );
  const decsHere = decisions.filter(
    (d) => d.condition_id === market.condition_id
  );

  type Pt = { t: number; cumCost: number; cumShares: number; vwap: number };
  const series = (wallet: string): Pt[] => {
    const pts: Pt[] = [];
    let cumShares = 0;
    let cumCost = 0;
    for (const f of here) {
      if (f.wallet_label !== wallet) continue;
      const sign = f.side === "BUY" ? 1 : -1;
      cumShares += sign * Number(f.shares);
      cumCost += sign * Number(f.size_usdc);
      pts.push({
        t: Number(f.observed_at),
        cumCost,
        cumShares,
        vwap: cumShares > 0 ? cumCost / cumShares : 0,
      });
    }
    return pts;
  };
  const target = series(targetLabel);
  const ours = series(ourLabel);

  if (target.length === 0 && ours.length === 0)
    return `<div class="empty">No fills on ${market.market_title} → ${primary.label} (token ${primary.token_id.slice(0, 8)}…)</div>`;

  const maxCost = Math.max(
    1,
    ...target.map((p) => p.cumCost),
    ...ours.map((p) => p.cumCost)
  );
  const yCost = (cost: number) => {
    if (cost <= 0) return padT + plotH;
    const v = Math.log10(cost + 1) / Math.log10(maxCost + 1);
    return padT + (1 - v) * plotH;
  };
  const xT = (t: number) => padL + ((t - tMin) / span) * plotW;
  const yPrice = (p: number) => padT + (1 - p) * plotH;

  const COLOR = { target: "#10b981", us: "#3b82f6" };

  function costPath(pts: Pt[]): string {
    if (pts.length === 0) return "";
    let d = `M ${xT(tMin).toFixed(1)} ${yCost(0).toFixed(1)}`;
    let prev = 0;
    for (const p of pts) {
      d += ` L ${xT(p.t).toFixed(1)} ${yCost(prev).toFixed(1)}`;
      d += ` L ${xT(p.t).toFixed(1)} ${yCost(p.cumCost).toFixed(1)}`;
      prev = p.cumCost;
    }
    d += ` L ${xT(tMax).toFixed(1)} ${yCost(prev).toFixed(1)}`;
    return d;
  }
  function vwapPath(pts: Pt[]): string {
    if (pts.length === 0) return "";
    let d = "";
    let started = false;
    let prev = pts[0].vwap;
    for (const p of pts) {
      if (!started) {
        d += `M ${xT(p.t).toFixed(1)} ${yPrice(prev).toFixed(1)}`;
        started = true;
      }
      d += ` L ${xT(p.t).toFixed(1)} ${yPrice(prev).toFixed(1)}`;
      d += ` L ${xT(p.t).toFixed(1)} ${yPrice(p.vwap).toFixed(1)}`;
      prev = p.vwap;
    }
    d += ` L ${xT(tMax).toFixed(1)} ${yPrice(prev).toFixed(1)}`;
    return d;
  }

  const ticks: { t: number; label: string }[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = tMin + (span * i) / 6;
    ticks.push({
      t,
      label: new Date(t).toISOString().slice(5, 16).replace("T", " "),
    });
  }

  const lines: string[] = [];
  lines.push(
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart">`
  );
  lines.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#0b1220"/>`);

  // Y axis: log $ value
  const niceTicks = [1, 10, 100, 1000, 10000, 100000].filter(
    (v) => v <= maxCost * 1.2
  );
  for (const tk of niceTicks) {
    const y = yCost(tk);
    lines.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="0.6" stroke-dasharray="3,4"/>`
    );
    lines.push(
      `<text x="${padL - 8}" y="${y.toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="end" dominant-baseline="middle">$${tk >= 1000 ? `${tk / 1000}k` : tk}</text>`
    );
  }
  lines.push(
    `<text x="20" y="${padT + plotH / 2}" fill="#94a3b8" font-size="11" text-anchor="middle" transform="rotate(-90 20 ${padT + plotH / 2})">cumulative $ cost (log)</text>`
  );

  // Right axis: VWAP $ scale
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const y = yPrice(p);
    lines.push(
      `<text x="${padL + plotW + 8}" y="${y.toFixed(1)}" fill="#475569" font-size="10" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    );
  }
  lines.push(
    `<text x="${W - 14}" y="${padT + plotH / 2}" fill="#475569" font-size="11" text-anchor="middle" transform="rotate(90 ${W - 14} ${padT + plotH / 2})">VWAP $</text>`
  );

  for (const tk of ticks) {
    lines.push(
      `<line x1="${xT(tk.t).toFixed(1)}" y1="${(padT + plotH).toFixed(1)}" x2="${xT(tk.t).toFixed(1)}" y2="${(padT + plotH + 4).toFixed(1)}" stroke="#4b5563"/>`
    );
    lines.push(
      `<text x="${xT(tk.t).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" fill="#9ca3af" font-size="10" text-anchor="middle">${tk.label}</text>`
    );
  }

  if (target.length > 0) {
    const last = target[target.length - 1];
    const area =
      costPath(target) +
      ` L ${xT(tMax).toFixed(1)} ${yCost(0).toFixed(1)} L ${xT(tMin).toFixed(1)} ${yCost(0).toFixed(1)} Z`;
    lines.push(`<path d="${area}" fill="${COLOR.target}" opacity="0.18"/>`);
    lines.push(
      `<path d="${costPath(target)}" fill="none" stroke="${COLOR.target}" stroke-width="2"/>`
    );
    lines.push(
      `<circle cx="${xT(last.t).toFixed(1)}" cy="${yCost(last.cumCost).toFixed(1)}" r="3.5" fill="${COLOR.target}"/>`
    );
  }
  if (ours.length > 0) {
    const last = ours[ours.length - 1];
    lines.push(
      `<path d="${costPath(ours)}" fill="none" stroke="${COLOR.us}" stroke-width="2"/>`
    );
    lines.push(
      `<circle cx="${xT(last.t).toFixed(1)}" cy="${yCost(last.cumCost).toFixed(1)}" r="3.5" fill="${COLOR.us}"/>`
    );
  }
  if (target.length > 0)
    lines.push(
      `<path d="${vwapPath(target)}" fill="none" stroke="${COLOR.target}" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.85"/>`
    );
  if (ours.length > 0)
    lines.push(
      `<path d="${vwapPath(ours)}" fill="none" stroke="${COLOR.us}" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.85"/>`
    );

  // Decision strip
  const stripY = padT + plotH + 28;
  lines.push(
    `<text x="${padL}" y="${stripY - 4}" fill="#9ca3af" font-size="11">our decisions →</text>`
  );
  lines.push(
    `<line x1="${padL}" y1="${stripY + 8}" x2="${padL + plotW}" y2="${stripY + 8}" stroke="#1f2937"/>`
  );
  for (const d of decsHere) {
    const cat = reasonCategory(d.outcome, d.reason);
    const isPrimary = d.position_token_id === primary.token_id;
    const cx = xT(d.decided_at).toFixed(1);
    const cy = (stripY + 8).toFixed(1);
    const r = cat === "placed" ? 4 : 3;
    lines.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${REASON_COLOR[cat]}" opacity="${isPrimary ? 0.95 : 0.45}"><title>${fmtTime(d.decided_at)} · ${d.outc_label ?? "?"} · ${d.reason}${isPrimary ? " (primary side)" : " (hedge side)"}</title></circle>`
    );
  }

  const winnerNote = primary.outcome ? ` (${primary.outcome})` : "";
  lines.push(
    `<text x="${padL}" y="${padT - 10}" fill="#f3f4f6" font-size="14" font-weight="600">${escapeXml(market.market_title)} <tspan fill="#94a3b8" font-weight="400">→ ${escapeXml(primary.label ?? "?")}${winnerNote}</tspan></text>`
  );
  const targetEnd = target[target.length - 1];
  const ourEnd = ours[ours.length - 1];
  const annot = [
    targetEnd
      ? `${targetLabel}: ${fmtUsd(targetEnd.cumCost)} @ VWAP $${targetEnd.vwap.toFixed(3)}`
      : null,
    ourEnd
      ? `us: ${fmtUsd(ourEnd.cumCost)} @ VWAP $${ourEnd.vwap.toFixed(3)}`
      : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  lines.push(
    `<text x="${padL + plotW}" y="${padT - 10}" fill="#94a3b8" font-size="11" text-anchor="end">${escapeXml(annot)}</text>`
  );

  lines.push(`</svg>`);
  return lines.join("\n");
}

// ---------- HTML render ----------

type EventGroup = {
  event_slug: string | null;
  event_title: string | null;
  markets: Market[];
  outcomes: OutcomeRow[];
  metrics: ConditionMetric[];
  ourReturnPct: number | null;
  targetReturnPct: number | null;
  ourBuyNotional: number;
  targetBuyNotional: number;
  ourCost: number;
  ourValue: number;
  ourPnl: number;
  targetCost: number;
  targetValue: number;
  targetPnl: number;
  edgeGapPct: number | null;
  edgeGapUsdc: number | null;
};

function buildEventGroup(
  markets: Market[],
  outcomes: OutcomeRow[],
  ourLegs: Leg[],
  targetLegs: Leg[],
  rollups: Map<string, Rollup>,
  ourWallet: string,
  targetWallet: string
): EventGroup {
  const metrics: ConditionMetric[] = markets.map((m) => {
    const oLegs = ourLegs.filter((l) => l.condition_id === m.condition_id);
    const tLegs = targetLegs.filter((l) => l.condition_id === m.condition_id);
    return buildConditionMetric(
      m.condition_id,
      oLegs,
      tLegs,
      rollups,
      ourWallet,
      targetWallet
    );
  });
  const ourCost = metrics.reduce((s, m) => s + m.ours.net_cost, 0);
  const ourValue = metrics.reduce((s, m) => s + m.ours.net_value, 0);
  const targetCost = metrics.reduce((s, m) => s + m.target.net_cost, 0);
  const targetValue = metrics.reduce((s, m) => s + m.target.net_value, 0);
  const ourBuyNotional = metrics.reduce(
    (s, m) => s + m.ours.total_buy_notional,
    0
  );
  const targetBuyNotional = metrics.reduce(
    (s, m) => s + m.target.total_buy_notional,
    0
  );
  const ourReturnPct = blendReturns(
    metrics.map((m) => ({
      buyNotional: m.ours.total_buy_notional,
      returnPct: m.ours.return_pct,
    }))
  );
  const targetReturnPct = blendReturns(
    metrics.map((m) => ({
      buyNotional: m.target.total_buy_notional,
      returnPct: m.target.return_pct,
    }))
  );
  const { rateGapPct, sizeScaledGapUsdc } = edgeGap({
    ourReturnPct,
    targetReturnPct,
    ourTotalBuyNotional: ourBuyNotional,
  });
  return {
    event_slug: markets[0]?.event_slug ?? null,
    event_title: markets[0]?.event_title ?? null,
    markets,
    outcomes,
    metrics,
    ourReturnPct,
    targetReturnPct,
    ourBuyNotional,
    targetBuyNotional,
    ourCost,
    ourValue,
    ourPnl: ourValue - ourCost,
    targetCost,
    targetValue,
    targetPnl: targetValue - targetCost,
    edgeGapPct: rateGapPct,
    edgeGapUsdc: sizeScaledGapUsdc,
  };
}

function renderMarketCard(
  market: Market,
  metric: ConditionMetric,
  outcomes: OutcomeRow[],
  targetLabel: string
): string {
  const primary = outcomes.find(
    (o) =>
      o.condition_id === market.condition_id &&
      o.token_id === metric.primary_token_id
  );
  const hedge = outcomes.find(
    (o) =>
      o.condition_id === market.condition_id &&
      o.token_id === metric.hedge_token_id
  );

  // VWAP delta detection: highlight cells where |our_vwap - target_vwap| is significant.
  const VWAP_DELTA_WARN = 0.04; // 4¢ on a 0..1 price → visually meaningful divergence
  const primaryVwapDelta =
    metric.ours.primary_vwap != null && metric.target.primary_vwap != null
      ? metric.ours.primary_vwap - metric.target.primary_vwap
      : null;
  const hedgeVwapDelta =
    metric.ours.hedge_vwap != null && metric.target.hedge_vwap != null
      ? metric.ours.hedge_vwap - metric.target.hedge_vwap
      : null;

  const vwapCls = (delta: number | null): string => {
    if (delta == null) return "";
    if (Math.abs(delta) >= VWAP_DELTA_WARN)
      return delta > 0 ? "vwap-bad" : "vwap-good";
    return "";
  };

  const cell = (
    value: number,
    vwap: number | null,
    pnl: number,
    costZero: boolean,
    vwapCellCls: string
  ) => {
    if (costZero)
      return `<td class="num">$0.00</td><td class="num">—</td><td class="num">—</td>`;
    return `<td class="num">${fmtUsd(value)}</td><td class="num ${vwapCellCls}">${vwap != null ? vwap.toFixed(3) : "—"}</td><td class="num ${pnl >= 0 ? "pos" : "neg"}">${fmtUsd(pnl, { sign: true })}</td>`;
  };
  const rowFor = (
    name: string,
    cls: "us" | "target",
    pri_cost: number,
    pri_val: number,
    pri_pnl: number,
    pri_vwap: number | null,
    hed_cost: number,
    hed_val: number,
    hed_pnl: number,
    hed_vwap: number | null,
    net_val: number,
    net_cost: number,
    net_pnl: number,
    isUs: boolean
  ) => {
    const netPct = net_cost > 0 ? net_pnl / net_cost : null;
    const pctCls = (netPct ?? 0) >= 0 ? "pos" : "neg";
    // Only highlight delta on OUR row (since target is the reference).
    const priVwapCls = isUs ? vwapCls(primaryVwapDelta) : "";
    const hedVwapCls = isUs ? vwapCls(hedgeVwapDelta) : "";
    return `<tr>
      <td><span class="wallet ${cls}">${escapeHtml(name)}</span></td>
      ${cell(pri_val, pri_vwap, pri_pnl, pri_cost === 0, priVwapCls)}
      ${cell(hed_val, hed_vwap, hed_pnl, hed_cost === 0, hedVwapCls)}
      <td class="num">${fmtUsd(net_val)}</td>
      <td class="num ${pctCls}">${fmtPct(netPct)}</td>
      <td class="num ${pctCls}">${fmtUsd(net_pnl, { sign: true })}</td>
    </tr>`;
  };

  // Optional VWAP-delta annotation row: only render if at least one side has a significant delta.
  const annotationRow = (() => {
    const cells: string[] = [];
    const showPrimary =
      primaryVwapDelta != null && Math.abs(primaryVwapDelta) >= VWAP_DELTA_WARN;
    const showHedge =
      hedgeVwapDelta != null && Math.abs(hedgeVwapDelta) >= VWAP_DELTA_WARN;
    if (!showPrimary && !showHedge) return "";
    const renderCell = (delta: number | null, show: boolean) => {
      if (!show || delta == null)
        return `<td class="num"></td><td class="num"></td><td class="num"></td>`;
      const cls = delta > 0 ? "vwap-bad" : "vwap-good";
      const hint = delta > 0 ? "we paid more" : "we paid less";
      return `<td class="num"></td><td class="num ${cls}" colspan="2">Δ VWAP ${(delta * 100).toFixed(1)}¢ — ${hint}</td>`;
    };
    cells.push(renderCell(primaryVwapDelta, showPrimary));
    cells.push(renderCell(hedgeVwapDelta, showHedge));
    return `<tr class="annotation"><td></td>${cells.join("")}<td></td><td></td><td></td></tr>`;
  })();

  return `<div class="market-card">
    <div class="market-head">
      <span class="market-title">${escapeHtml(market.market_title)}</span>
      ${primary?.outcome === "winner" ? `<span class="badge win">${escapeHtml(primary.label ?? "")} won</span>` : ""}
      ${primary?.outcome === "loser" ? `<span class="badge lose">${escapeHtml(primary.label ?? "")} lost</span>` : ""}
    </div>
    <table class="positions">
      <thead>
        <tr>
          <th rowspan="2">Trader</th>
          <th colspan="3">Primary · ${escapeHtml(primary?.label ?? "?")}</th>
          <th colspan="3">Hedge · ${escapeHtml(hedge?.label ?? "—")}</th>
          <th rowspan="2">Net value</th>
          <th rowspan="2">Net %</th>
          <th rowspan="2">Net P/L</th>
        </tr>
        <tr><th>Value</th><th>VWAP</th><th>P/L</th><th>Value</th><th>VWAP</th><th>P/L</th></tr>
      </thead>
      <tbody>
        ${rowFor("Our wallet", "us", metric.ours.primary_cost, metric.ours.primary_value, metric.ours.primary_pnl, metric.ours.primary_vwap, metric.ours.hedge_cost, metric.ours.hedge_value, metric.ours.hedge_pnl, metric.ours.hedge_vwap, metric.ours.net_value, metric.ours.net_cost, metric.ours.net_pnl, true)}
        ${rowFor(targetLabel, "target", metric.target.primary_cost, metric.target.primary_value, metric.target.primary_pnl, metric.target.primary_vwap, metric.target.hedge_cost, metric.target.hedge_value, metric.target.hedge_pnl, metric.target.hedge_vwap, metric.target.net_value, metric.target.net_cost, metric.target.net_pnl, false)}
        ${annotationRow}
      </tbody>
    </table>
  </div>`;
}

function renderGroupSection(
  group: EventGroup,
  rawFills: RawFill[],
  decisions: DecisionRow[],
  globalT: { min: number; max: number },
  targetLabel: string,
  ourLabel: string
): string {
  const cards = group.markets
    .map((m, i) =>
      renderMarketCard(m, group.metrics[i], group.outcomes, targetLabel)
    )
    .join("\n");
  const charts = group.markets
    .map((m, i) => {
      const metric = group.metrics[i];
      const primary = group.outcomes.find(
        (o) =>
          o.condition_id === m.condition_id &&
          o.token_id === metric.primary_token_id
      );
      return `<div class="market-card">
        <div class="market-head"><span class="market-title">${escapeHtml(m.market_title)} → ${escapeHtml(primary?.label ?? "?")}</span></div>
        ${svgTimeline({ market: m, primary: primary ?? null, rawFills, decisions, globalT, targetLabel, ourLabel })}
        <div class="legend">
          <span><span class="line" style="background:#10b981"></span>${escapeHtml(targetLabel)} $cost</span>
          <span><span class="line" style="background:#3b82f6"></span>Our $cost</span>
          <span><span class="line dash" style="color:#10b981"></span>${escapeHtml(targetLabel)} VWAP</span>
          <span><span class="line dash" style="color:#3b82f6"></span>Our VWAP</span>
          <span><span class="dot" style="background:#22c55e"></span>placed</span>
          <span><span class="dot" style="background:#94a3b8"></span>skip (signal small)</span>
          <span><span class="dot" style="background:#f59e0b"></span>skip (algo gate)</span>
          <span><span class="dot" style="background:#ef4444"></span>error</span>
        </div>
      </div>`;
    })
    .join("\n");

  const ourPctCls = group.ourPnl >= 0 ? "pos" : "neg";
  const targetPctCls = group.targetPnl >= 0 ? "pos" : "neg";
  const deltaCls = (group.edgeGapUsdc ?? 0) >= 0 ? "neg" : "pos"; // positive Δ = target ahead = bad

  return `<section class="event-group">
    <h2>${escapeHtml(group.event_title ?? group.event_slug ?? "(no title)")} <span class="evslug">event_slug: <code>${escapeHtml(group.event_slug ?? "?")}</code> · ${group.markets.length} markets</span></h2>
    <div class="kpis kpis-3">
      <div class="kpi us">
        <h3>Our wallet</h3>
        <div class="big ${ourPctCls}">${fmtPct(group.ourReturnPct)} <span style="color:#94a3b8;font-size:14px">(${fmtUsd(group.ourPnl, { sign: true })})</span></div>
        <div class="sub">Entry ${fmtUsd(group.ourBuyNotional)} · Value ${fmtUsd(group.ourValue)}</div>
      </div>
      <div class="kpi target">
        <h3>${escapeHtml(targetLabel)} (target)</h3>
        <div class="big ${targetPctCls}">${fmtPct(group.targetReturnPct)} <span style="color:#94a3b8;font-size:14px">(${fmtUsd(group.targetPnl, { sign: true })})</span></div>
        <div class="sub">Entry ${fmtUsd(group.targetBuyNotional)} · Value ${fmtUsd(group.targetValue)}</div>
      </div>
      <div class="kpi delta">
        <h3>Δ vs target</h3>
        <div class="big ${deltaCls}">${fmtPct(group.edgeGapPct)} <span style="color:#94a3b8;font-size:14px">(${fmtUsd(group.edgeGapUsdc, { sign: true })})</span></div>
        <div class="sub">positive = target ahead = alpha leak</div>
      </div>
    </div>
    <h3 class="subhead">Final positions (per market)</h3>
    ${cards}
    <h3 class="subhead">Position divergence over time</h3>
    ${charts}
  </section>`;
}

function renderHtml(args: {
  input: string;
  groups: EventGroup[];
  rawFills: RawFill[];
  decisions: DecisionRow[];
  placedOrders: PlacedHisto[];
  causes: CauseScore[];
  target: Target;
  ourWallet: string;
  ourLabel: string;
  charterRelPath: string;
}): string {
  const {
    input,
    groups,
    rawFills,
    decisions,
    placedOrders,
    causes,
    target,
    ourWallet,
    ourLabel,
    charterRelPath,
  } = args;
  // Time scale: first activity → last activity (NOT market resolution). This keeps the
  // actual trading window visible; otherwise the action gets jammed against the left edge
  // of a 5-day window that runs out to settlement.
  const allFillTimes = rawFills.map((f) => Number(f.observed_at));
  const allDecTimes = decisions.map((d) => Number(d.decided_at));
  const tMin =
    allFillTimes.length + allDecTimes.length > 0
      ? Math.min(...allFillTimes, ...allDecTimes)
      : Date.now() - 24 * 3600 * 1000;
  const tMax =
    allFillTimes.length + allDecTimes.length > 0
      ? Math.max(...allFillTimes, ...allDecTimes)
      : Date.now();
  // Add 5% pad on each side so end-points aren't flush against the axis.
  const pad = (tMax - tMin) * 0.05;
  const globalT = { min: tMin - pad, max: tMax + pad };
  void causes;

  const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; margin: 0; padding: 24px; max-width: 1320px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
.sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
.sub a { color: #60a5fa; text-decoration: none; } .sub a:hover { text-decoration: underline; }
.kpis { display: grid; gap: 12px; margin: 12px 0 18px; }
.kpis-3 { grid-template-columns: 1fr 1fr 1fr; }
.kpi { background: #131826; border: 1px solid #1f2937; border-radius: 8px; padding: 14px 16px; }
.kpi h3 { margin: 0 0 6px; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.kpi .big { font-size: 26px; font-weight: 600; line-height: 1.1; }
.kpi .sub { margin: 6px 0 0; color: #94a3b8; font-size: 12px; }
.kpi.us { border-left: 3px solid #3b82f6; }
.kpi.target { border-left: 3px solid #10b981; }
.kpi.delta { border-left: 3px solid #f59e0b; }
.pos { color: #22c55e; } .neg { color: #ef4444; }
.event-group { margin: 36px 0; padding-top: 16px; border-top: 1px solid #1f2937; }
.event-group > h2 { font-size: 18px; color: #f3f4f6; margin: 0 0 12px; font-weight: 600; }
.event-group .evslug { font-size: 11px; color: #6b7280; margin-left: 8px; font-weight: 400; }
.event-group .subhead { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.06em; margin: 20px 0 10px; }
.market-card { background: #131826; border: 1px solid #1f2937; border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
.market-head { padding: 10px 14px; background: #0f1525; border-bottom: 1px solid #1f2937; display: flex; align-items: center; gap: 10px; }
.market-title { font-weight: 600; font-size: 13px; }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 500; }
.badge.win { background: #052e1a; color: #34d399; border: 1px solid #10b98166; }
.badge.lose { background: #2a0a0a; color: #f87171; border: 1px solid #ef444466; }
.positions { width: 100%; border-collapse: collapse; font-size: 12px; }
.positions th, .positions td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #1f2937; }
.positions th { font-size: 10px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; background: #0e1422; }
.positions td.num { text-align: right; font-variant-numeric: tabular-nums; }
.wallet { font-weight: 600; }
.wallet.us { color: #60a5fa; } .wallet.target { color: #34d399; }
.chart { width: 100%; height: auto; display: block; margin: 4px 0 12px; border-radius: 8px; }
.empty { background: #131826; border: 1px dashed #334155; border-radius: 8px; padding: 18px; text-align: center; color: #64748b; }
.legend { font-size: 11px; color: #94a3b8; padding: 4px 14px 14px; display: flex; gap: 14px; flex-wrap: wrap; }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.legend .line { display: inline-block; width: 16px; height: 2px; margin-right: 5px; vertical-align: middle; }
.legend .line.dash { background: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px); height: 2px; }
.positions td.vwap-bad { color: #f87171; font-weight: 600; }
.positions td.vwap-good { color: #34d399; font-weight: 600; }
.positions tr.annotation td { font-size: 10.5px; color: #94a3b8; font-style: italic; padding: 3px 9px 8px; border-bottom: none; }
.positions tr.annotation td.vwap-bad { color: #f87171; font-style: normal; }
.positions tr.annotation td.vwap-good { color: #34d399; font-style: normal; }
.footer-note { font-size: 11px; color: #6b7280; margin-top: 28px; padding-top: 12px; border-top: 1px solid #1f2937; }
.footer-note a { color: #60a5fa; }
`;

  const totalDecisions = decisions.length;
  const placedSummary = (() => {
    let filled = 0,
      canceled = 0,
      err = 0,
      filledNotional = 0,
      attemptedNotional = 0;
    for (const p of placedOrders) {
      attemptedNotional += Number(p.total_size_attempted);
      if (p.status === "filled") {
        filled += Number(p.n);
        filledNotional += Number(p.total_size_attempted);
      } else if (p.status === "canceled") canceled += Number(p.n);
      else if (p.status === "error") err += Number(p.n);
    }
    return { filled, canceled, err, filledNotional, attemptedNotional };
  })();

  const groupsHtml = groups
    .map((g) =>
      renderGroupSection(
        g,
        rawFills,
        decisions,
        globalT,
        target.label,
        ourLabel
      )
    )
    .join("\n");

  const headerTitle =
    groups.length === 1
      ? (groups[0].event_title ?? "(unknown event)")
      : `${groups.length} event groups`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Δ-Report · ${escapeHtml(headerTitle)}</title>
<style>${css}
.takeaway { background: linear-gradient(180deg, #1f1410 0%, #131826 100%); border: 1px solid #f59e0b; border-radius: 8px; padding: 18px 22px; margin: 12px 0 26px; }
.takeaway h2 { margin: 0 0 12px; font-size: 13px; color: #fbbf24; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.takeaway table.findings { width: 100%; border-collapse: collapse; font-size: 13px; }
.takeaway table.findings th { font-size: 10px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 0 10px 6px 0; border-bottom: 1px solid #f59e0b33; }
.takeaway table.findings td { padding: 8px 10px 8px 0; vertical-align: top; border-bottom: 1px solid #f59e0b18; color: #e5e7eb; }
.takeaway table.findings td.conf { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; white-space: nowrap; }
.takeaway table.findings td.charter { font-size: 11px; color: #6b7280; white-space: nowrap; }
.takeaway .placeholder { color: #64748b; font-style: italic; font-size: 13px; }
.takeaway .fix { margin-top: 14px; padding-top: 12px; border-top: 1px solid #f59e0b33; font-size: 13px; color: #e5e7eb; line-height: 1.5; }
.takeaway .fix strong { color: #34d399; }
</style>
</head>
<body>
<h1>Δ-Report · ${escapeHtml(headerTitle)}</h1>
<div class="sub">
  Input: <code>${escapeHtml(input)}</code> · Copy-target: <strong style="color:#34d399">${escapeHtml(target.label)}</strong> <code>${escapeHtml(target.wallet)}</code> · Our wallet: <code>${escapeHtml(ourWallet)}</code><br/>
  Charter: <a href="${escapeHtml(charterRelPath)}">POLY_COPY_DELTA</a> · ${groups.length} event group${groups.length === 1 ? "" : "s"} · ${totalDecisions} mirror decisions · Global time scale: ${fmtTime(tMin)} → ${fmtTime(tMax)}
</div>

<!-- TAKEAWAY:START -->
<div class="takeaway">
  <h2>↗ Top finding</h2>
  <div class="placeholder">Awaiting LLM-authored takeaway. Script produces data + visualization; agent reads <code>bundle.json</code>, cross-references <code>plan-mirror.ts</code>, drafts/refines/critiques, then fills this block with a single highest-priority finding, charter class, % confidence, and Pareto fix. Replace between TAKEAWAY:START and TAKEAWAY:END.</div>
</div>
<!-- TAKEAWAY:END -->

${groupsHtml}

<div class="footer-note">
  <strong>${placedSummary.filled} orders filled</strong> · ${placedSummary.canceled} canceled · ${placedSummary.err} errored · ${fmtUsd(placedSummary.filledNotional)} filled / ${fmtUsd(placedSummary.attemptedNotional)} attempted
  · <a href="ai-walkthrough.md">AI walkthrough</a> · <a href="bundle.json">bundle.json</a>
</div>

</body>
</html>`;
}

// ---------- AI walkthrough ----------

function renderAiWalkthrough(args: {
  input: string;
  groups: EventGroup[];
  decisions: DecisionRow[];
  placedOrders: PlacedHisto[];
  causes: CauseScore[];
  target: Target;
  ourLabel: string;
}): string {
  const { input, groups, decisions, placedOrders, causes, target, ourLabel } =
    args;
  const lines: string[] = [];
  const eventTitle =
    groups[0]?.event_title ?? groups[0]?.event_slug ?? "(unknown event)";
  lines.push(`# AI walkthrough · Δ-Report · ${eventTitle}`);
  lines.push("");
  lines.push(
    `> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.`
  );
  lines.push("");

  lines.push(`## 1 · Input → resolution`);
  lines.push("");
  lines.push(`- Input: \`${input}\``);
  lines.push(
    `- Resolver: prefix-match on \`event_slug\` (so \`<slug>\` catches \`<slug>-more-markets\` siblings).`
  );
  lines.push(`- Event groups returned: ${groups.length}`);
  for (const g of groups) {
    lines.push(
      `  - **${g.event_title ?? "(no title)"}** · \`${g.event_slug}\` · ${g.markets.length} markets`
    );
    for (const m of g.markets)
      lines.push(`    - \`${m.condition_id}\` · ${m.market_title}`);
  }
  lines.push(
    `- **Copy-target**: \`${target.label}\` (\`${target.wallet}\`, ${target.n_decisions} decisions on these markets).`
  );
  lines.push(`- Our wallet: \`${ourLabel}\`.`);
  lines.push("");

  lines.push(`## 2 · Data sources (dashboard-equivalent)`);
  lines.push("");
  lines.push(`| Source | Notes |`);
  lines.push(`|---|---|`);
  lines.push(
    `| \`poly_trader_current_positions\` (OUR wallet) | Cost basis + current value. Redemption-status override: winner+redeemed → value 0, loser → value 0. Mirrors \`deriveCurrentPositionStatus\`. |`
  );
  lines.push(
    `| \`poly_trader_position_snapshots\` (TARGET wallet, latest per (cond, token)) | Append-only history; survives target exit. Used because targets only REDEEM, no SELL. |`
  );
  lines.push(
    `| \`poly_trader_fills\` rollup | Per (wallet, condition): \`max(BUY rollup, snapshot cost)\` = canonical cost basis denominator. Matches \`aggregateWalletReturn\`. |`
  );
  lines.push(
    `| \`poly_copy_trade_decisions\` (${decisions.length}) | Decision history with \`intent\` JSON. |`
  );
  lines.push(`| \`poly_copy_trade_fills\` | Status of OUR placed orders. |`);
  lines.push(
    `| CLOB \`/markets/{cond}\` | Authoritative \`{token_id, outcome label, winner}\` triples. |`
  );
  lines.push("");

  lines.push(`## 3 · Computation, in dashboard math`);
  lines.push("");
  lines.push(
    `- **Per (wallet, condition)** \`totalBuyNotional = max(rollup_buy, snapshot_cost)\`. The rollup wins when we have full fill history (our wallet); the snapshot wins when fills predate our backfill horizon (target wallet).`
  );
  lines.push(
    `- **Per (wallet, condition)** \`return_pct = (realized_cash + current_mark - buy_notional) / buy_notional\` (Modified-Dietz).`
  );
  lines.push(
    `- **Group return** = cost-basis-weighted blend of per-condition returns.`
  );
  lines.push(
    `- **Δ KPI** \`edgeGapPct = targetReturnPct - ourReturnPct\`; \`edgeGapUsdc = edgeGapPct × ourBuyNotional\`. Positive Δ = target ahead = alpha leak.`
  );
  lines.push("");

  lines.push(`## 4 · Group totals`);
  lines.push("");
  lines.push(
    `| Group | Our entry | Our value | Our Δ% | Target entry | Target value | Target Δ% | edgeGap % | edgeGap $ |`
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const g of groups) {
    lines.push(
      `| ${g.event_title ?? g.event_slug} | ${fmtUsd(g.ourBuyNotional)} | ${fmtUsd(g.ourValue)} | ${fmtPct(g.ourReturnPct)} | ${fmtUsd(g.targetBuyNotional)} | ${fmtUsd(g.targetValue)} | ${fmtPct(g.targetReturnPct)} | ${fmtPct(g.edgeGapPct)} | ${fmtUsd(g.edgeGapUsdc, { sign: true })} |`
    );
  }
  lines.push("");

  lines.push(`## 5 · Δ-class scoring (target-mirror framing)`);
  lines.push("");
  lines.push(`| Class | Trigger | Code path |`);
  lines.push(`|---|---|---|`);
  lines.push(
    `| D2 wrong-side allocation | Our cost on OPPOSITE side from target's primary > 30% of our cost | \`planMirrorFromFill\` |`
  );
  lines.push(
    `| D3 hedge blindness | ≥1 \`target_dominant_other_side\` skip on what became target's primary side | \`analyzeTargetDominance\` |`
  );
  lines.push(
    `| D4 VWAP gate bouncing | ≥1 \`vwap_floor_breach\` skip on target's primary side | \`targetVwapForToken\` |`
  );
  lines.push(`| D5 staleness | Cancel rate > 40% | resting-sweep TTL |`);
  lines.push("");

  lines.push(`## 6 · Ranked findings`);
  lines.push("");
  for (const c of causes) {
    lines.push(
      `### ${c.id} · ${c.title} (charter ${c.charter_class}, score ${c.score})`
    );
    lines.push("");
    for (const e of c.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  if (causes.length === 0) lines.push(`_No class crossed threshold._`);
  lines.push("");

  lines.push(`## 7 · Placement summary`);
  lines.push("");
  const ps = placedOrders.reduce(
    (a, p) => {
      if (p.status === "filled") {
        a.filled += Number(p.n);
        a.filledNotional += Number(p.total_size_attempted);
      } else if (p.status === "canceled") a.canceled += Number(p.n);
      else if (p.status === "error") a.error += Number(p.n);
      a.attempted += Number(p.total_size_attempted);
      return a;
    },
    { filled: 0, canceled: 0, error: 0, filledNotional: 0, attempted: 0 }
  );
  lines.push(
    `- Filled ${ps.filled} orders (${fmtUsd(ps.filledNotional)}) of ${ps.filled + ps.canceled + ps.error} placed (${fmtUsd(ps.attempted)} attempted)`
  );
  lines.push(`- Canceled ${ps.canceled} · Errored ${ps.error}`);
  lines.push("");

  lines.push(`## 8 · Not checked`);
  lines.push("");
  lines.push(
    `- **Loki**: only needed for \`outcome='error'\` rows where \`errorCode\` lives in the pino line. Skip-reason rows carry all data in the \`intent\` JSON.`
  );
  lines.push(
    `- **Target SELL fills**: targets only redeem (no SELL). The snapshot is the truth.`
  );
  lines.push(
    `- **Latency (D1)**: needs \`mirror-pipeline\` Loki lines. Not material once structural classes dominate.`
  );
  return lines.join("\n");
}

// ---------- Charter md → html ----------

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };
  const inline = (s: string): string => {
    let r = escapeHtml(s);
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return r;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") {
      i++;
      while (i < lines.length && lines[i].trim() !== "---") i++;
      i++;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      closeList();
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!m) {
        i++;
        continue;
      }
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
      continue;
    }
    if (
      /^\|.*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s-:|]+\|/.test(lines[i + 1])
    ) {
      closeList();
      const headers = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) {
        rows.push(
          lines[i]
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim())
        );
        i++;
      }
      out.push("<table>");
      out.push(
        `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`
      );
      const bodyCells = rows
        .map(
          (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`
        )
        .join("");
      out.push(`<tbody>${bodyCells}</tbody>`);
      out.push("</table>");
      continue;
    }
    if (/^- /.test(line)) {
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inline(line.replace(/^- /, ""))}</li>`);
      i++;
      continue;
    }
    if (/^> /.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^> /, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      closeList();
      out.push("");
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

function renderCharterHtml(md: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Poly Copy-Trade Δ Charter</title>
<style>
:root { color-scheme: dark; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; margin: 0; padding: 32px; max-width: 1100px; margin: 0 auto; line-height: 1.55; }
h1 { font-size: 26px; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-top: 0; }
h2 { font-size: 18px; color: #f3f4f6; margin-top: 28px; }
h3 { font-size: 14px; color: #cbd5e1; }
a { color: #60a5fa; }
code { background: #131826; padding: 1px 6px; border-radius: 3px; font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 12px 0 24px; }
th, td { padding: 8px 10px; border-bottom: 1px solid #1f2937; vertical-align: top; text-align: left; }
th { background: #0e1422; color: #94a3b8; font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
blockquote { border-left: 3px solid #475569; margin: 12px 0; padding: 4px 12px; color: #94a3b8; }
ul { padding-left: 20px; }
strong { color: #f3f4f6; }
</style></head><body>${markdownToHtml(md)}</body></html>`;
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[delta] resolving "${args.market}" …`);

  const markets = resolveMarkets(args.market, args.env);
  if (markets.length === 0) {
    console.error("No markets matched.");
    process.exit(1);
  }
  console.error(
    `[delta] ${markets.length} market(s) matched across ${new Set(markets.map((m) => m.event_slug)).size} event group(s).`
  );

  // Backfill event_title from Gamma if sparse.
  const uniqueSlugs = [
    ...new Set(markets.map((m) => m.event_slug).filter(Boolean)),
  ] as string[];
  await Promise.all(
    uniqueSlugs.map(async (slug) => {
      if (markets.find((m) => m.event_slug === slug && m.event_title)) return;
      try {
        const r = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${slug}`
        );
        if (!r.ok) return;
        const arr = (await r.json()) as { title?: string }[];
        const title = arr[0]?.title;
        if (title)
          for (const m of markets)
            if (m.event_slug === slug) m.event_title = title;
      } catch {
        /* non-fatal */
      }
    })
  );

  const ourSql = `select wallet_address, label from poly_trader_wallets where kind = 'cogni_wallet' limit 1`;
  const ourRow = runSql(ourSql, args.env)[0];
  if (!ourRow) throw new Error("No cogni_wallet found.");
  const ourWallet = String(ourRow.wallet_address);
  const ourLabel = String(ourRow.label);

  // OUR_POSITIONS_ANCHOR_GROUPS — narrow markets to those where we actually hold
  // a position (matches dashboard `market-exposure-service` behavior). This
  // prevents the report from showing markets in the same event_slug that we
  // never traded.
  const candidateConditionIds = markets.map((m) => m.condition_id);
  const ourLegsAll = fetchOurLegs(ourWallet, candidateConditionIds, args.env);
  const heldConditions = new Set(ourLegsAll.map((l) => l.condition_id));
  const filteredMarkets = markets.filter((m) =>
    heldConditions.has(m.condition_id)
  );
  if (filteredMarkets.length === 0) {
    console.error(
      "[delta] no markets in this input have any position in our wallet; nothing to report."
    );
    process.exit(1);
  }
  console.error(
    `[delta] anchored to ${filteredMarkets.length}/${markets.length} markets where our wallet holds a position.`
  );
  const conditionIds = filteredMarkets.map((m) => m.condition_id);

  const target = detectTarget(conditionIds, args.env, args.target);
  console.error(
    `[delta] target: ${target.label} (${target.wallet}) · ${target.n_decisions} decisions`
  );

  const outcomes = await fetchOutcomesAndLabels(conditionIds);
  const ourLegs = ourLegsAll.filter((l) => heldConditions.has(l.condition_id));
  const targetLegs = fetchTargetLegs(target.wallet, conditionIds, args.env);
  const rollups = fetchFillRollups(
    conditionIds,
    [target.wallet, ourWallet],
    args.env
  );
  const rawFills = fetchRawFills(
    conditionIds,
    [target.wallet, ourWallet],
    args.env
  );
  const decisions = fetchDecisions(target.target_id, conditionIds, args.env);
  const placedOrders = fetchPlacedOrders(
    target.target_id,
    conditionIds,
    args.env
  );

  // Group markets by event_slug.
  const groupMap = new Map<string, Market[]>();
  for (const m of filteredMarkets) {
    const key = m.event_slug ?? `cond:${m.condition_id}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)?.push(m);
  }
  const groups: EventGroup[] = [];
  for (const [, mkts] of groupMap) {
    const conds = mkts.map((m) => m.condition_id);
    const groupOuts = outcomes.filter((o) => conds.includes(o.condition_id));
    const groupOur = ourLegs.filter((l) => conds.includes(l.condition_id));
    const groupTarget = targetLegs.filter((l) =>
      conds.includes(l.condition_id)
    );
    groups.push(
      buildEventGroup(
        mkts,
        groupOuts,
        groupOur,
        groupTarget,
        rollups,
        ourWallet,
        target.wallet
      )
    );
  }
  // Sort groups: largest by our entry first.
  groups.sort((a, b) => b.ourBuyNotional - a.ourBuyNotional);

  const allMetrics = groups.flatMap((g) => g.metrics);
  const causes = classifyCauses(
    decisions,
    placedOrders,
    allMetrics,
    target.label
  );

  const slug =
    filteredMarkets[0]?.event_slug ??
    filteredMarkets[0]?.condition_id.slice(0, 10) ??
    "bundle";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(REPO_ROOT, "research/delta-minimizing", `${slug}-${ts}`);
  mkdirSync(outDir, { recursive: true });

  // Shared charter HTML — single copy at research/delta-minimizing/charter.html.
  // Re-rendered every run so it tracks the latest .md content.
  const charterMdPath = join(REPO_ROOT, "work/charters/POLY_COPY_DELTA.md");
  const sharedCharterPath = join(
    REPO_ROOT,
    "research/delta-minimizing/charter.html"
  );
  let charterRelPath = "../charter.html";
  try {
    const charterMd = readFileSync(charterMdPath, "utf8");
    writeFileSync(sharedCharterPath, renderCharterHtml(charterMd));
  } catch {
    charterRelPath = "../../work/charters/POLY_COPY_DELTA.md";
  }

  const html = renderHtml({
    input: args.market,
    groups,
    rawFills,
    decisions,
    placedOrders,
    causes,
    target,
    ourWallet,
    ourLabel,
    charterRelPath,
  });
  writeFileSync(join(outDir, "report.html"), html);

  const ai = renderAiWalkthrough({
    input: args.market,
    groups,
    decisions,
    placedOrders,
    causes,
    target,
    ourLabel,
  });
  writeFileSync(join(outDir, "ai-walkthrough.md"), ai);
  console.log(ai);

  // Always write bundle.json — it's the agent's read surface for authoring the takeaway.
  writeFileSync(
    join(outDir, "bundle.json"),
    JSON.stringify(
      {
        input: args.market,
        target,
        ourWallet,
        groups,
        decisions,
        placedOrders,
        causes,
      },
      null,
      2
    )
  );
  console.error(`[delta] bundle JSON → ${join(outDir, "bundle.json")}`);

  console.error(`[delta] HTML       → ${join(outDir, "report.html")}`);
  console.error(`[delta] AI walk    → ${join(outDir, "ai-walkthrough.md")}`);
  console.error(`[delta] charter    → ${sharedCharterPath} (shared)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
