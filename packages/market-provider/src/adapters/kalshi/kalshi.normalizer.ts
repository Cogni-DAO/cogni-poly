// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/market-provider/adapters/kalshi/kalshi.normalizer`
 * Purpose: Pure normalizer — Kalshi Trading API response to NormalizedMarket.
 * Scope: Stateless transform for Kalshi raw types. Does not perform I/O or fetch.
 * Invariants: OBSERVATION_IDEMPOTENT (deterministic IDs), PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: work/items/task.0230.market-data-package.md
 * @public
 */

import type { NormalizedMarket } from "../../domain/schemas.js";
import type { KalshiRawMarket } from "./kalshi.types.js";

/**
 * Normalize a Kalshi Trading API market to NormalizedMarket.
 * Pure function — no I/O.
 *
 * Price conversion: Kalshi uses cents (0–100) → multiply by 100 for bps.
 */
export function normalizeKalshiMarket(raw: KalshiRawMarket): NormalizedMarket {
  const yesBps = raw.yes_bid * 100;
  const spreadBps = (raw.yes_ask - raw.yes_bid) * 100;

  return {
    id: `prediction-market:kalshi:${raw.ticker}`,
    provider: "kalshi",
    sourceId: raw.ticker,
    title: raw.title,
    category: raw.category ?? "Other",
    probabilityBps: yesBps,
    spreadBps: Math.max(0, spreadBps),
    volume: raw.volume,
    outcomes: [
      { label: "Yes", probabilityBps: yesBps },
      { label: "No", probabilityBps: raw.no_bid * 100 },
    ],
    resolvesAt: raw.expiration_time,
    active: raw.status === "open",
    attributes: { eventTicker: raw.event_ticker },
    updatedAt: raw.close_time ?? raw.expiration_time,
  };
}
