// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/market-provider/domain/normalizers/polymarket`
 * Purpose: Pure normalizer — Polymarket Gamma API response → NormalizedMarket.
 * Scope: Stateless transform. Does not perform I/O, fetch, or depend on adapter code.
 * Invariants: OBSERVATION_IDEMPOTENT (deterministic IDs), PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: work/items/task.0230.market-data-package.md
 * @public
 */

import type { PolymarketRawMarket } from "../../adapters/polymarket/polymarket.types.js";
import type { NormalizedMarket } from "../schemas.js";

/**
 * Normalize a Polymarket Gamma API market to NormalizedMarket.
 * Pure function — no I/O.
 *
 * Price conversion: Polymarket uses 0.0–1.0 float → multiply by 10000 for bps.
 * outcomePrices is a JSON string: "[0.35, 0.65]"
 */
export function normalizePolymarketMarket(
  raw: PolymarketRawMarket
): NormalizedMarket {
  const prices: number[] = JSON.parse(raw.outcomePrices);
  const yesBps = Math.round((prices[0] ?? 0) * 10000);

  const outcomes =
    typeof raw.outcomes === "string"
      ? (JSON.parse(raw.outcomes) as string[])
      : raw.outcomes;

  return {
    id: `prediction-market:polymarket:${raw.id}`,
    provider: "polymarket",
    sourceId: raw.id,
    title: raw.question,
    category: raw.category ?? "Other",
    probabilityBps: yesBps,
    spreadBps: Math.round(raw.spreadPrice * 10000),
    volume: raw.volume,
    outcomes: outcomes.map((label, i) => ({
      label,
      probabilityBps: Math.round((prices[i] ?? 0) * 10000),
    })),
    resolvesAt: raw.endDate,
    active: raw.active && !raw.closed,
    attributes: { conditionId: raw.conditionId, negRisk: raw.negRisk },
    updatedAt: raw.updatedAt,
  };
}
