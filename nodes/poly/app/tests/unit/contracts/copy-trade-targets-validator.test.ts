// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/contracts/copy-trade-targets-validator`
 * Purpose: Pin the cross-field rule `validatePositionGapRangeKnobs` that the
 *          POST + PATCH /api/v1/poly/copy-trade/targets routes use to return
 *          400 (instead of letting the DB CHECK 500) when a `position_gap`
 *          target is created/updated without BOTH `target_range_max_usdc`
 *          AND `mirror_max_alloc_per_condition_usdc`. task.5014 rewrite —
 *          see docs/research/poly/range-relative-mirror-2026-05-26.md.
 */

import {
  MIN_ALLOC_TO_RANGE_RATIO,
  validatePositionGapRangeKnobs,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

describe("validatePositionGapRangeKnobs()", () => {
  it("flags position_gap missing target_range_max_usdc", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        mirror_max_alloc_per_condition_usdc: 20,
      })
    ).toBe("position_gap_requires_target_range_max_usdc");
  });

  it("flags position_gap missing mirror_max_alloc_per_condition_usdc", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        target_range_max_usdc: 10_000,
      })
    ).toBe("position_gap_requires_mirror_max_alloc_per_condition_usdc");
  });

  it("flags position_gap missing both knobs (range_max first)", () => {
    expect(
      validatePositionGapRangeKnobs({ sizing_policy_kind: "position_gap" })
    ).toBe("position_gap_requires_target_range_max_usdc");
  });

  it("accepts position_gap with both knobs at the canonical 1:1 ratio", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        target_range_max_usdc: 10_000,
        mirror_max_alloc_per_condition_usdc: 10_000,
      })
    ).toBeNull();
  });

  it("does NOT flag non-position_gap policies missing range knobs", () => {
    for (const kind of [
      "auto",
      "min_bet",
      "target_percentile_scaled",
    ] as const) {
      expect(
        validatePositionGapRangeKnobs({ sizing_policy_kind: kind })
      ).toBeNull();
    }
  });

  it("does NOT flag absence of sizing_policy_kind (PATCH partial input)", () => {
    expect(validatePositionGapRangeKnobs({})).toBeNull();
    expect(
      validatePositionGapRangeKnobs({ target_range_max_usdc: 10_000 })
    ).toBeNull();
    expect(
      validatePositionGapRangeKnobs({
        mirror_max_alloc_per_condition_usdc: 20,
      })
    ).toBeNull();
  });

  // bug.5026 — silent under-sizing when max_alloc << range_max
  describe("ratio guard (bug.5026)", () => {
    it("flags ratios well below threshold (the original incident: 15 / 500000 = 3e-5)", () => {
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 500_000,
          mirror_max_alloc_per_condition_usdc: 15,
        })
      ).toBe("position_gap_alloc_range_ratio_too_small");
    });

    it("flags ratios just under threshold", () => {
      // ratio = 0.04 < 0.05 → reject
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 10_000,
          mirror_max_alloc_per_condition_usdc: 400,
        })
      ).toBe("position_gap_alloc_range_ratio_too_small");
    });

    it("accepts ratios at the threshold", () => {
      // ratio = exactly MIN_ALLOC_TO_RANGE_RATIO → accept (strict `<`)
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 10_000,
          mirror_max_alloc_per_condition_usdc:
            10_000 * MIN_ALLOC_TO_RANGE_RATIO,
        })
      ).toBeNull();
    });

    it("accepts the canonical 1:1 mirror (max_alloc = range_max)", () => {
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 50_000,
          mirror_max_alloc_per_condition_usdc: 50_000,
        })
      ).toBeNull();
    });

    it("accepts inverted ratios (max_alloc >> range_max — leveraged mirror)", () => {
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 1_000,
          mirror_max_alloc_per_condition_usdc: 10_000,
        })
      ).toBeNull();
    });

    it("does NOT divide by zero on range_max=0 (presence guards fire first conceptually)", () => {
      // range_max=0 is a Zod-positive failure upstream; defense-in-depth here:
      // the function should not throw, and should NOT trigger the ratio rule
      // (presence rules cover the not-set case; a zero value is malformed and
      // a different layer's problem).
      expect(
        validatePositionGapRangeKnobs({
          sizing_policy_kind: "position_gap",
          target_range_max_usdc: 0,
          mirror_max_alloc_per_condition_usdc: 15,
        })
      ).toBeNull();
    });
  });
});
