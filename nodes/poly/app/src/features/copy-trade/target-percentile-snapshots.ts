// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/target-percentile-snapshots`
 * Purpose: Pure source-of-truth for the hardcoded per-target position-size percentile snapshots that drive `target_percentile` / `target_percentile_scaled` sizing policies. Bootstrap consumes these to build `MirrorTargetConfig.sizing.statistic`; research tooling (delta-minimizer report) consumes them to overlay pXX thresholds on charts.
 * Scope: Data + pure interpolation only. No I/O, no env reads, no DB.
 * Invariants:
 *   - ONE_SOURCE_OF_TRUTH_FOR_PXX — every consumer of pXX thresholds (bootstrap, research, future visualizers) imports from this module. No parallel snapshot tables.
 *   - SNAPSHOT_IS_FROZEN_PER_TARGET — `captured_at` is the one-time capture date; consumers MUST surface it so stale-data risk is visible. When snapshots become dynamic, persist them on `poly_copy_trade_decisions` (separate change).
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, work/charters/POLY_COPY_DELTA.md
 * @public
 */

import type { WalletSizeStatistic } from "./types";

export interface WalletSizeSnapshot {
  wallet: `0x${string}`;
  label: string;
  captured_at: string;
  sample_size: number;
  percentiles: Record<number, number>;
}

const RN1_WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SWISSTONY_WALLET = "0x204f72f35326db932158cba6adff0b9a1da95e14";

export const TOP_TARGET_SIZE_SNAPSHOTS: Record<string, WalletSizeSnapshot> = {
  [RN1_WALLET]: {
    wallet: RN1_WALLET,
    label: "RN1",
    captured_at: "2026-05-03T02:34:00Z",
    sample_size: 3990,
    percentiles: {
      50: 40,
      75: 200,
      90: 733,
      95: 1811,
      99: 5659,
    },
  },
  [SWISSTONY_WALLET]: {
    wallet: SWISSTONY_WALLET,
    label: "swisstony",
    captured_at: "2026-05-03T02:34:00Z",
    sample_size: 1085,
    percentiles: {
      50: 31,
      75: 146,
      90: 665,
      95: 1394,
      99: 4809,
    },
  },
};

export function snapshotForTargetWallet(
  targetWallet: `0x${string}`
): WalletSizeSnapshot | undefined {
  return TOP_TARGET_SIZE_SNAPSHOTS[targetWallet.toLowerCase()];
}

export function interpolatePercentile(
  percentiles: Record<number, number>,
  percentile: number
): number {
  const points = Object.keys(percentiles)
    .map(Number)
    .sort((a, b) => a - b);
  const exact = percentiles[percentile];
  if (exact !== undefined) return exact;
  const lower = [...points].reverse().find((p) => p < percentile);
  const upper = points.find((p) => p > percentile);
  if (lower === undefined) {
    const minPoint = points[0];
    if (minPoint === undefined) {
      throw new Error("percentile snapshot is empty");
    }
    return percentiles[minPoint] ?? 0;
  }
  if (upper === undefined) {
    const maxPoint = points.at(-1);
    if (maxPoint === undefined) {
      throw new Error("percentile snapshot is empty");
    }
    return percentiles[maxPoint] ?? 0;
  }
  const lowerValue = percentiles[lower];
  const upperValue = percentiles[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error("percentile snapshot is sparse");
  }
  const t = (percentile - lower) / (upper - lower);
  return Number((lowerValue + (upperValue - lowerValue) * t).toFixed(2));
}

export function buildWalletStatistic(
  snapshot: WalletSizeSnapshot,
  percentile: number
): WalletSizeStatistic {
  const maxTargetUsdc = snapshot.percentiles[99];
  if (maxTargetUsdc === undefined) {
    throw new Error(`missing p99 for ${snapshot.wallet}`);
  }
  return {
    wallet: snapshot.wallet,
    label: snapshot.label,
    captured_at: snapshot.captured_at,
    sample_size: snapshot.sample_size,
    percentile,
    min_target_usdc: interpolatePercentile(snapshot.percentiles, percentile),
    max_target_usdc: maxTargetUsdc,
  };
}
