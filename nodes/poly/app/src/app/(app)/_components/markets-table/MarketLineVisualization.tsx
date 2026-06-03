// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/markets-table/MarketLineVisualization`
 * Purpose: Visual replacement for the Primary|Hedge|Net numeric table in the
 *   markets-row expansion. Renders one `WalletExecutionMarketLine` as a shared
 *   price-axis chart with one lane per participant. Inside each lane: a solid
 *   rectangle at y=VWAP whose height encodes log(costBasisUsdc), and an
 *   optional dashed hedge rectangle on the opposite-token VWAP. Across all
 *   lanes a dashed horizontal line marks each token's current price; the
 *   vertical gap between rect and that line is the unrealized P/L, made
 *   directly readable as space.
 * Scope: Pure presentation. Pulls from the already-fetched line; no IO.
 * Invariants:
 *   - SHARED_Y_AXIS: every rectangle, every current-price line, every grid
 *     tick reads off the same 0¢..100¢ price scale. Cross-lane comparison
 *     (target vs ours) only works if Y stays universal.
 *   - LOG_COSTBASIS_HEIGHT: rectangle height = log10(cost+1) → [MIN_H,MAX_H]
 *     across the line's max. Linear scaling collapses small positions into
 *     1px slivers when a single $5k position shares the line with $5 ones.
 * Side-effects: none
 * @internal
 */

"use client";

import type {
  WalletExecutionMarketLeg,
  WalletExecutionMarketLine,
  WalletExecutionMarketParticipantRow,
} from "@cogni/poly-node-contracts";
import type { ReactElement } from "react";

import { cn } from "@/shared/util/cn";

// Functional accent colors. `TARGET_*` = copy targets (amber); `OUR_*` = our
// wallet (cyan). Distinct from PnL up/down semantics so a positive P/L target
// rectangle doesn't visually collide with a green grid line.
const TARGET_FILL = "#f59e0b";
const TARGET_STROKE = "#fbbf24";
const OUR_FILL = "#06b6d4";
const OUR_STROKE = "#22d3ee";

// SVG viewBox is fixed; the element scales via CSS. Lanes flex inside.
const VB_W = 880;
const VB_H = 300;
const M = { top: 18, right: 76, bottom: 56, left: 36 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

const MIN_RECT_H = 6;
const MAX_RECT_H = 56;
const MAX_RECT_W = 84;
const HEDGE_SCALE = 0.65;

type AccentKey = "target" | "ours";

function accentFor(
  side: WalletExecutionMarketParticipantRow["side"]
): AccentKey {
  return side === "our_wallet" ? "ours" : "target";
}

function priceY(price: number): number {
  return M.top + PLOT_H * (1 - Math.max(0, Math.min(1, price)));
}

function logHeight(cost: number, maxCost: number): number {
  if (maxCost <= 0) return MIN_RECT_H;
  const num = Math.log10(1 + Math.max(0, cost));
  const den = Math.log10(1 + maxCost);
  if (den <= 0) return MIN_RECT_H;
  return MIN_RECT_H + (MAX_RECT_H - MIN_RECT_H) * (num / den);
}

function impliedCurrentPrice(leg: WalletExecutionMarketLeg): number | null {
  if (leg.shares <= 0) return null;
  return leg.currentValueUsdc / leg.shares;
}

function formatUsdCompact(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function formatSignedUsdCompact(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatUsdCompact(Math.abs(value))}`;
}

function formatPriceCents(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

function pnlTextClass(value: number): string {
  if (value > 0) return "text-success";
  if (value < 0) return "text-destructive";
  return "text-muted-foreground";
}

/**
 * Across all participants' legs, extract the one current price per tokenId.
 * Returns ordered entries (largest combined cost basis first) so the
 * dominant outcome's price line is drawn — and labeled — first.
 */
function collectTokenPrices(
  participants: WalletExecutionMarketParticipantRow[]
): Array<{
  tokenId: string;
  outcome: string;
  price: number;
  totalCost: number;
}> {
  const acc = new Map<
    string,
    { outcome: string; price: number; totalCost: number }
  >();
  const legs: WalletExecutionMarketLeg[] = [];
  for (const p of participants) {
    if (p.primary) legs.push(p.primary);
    if (p.hedge) legs.push(p.hedge);
  }
  for (const leg of legs) {
    const cur = impliedCurrentPrice(leg);
    const prev = acc.get(leg.tokenId);
    const totalCost = (prev?.totalCost ?? 0) + leg.costBasisUsdc;
    if (cur !== null) {
      acc.set(leg.tokenId, {
        outcome: leg.outcome,
        price: cur,
        totalCost,
      });
    } else if (!prev) {
      acc.set(leg.tokenId, { outcome: leg.outcome, price: 0, totalCost });
    } else {
      acc.set(leg.tokenId, { ...prev, totalCost });
    }
  }
  return Array.from(acc.entries())
    .map(([tokenId, v]) => ({ tokenId, ...v }))
    .filter((row) => row.price > 0 || row.totalCost > 0)
    .sort((a, b) => b.totalCost - a.totalCost);
}

function lifecycleHaloColor(
  lifecycle: WalletExecutionMarketLeg["lifecycle"]
): string | null {
  switch (lifecycle) {
    case "winner":
      return "var(--color-success,#10b981)";
    case "loser":
      return "var(--color-destructive,#ef4444)";
    default:
      return null;
  }
}

export function MarketLineVisualization({
  line,
}: {
  line: WalletExecutionMarketLine;
}): ReactElement {
  const participants = line.participants;
  if (participants.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border bg-background text-muted-foreground text-xs">
        No participants on this market line.
      </div>
    );
  }

  const allLegs: WalletExecutionMarketLeg[] = participants.flatMap((p) =>
    [p.primary, p.hedge].filter(
      (l): l is WalletExecutionMarketLeg => l !== null
    )
  );
  const maxCost = Math.max(0, ...allLegs.map((l) => l.costBasisUsdc));
  const tokenPrices = collectTokenPrices(participants);

  const laneCount = participants.length;
  const laneW = PLOT_W / laneCount;

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block h-auto w-full select-none"
        role="img"
        aria-label={`Position visualization for ${line.marketTitle}: ${participants.length} participants on a shared 0–100¢ price axis. Rectangle Y position = VWAP, height = log of cost basis; dashed lines mark current token prices.`}
      >
        <title>{`${line.marketTitle} — position visualization`}</title>

        {/* y-axis ticks: 0, 25, 50, 75, 100 cents */}
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = priceY(tick);
          return (
            <g key={`tick-${tick}`}>
              <line
                x1={M.left}
                x2={M.left + PLOT_W}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={tick === 0.5 ? 0.18 : 0.08}
                strokeWidth={1}
                strokeDasharray={tick === 0 || tick === 1 ? undefined : "2 3"}
                className="text-muted-foreground"
              />
              <text
                x={M.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                className="fill-muted-foreground font-mono"
              >
                {Math.round(tick * 100)}¢
              </text>
            </g>
          );
        })}

        {/* Token current-price lines (one per token, across full plot) */}
        {tokenPrices.map((tp, idx) => {
          if (tp.price <= 0) return null;
          const y = priceY(tp.price);
          const stroke =
            idx === 0
              ? "var(--color-foreground,#e5e7eb)"
              : "var(--color-muted-foreground,#9ca3af)";
          const opacity = idx === 0 ? 0.55 : 0.4;
          return (
            <g key={`tp-${tp.tokenId}`}>
              <line
                x1={M.left}
                x2={M.left + PLOT_W}
                y1={y}
                y2={y}
                stroke={stroke}
                strokeOpacity={opacity}
                strokeWidth={1}
                strokeDasharray="5 3"
              />
              <text
                x={M.left + PLOT_W + 6}
                y={y + 3}
                textAnchor="start"
                fontSize={9}
                className="fill-foreground font-mono"
              >
                {formatPriceCents(tp.price)}
              </text>
              <text
                x={M.left + PLOT_W + 6}
                y={y - 6}
                textAnchor="start"
                fontSize={9}
                className="fill-muted-foreground"
              >
                {tp.outcome}
              </text>
            </g>
          );
        })}

        {/* Lane separators */}
        {participants.map((p, idx) => {
          if (idx === 0) return null;
          const x = M.left + idx * laneW;
          return (
            <line
              key={`lane-sep-${p.walletAddress}`}
              x1={x}
              x2={x}
              y1={M.top}
              y2={M.top + PLOT_H}
              stroke="currentColor"
              strokeOpacity={0.06}
              className="text-muted-foreground"
            />
          );
        })}

        {/* Participant lanes */}
        {participants.map((p, idx) => (
          <ParticipantLane
            key={`lane-${p.walletAddress}-${idx}`}
            participant={p}
            laneIndex={idx}
            laneW={laneW}
            maxCost={maxCost}
          />
        ))}

        {/* Lane footer labels */}
        {participants.map((p, idx) => {
          const cx = M.left + idx * laneW + laneW / 2;
          const accent = accentFor(p.side);
          const accentColor = accent === "ours" ? OUR_STROKE : TARGET_STROKE;
          const label = p.side === "our_wallet" ? "Our wallet" : p.label;
          const cost = p.net.costBasisUsdc;
          const pnl = p.net.pnlUsdc;
          return (
            <g key={`foot-${p.walletAddress}-${idx}`}>
              {/* accent bar */}
              <rect
                x={cx - 14}
                y={M.top + PLOT_H + 8}
                width={28}
                height={2}
                fill={accentColor}
                rx={1}
              />
              <text
                x={cx}
                y={M.top + PLOT_H + 22}
                textAnchor="middle"
                fontSize={11}
                className="fill-foreground font-medium"
              >
                {label}
              </text>
              <text
                x={cx}
                y={M.top + PLOT_H + 35}
                textAnchor="middle"
                fontSize={10}
                className="fill-muted-foreground font-mono tabular-nums"
              >
                {formatUsdCompact(cost)}
              </text>
              <text
                x={cx}
                y={M.top + PLOT_H + 47}
                textAnchor="middle"
                fontSize={10}
                className={cn("font-mono tabular-nums", pnlTextClass(pnl))}
              >
                {formatSignedUsdCompact(pnl)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ParticipantLane({
  participant,
  laneIndex,
  laneW,
  maxCost,
}: {
  participant: WalletExecutionMarketParticipantRow;
  laneIndex: number;
  laneW: number;
  maxCost: number;
}): ReactElement {
  const accent = accentFor(participant.side);
  const fill = accent === "ours" ? OUR_FILL : TARGET_FILL;
  const stroke = accent === "ours" ? OUR_STROKE : TARGET_STROKE;
  const cx = M.left + laneIndex * laneW + laneW / 2;

  const primaryNode = participant.primary
    ? renderLeg({
        leg: participant.primary,
        kind: "primary",
        cx,
        laneW,
        fill,
        stroke,
        maxCost,
        keyPrefix: `p${laneIndex}`,
      })
    : null;

  const hedgeNode = participant.hedge
    ? renderLeg({
        leg: participant.hedge,
        kind: "hedge",
        cx,
        laneW,
        fill,
        stroke,
        maxCost,
        keyPrefix: `h${laneIndex}`,
      })
    : null;

  return (
    <g>
      {primaryNode}
      {hedgeNode}
    </g>
  );
}

function renderLeg({
  leg,
  kind,
  cx,
  laneW,
  fill,
  stroke,
  maxCost,
  keyPrefix,
}: {
  leg: WalletExecutionMarketLeg;
  kind: "primary" | "hedge";
  cx: number;
  laneW: number;
  fill: string;
  stroke: string;
  maxCost: number;
  keyPrefix: string;
}): ReactElement | null {
  if (leg.vwap === null) return null;
  const y = priceY(leg.vwap);
  const h =
    (kind === "hedge" ? HEDGE_SCALE : 1) *
    logHeight(leg.costBasisUsdc, maxCost);
  const w = Math.max(16, Math.min(MAX_RECT_W, laneW * 0.7));
  const x = cx - w / 2;
  const ry = Math.min(3, h / 2);
  const currentPrice = impliedCurrentPrice(leg);
  const haloColor = lifecycleHaloColor(leg.lifecycle);
  const isExited = leg.shares <= 0;

  // PnL connector: thin line from rect edge to current-price line (if known).
  const connector =
    currentPrice !== null ? (
      <line
        x1={cx}
        x2={cx}
        y1={y}
        y2={priceY(currentPrice)}
        stroke={stroke}
        strokeOpacity={0.45}
        strokeWidth={1}
        strokeDasharray="1 2"
      />
    ) : null;

  return (
    <g key={`${keyPrefix}-${leg.tokenId}`}>
      {connector}
      <rect
        x={x}
        y={y - h / 2}
        width={w}
        height={h}
        rx={ry}
        ry={ry}
        fill={kind === "hedge" ? "transparent" : fill}
        fillOpacity={kind === "hedge" ? 0 : isExited ? 0.4 : 0.85}
        stroke={stroke}
        strokeWidth={kind === "hedge" ? 1 : 0.5}
        strokeDasharray={kind === "hedge" ? "3 2" : undefined}
      />
      {/* Outcome label, above-rect when room, otherwise tucked beside */}
      <text
        x={cx}
        y={y - h / 2 - 4}
        textAnchor="middle"
        fontSize={9}
        className="fill-foreground"
        style={{ fontWeight: kind === "primary" ? 500 : 400 }}
      >
        {leg.outcome}
        {kind === "hedge" ? " · hedge" : ""}
      </text>
      {/* VWAP value tucked at the rect's right edge in mono */}
      <text
        x={x + w + 3}
        y={y + 3}
        textAnchor="start"
        fontSize={8}
        className="fill-muted-foreground font-mono tabular-nums"
      >
        {formatPriceCents(leg.vwap)}
      </text>
      {/* Lifecycle halo dot in top-right corner */}
      {haloColor && (
        <circle cx={x + w - 3} cy={y - h / 2 + 3} r={2.5} fill={haloColor} />
      )}
    </g>
  );
}
