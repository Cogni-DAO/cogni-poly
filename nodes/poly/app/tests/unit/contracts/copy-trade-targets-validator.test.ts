// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/contracts/copy-trade-targets-validator`
 * Purpose: Pin the cross-field rule `validatePositionGapCapitalAlloc` that the
 *          POST + PATCH /api/v1/poly/copy-trade/targets routes use to return
 *          400 (instead of letting the DB CHECK 500 with a constraint
 *          violation) when a `position_gap` target is created/updated without
 *          a `mirror_capital_alloc_usdc`. Locked design 2026-05-18 — no
 *          default, no fallback, fail fast at the boundary.
 * Scope: Pure-function unit test on the contract predicate. No HTTP, no DB.
 * Links: docs/spec/poly-copy-trade-position-mirror.md (locked design note)
 */

import { validatePositionGapCapitalAlloc } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

describe("validatePositionGapCapitalAlloc()", () => {
  it("flags position_gap without alloc", () => {
    expect(
      validatePositionGapCapitalAlloc({ sizing_policy_kind: "position_gap" })
    ).toBe("position_gap_requires_capital_alloc_usdc");
  });

  it("accepts position_gap with explicit alloc", () => {
    expect(
      validatePositionGapCapitalAlloc({
        sizing_policy_kind: "position_gap",
        mirror_capital_alloc_usdc: 50,
      })
    ).toBeNull();
  });

  it("does NOT flag non-position_gap policies missing alloc", () => {
    for (const kind of [
      "auto",
      "min_bet",
      "target_percentile_scaled",
    ] as const) {
      expect(
        validatePositionGapCapitalAlloc({ sizing_policy_kind: kind })
      ).toBeNull();
    }
  });

  it("does NOT flag absence of sizing_policy_kind (PATCH partial input)", () => {
    expect(validatePositionGapCapitalAlloc({})).toBeNull();
    expect(
      validatePositionGapCapitalAlloc({ mirror_capital_alloc_usdc: 50 })
    ).toBeNull();
  });
});
