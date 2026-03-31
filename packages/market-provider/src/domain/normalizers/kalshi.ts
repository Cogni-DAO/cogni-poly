// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/market-provider/domain/normalizers/kalshi`
 * Purpose: Pure normalizer — Kalshi Trading API response to NormalizedMarket.
 * Scope: Stateless transform. Does not perform I/O, fetch, or depend on adapter code.
 * Invariants: OBSERVATION_IDEMPOTENT (deterministic IDs), PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: work/items/task.0230.market-data-package.md
 * @public
 */

import type { KalshiRawMarket } from "../../adapters/kalshi/kalshi.types.js";
import type { NormalizedMarket } from "../schemas.js";

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
    updatedAt: new Date().toISOString(),
  };
}
