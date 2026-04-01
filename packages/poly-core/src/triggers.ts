// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/triggers`
 * Purpose: Pure trigger functions for prediction market monitoring — deterministic, replay-safe for Temporal Workflow code.
 * Scope: Pure functions only. Does not contain I/O, side effects, or non-deterministic calls.
 * Invariants:
 * - CHEAP_BEFORE_EXPENSIVE: Triggers are cheap deterministic filters run before any LLM call.
 * - WORKFLOW_PURE_ONLY: All functions are deterministic and replay-safe.
 * Side-effects: none
 * Links: docs/spec/monitoring-engine.md, work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

/** Result of a trigger check. */
export interface TriggerCheck {
  readonly entityId: string;
  readonly triggerType: string;
  readonly detail: string;
  /** Higher = more interesting. Used for budget prioritization. */
  readonly priority: number;
}

/** Thresholds for prediction market triggers. */
export const THRESHOLDS = {
  /** Minimum price move in basis points to trigger (500bps = 5%) */
  PRICE_MOVE_BPS: 500,
  /** Volume spike multiplier relative to 24h average */
  VOLUME_SPIKE_MULTIPLIER: 2.0,
  /** Cross-platform spread in basis points to trigger (300bps = 3%) */
  CROSS_PLATFORM_SPREAD_BPS: 300,
} as const;

/**
 * Check if a market's price has moved more than the threshold.
 * Compares current probability to a previous observation.
 *
 * @param entityId - Stable subject key
 * @param currentBps - Current probability in basis points (0–10000)
 * @param previousBps - Previous probability in basis points (0–10000)
 * @param thresholdBps - Override threshold (default: 500bps = 5%)
 * @returns TriggerCheck if threshold exceeded, null otherwise
 */
export function checkPriceMove(
  entityId: string,
  currentBps: number,
  previousBps: number,
  thresholdBps: number = THRESHOLDS.PRICE_MOVE_BPS
): TriggerCheck | null {
  const delta = Math.abs(currentBps - previousBps);
  if (delta < thresholdBps) return null;

  const direction = currentBps > previousBps ? "up" : "down";
  const pctMove = (delta / 100).toFixed(1);

  return {
    entityId,
    triggerType: "price_move",
    detail: `${pctMove}% ${direction} (${previousBps}→${currentBps} bps)`,
    priority: delta,
  };
}

/**
 * Check if volume has spiked relative to a baseline average.
 *
 * @param entityId - Stable subject key
 * @param currentVolume - Current volume (any unit, must match baseline)
 * @param baselineVolume - Baseline average volume (e.g., 24h average)
 * @param multiplier - Override multiplier (default: 2.0x)
 * @returns TriggerCheck if threshold exceeded, null otherwise
 */
export function checkVolumeSpike(
  entityId: string,
  currentVolume: number,
  baselineVolume: number,
  multiplier: number = THRESHOLDS.VOLUME_SPIKE_MULTIPLIER
): TriggerCheck | null {
  if (baselineVolume <= 0) return null;

  const ratio = currentVolume / baselineVolume;
  if (ratio < multiplier) return null;

  return {
    entityId,
    triggerType: "volume_spike",
    detail: `${ratio.toFixed(1)}x baseline volume (${currentVolume} vs ${baselineVolume} avg)`,
    priority: Math.round(ratio * 100),
  };
}

/**
 * Check if the spread between two platforms exceeds threshold.
 *
 * @param entityId - Stable subject key
 * @param platformAProbBps - Probability on platform A in basis points
 * @param platformBProbBps - Probability on platform B in basis points
 * @param platformAName - Name of platform A (for detail string)
 * @param platformBName - Name of platform B (for detail string)
 * @param thresholdBps - Override threshold (default: 300bps = 3%)
 * @returns TriggerCheck if threshold exceeded, null otherwise
 */
export function checkCrossPlatformSpread(
  entityId: string,
  platformAProbBps: number,
  platformBProbBps: number,
  platformAName: string,
  platformBName: string,
  thresholdBps: number = THRESHOLDS.CROSS_PLATFORM_SPREAD_BPS
): TriggerCheck | null {
  const spread = Math.abs(platformAProbBps - platformBProbBps);
  if (spread < thresholdBps) return null;

  const higher =
    platformAProbBps > platformBProbBps ? platformAName : platformBName;
  const pctSpread = (spread / 100).toFixed(1);

  return {
    entityId,
    triggerType: "cross_platform_spread",
    detail: `${pctSpread}% spread (${higher} higher: ${platformAProbBps} vs ${platformBProbBps} bps)`,
    priority: spread,
  };
}
