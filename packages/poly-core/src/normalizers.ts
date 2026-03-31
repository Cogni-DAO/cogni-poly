// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/normalizers`
 * Purpose: Pure normalizers that convert market-provider NormalizedMarket into ingestion-core ObservationEvent.
 * Scope: Pure functions only. Does not contain I/O or side effects.
 * Invariants:
 * - OBSERVATION_IDEMPOTENT: IDs are deterministic via buildEventId().
 * - PROVENANCE_REQUIRED: payloadHash via hashCanonicalPayload().
 * Side-effects: none
 * Links: docs/spec/monitoring-engine.md
 * @public
 */

import type { ObservationEvent } from "@cogni/ingestion-core";
import {
  buildEventId,
  canonicalJson,
  hashCanonicalPayload,
} from "@cogni/ingestion-core";
import type { NormalizedMarket } from "@cogni/market-provider";

import type { MarketResponse } from "./schemas.js";

/**
 * Convert a NormalizedMarket into an ObservationEvent for ingestion.
 *
 * @param market - NormalizedMarket from market-provider
 * @param observedAt - When this observation was taken
 * @returns ObservationEvent ready for persistence
 */
export async function marketToObservation(
  market: NormalizedMarket,
  observedAt: Date
): Promise<ObservationEvent> {
  const entityId = market.id; // Already deterministic: "prediction-market:{provider}:{sourceId}"

  const values: Record<string, number> = {
    probabilityBps: market.probabilityBps,
    spreadBps: market.spreadBps,
    volumeUsd: market.volume,
  };

  // Add per-outcome probabilities
  for (let i = 0; i < market.outcomes.length; i++) {
    const outcome = market.outcomes[i];
    if (outcome) {
      values[`outcome_${i}_probabilityBps`] = outcome.probabilityBps;
    }
  }

  const metadata: Record<string, unknown> = {
    sourceId: market.sourceId,
    provider: market.provider,
    title: market.title,
    resolvesAt: market.resolvesAt,
    active: market.active,
    attributes: market.attributes,
  };

  const id = buildEventId(
    market.provider,
    "obs",
    entityId,
    observedAt.getTime().toString()
  );

  const payloadHash = await hashCanonicalPayload(
    JSON.parse(
      canonicalJson({
        id,
        entityId,
        values,
        observedAt: observedAt.toISOString(),
      })
    ) as Record<string, unknown>
  );

  return {
    id,
    source: market.provider,
    entityId,
    entityTitle: market.title,
    category: market.category,
    values,
    metadata,
    payloadHash,
    observedAt,
  };
}

/**
 * Format volume as a human-readable string (e.g., "$4.2M", "$890K").
 */
export function formatVolume(volume: number): string {
  if (volume >= 1_000_000) {
    const m = volume / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (volume >= 1_000) {
    const k = volume / 1_000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${volume}`;
}

/**
 * Convert a NormalizedMarket to the MarketResponse shape expected by MarketCards.tsx.
 *
 * @param market - NormalizedMarket from market-provider
 * @param change24h - 24h price change per outcome in percentage points (computed from observations)
 */
export function marketToResponse(
  market: NormalizedMarket,
  change24h: number[]
): MarketResponse {
  const platformMap = { polymarket: "Polymarket", kalshi: "Kalshi" } as const;

  return {
    id: market.id,
    title: market.title,
    category: market.category,
    platform: platformMap[market.provider],
    volume: formatVolume(market.volume),
    outcomes: market.outcomes.map((o, i) => ({
      label: o.label,
      probability: Math.round(o.probabilityBps / 100),
      change24h: change24h[i] ?? 0,
    })),
    resolves: market.resolvesAt,
  };
}
