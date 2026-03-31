// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/scoring`
 * Purpose: Edge scoring and action level routing for prediction market signals.
 * Scope: Pure functions only. Does not contain I/O or side effects.
 * Invariants:
 * - WORKFLOW_PURE_ONLY: Deterministic, replay-safe for Temporal Workflow code.
 * - ACTION_LEVELS: Every signal declares one of observe/alert/recommend/auto_act/escalate.
 * Side-effects: none
 * Links: docs/spec/monitoring-engine.md, work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import type { ActionLevel, RawAssessment } from "./schemas.js";

/** Scored signal output from scoreEdge. */
export interface ScoredSignal {
  readonly entityId: string;
  readonly edgeBps: number;
  readonly confidencePct: number;
  readonly direction: "bullish" | "bearish";
  readonly fairProbabilityPct: number;
  readonly thesis: string;
  readonly sourcesUsed: string[];
  readonly actionLevel: ActionLevel;
}

/** Thresholds for edge scoring and action routing. */
export const SCORING_THRESHOLDS = {
  /** Minimum edge in basis points to generate a signal (500bps = 5%) */
  MIN_EDGE_BPS: 500,
  /** Minimum confidence to generate a signal */
  MIN_CONFIDENCE_PCT: 50,
  /** Confidence threshold for alert level */
  ALERT_CONFIDENCE_PCT: 70,
  /** Confidence threshold for recommend level */
  RECOMMEND_CONFIDENCE_PCT: 85,
  /** Edge threshold for recommend level (800bps = 8%) */
  RECOMMEND_EDGE_BPS: 800,
} as const;

/**
 * Score the edge between AI fair probability and market price.
 * Filters out low-edge and low-confidence assessments.
 *
 * @param assessment - LLM assessment output
 * @param marketProbBps - Current market probability in basis points (0–10000)
 * @returns ScoredSignal if edge is actionable, null if filtered out
 */
export function scoreEdge(
  assessment: RawAssessment,
  marketProbBps: number
): ScoredSignal | null {
  const fairBps = Math.round(assessment.fairProbabilityPct * 100);
  const edgeBps = Math.abs(fairBps - marketProbBps);

  // Filter: minimum edge and confidence
  if (edgeBps < SCORING_THRESHOLDS.MIN_EDGE_BPS) return null;
  if (assessment.confidencePct < SCORING_THRESHOLDS.MIN_CONFIDENCE_PCT)
    return null;

  const actionLevel = routeActionLevel(assessment.confidencePct, edgeBps);

  return {
    entityId: assessment.entityId,
    edgeBps,
    confidencePct: assessment.confidencePct,
    direction: assessment.direction,
    fairProbabilityPct: assessment.fairProbabilityPct,
    thesis: assessment.thesis,
    sourcesUsed: assessment.sourcesUsed,
    actionLevel,
  };
}

/**
 * Route action level based on confidence and edge.
 * observe < 70% conf, alert 70-85%, recommend 85%+ AND 8%+ edge.
 */
function routeActionLevel(confidencePct: number, edgeBps: number): ActionLevel {
  if (
    confidencePct >= SCORING_THRESHOLDS.RECOMMEND_CONFIDENCE_PCT &&
    edgeBps >= SCORING_THRESHOLDS.RECOMMEND_EDGE_BPS
  ) {
    return "recommend";
  }
  if (confidencePct >= SCORING_THRESHOLDS.ALERT_CONFIDENCE_PCT) {
    return "alert";
  }
  return "observe";
}

/**
 * Look up the base rate for a given category key.
 * Returns null if no matching base rate is found.
 *
 * @param categoryKey - Key in format "domain:category:event_type"
 * @param baseRates - Map of category_key → historical frequency (0.0–1.0)
 */
export function lookupBaseRate(
  categoryKey: string,
  baseRates: ReadonlyMap<string, number>
): number | null {
  return baseRates.get(categoryKey) ?? null;
}
