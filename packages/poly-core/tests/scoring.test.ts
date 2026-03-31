// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/tests/scoring`
 * Purpose: Unit tests for edge scoring and action level routing.
 * Scope: Tests scoreEdge and lookupBaseRate. Does not test I/O.
 * Invariants: ACTION_LEVELS — every signal has one of observe/alert/recommend/auto_act/escalate.
 * Side-effects: none
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { RawAssessment } from "../src/schemas.js";
import {
  lookupBaseRate,
  SCORING_THRESHOLDS,
  scoreEdge,
} from "../src/scoring.js";

function makeAssessment(overrides: Partial<RawAssessment> = {}): RawAssessment {
  return {
    entityId: "prediction-market:polymarket:abc",
    fairProbabilityPct: 70,
    confidencePct: 75,
    direction: "bullish",
    thesis: "Test thesis",
    sourcesUsed: ["source1"],
    ...overrides,
  };
}

describe("scoreEdge", () => {
  it("returns null when edge is below minimum (5%)", () => {
    // Fair = 62% (6200bps), market = 60% (6000bps) → edge = 200bps < 500bps
    const result = scoreEdge(makeAssessment({ fairProbabilityPct: 62 }), 6000);
    expect(result).toBeNull();
  });

  it("returns null when confidence is below minimum (50%)", () => {
    // Good edge but low confidence
    const result = scoreEdge(
      makeAssessment({ fairProbabilityPct: 70, confidencePct: 40 }),
      6000
    );
    expect(result).toBeNull();
  });

  it("returns signal when both edge and confidence meet thresholds", () => {
    // Fair = 70% (7000bps), market = 60% (6000bps) → edge = 1000bps
    const result = scoreEdge(
      makeAssessment({ fairProbabilityPct: 70, confidencePct: 65 }),
      6000
    );
    expect(result).not.toBeNull();
    expect(result?.edgeBps).toBe(1000);
    expect(result?.actionLevel).toBe("observe");
  });

  it("assigns alert level at 70% confidence", () => {
    const result = scoreEdge(
      makeAssessment({ fairProbabilityPct: 70, confidencePct: 75 }),
      6000
    );
    expect(result).not.toBeNull();
    expect(result?.actionLevel).toBe("alert");
  });

  it("assigns recommend level at 85% confidence + 8% edge", () => {
    // Fair = 70% (7000bps), market = 60% (6000bps) → edge = 1000bps (>800)
    const result = scoreEdge(
      makeAssessment({ fairProbabilityPct: 70, confidencePct: 90 }),
      6000
    );
    expect(result).not.toBeNull();
    expect(result?.actionLevel).toBe("recommend");
  });

  it("assigns alert (not recommend) at 85% confidence but <8% edge", () => {
    // Fair = 66% (6600bps), market = 60% (6000bps) → edge = 600bps (<800)
    const result = scoreEdge(
      makeAssessment({ fairProbabilityPct: 66, confidencePct: 90 }),
      6000
    );
    expect(result).not.toBeNull();
    expect(result?.actionLevel).toBe("alert");
  });

  it("preserves assessment fields in output", () => {
    const result = scoreEdge(
      makeAssessment({
        entityId: "test-entity",
        direction: "bearish",
        thesis: "my thesis",
        sourcesUsed: ["a", "b"],
      }),
      6000
    );
    expect(result).not.toBeNull();
    expect(result?.entityId).toBe("test-entity");
    expect(result?.direction).toBe("bearish");
    expect(result?.thesis).toBe("my thesis");
    expect(result?.sourcesUsed).toEqual(["a", "b"]);
  });

  it("threshold constants are correct", () => {
    expect(SCORING_THRESHOLDS.MIN_EDGE_BPS).toBe(500);
    expect(SCORING_THRESHOLDS.MIN_CONFIDENCE_PCT).toBe(50);
    expect(SCORING_THRESHOLDS.ALERT_CONFIDENCE_PCT).toBe(70);
    expect(SCORING_THRESHOLDS.RECOMMEND_CONFIDENCE_PCT).toBe(85);
    expect(SCORING_THRESHOLDS.RECOMMEND_EDGE_BPS).toBe(800);
  });
});

describe("lookupBaseRate", () => {
  const rates = new Map([
    ["prediction-market:economics:fed_rate_cut", 0.35],
    ["prediction-market:politics:incumbent_reelection", 0.67],
  ]);

  it("returns frequency for matching key", () => {
    expect(
      lookupBaseRate("prediction-market:economics:fed_rate_cut", rates)
    ).toBe(0.35);
  });

  it("returns null for unknown key", () => {
    expect(lookupBaseRate("prediction-market:unknown:key", rates)).toBeNull();
  });
});
