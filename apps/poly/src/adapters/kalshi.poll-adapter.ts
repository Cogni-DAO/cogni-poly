// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `poly/adapters/kalshi.poll-adapter`
 * Purpose: PollAdapter wrapping @cogni/market-provider KalshiAdapter — fetches markets and converts to ObservationEvents.
 * Scope: Thin glue between market-provider and ingestion-core. Does not contain raw HTTP logic.
 * Invariants: SINGLE_INGESTION_SUBSTRATE, OBSERVATION_IDEMPOTENT.
 * Side-effects: IO (delegates to MarketProviderPort)
 * Links: docs/spec/monitoring-engine.md, work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import type {
  CollectParams,
  CollectResult,
  PollAdapter,
  StreamDefinition,
} from "@cogni/ingestion-core";
import type { MarketProviderPort } from "@cogni/market-provider";
import { marketToObservation } from "@cogni/poly-core";

const STREAMS: StreamDefinition[] = [
  {
    id: "markets",
    name: "Kalshi Markets",
    cursorType: "token",
    defaultPollInterval: 300, // 5 min
  },
  {
    id: "prices",
    name: "Kalshi Prices",
    cursorType: "timestamp",
    defaultPollInterval: 60, // 60 sec
  },
];

/**
 * PollAdapter for Kalshi — delegates API calls to MarketProviderPort,
 * converts NormalizedMarket[] to ObservationEvent[] via poly-core.
 */
export class KalshiPollAdapter implements PollAdapter {
  constructor(private readonly provider: MarketProviderPort) {}

  streams(): StreamDefinition[] {
    return STREAMS;
  }

  async collect(params: CollectParams): Promise<CollectResult> {
    const now = new Date();

    const markets = await this.provider.listMarkets({
      limit: params.limit ?? 100,
      activeOnly: true,
      cursor: params.cursor?.value ?? undefined,
    });

    const observations = await Promise.all(
      markets.map((m) => marketToObservation(m, now))
    );

    // Advance cursor: current offset + batch size
    // Note: Kalshi API has opaque cursor pagination, but MarketProviderPort
    // doesn't expose it yet. Use offset-based for now.
    const currentOffset = Number(params.cursor?.value ?? "0");
    const nextOffset = currentOffset + markets.length;

    return {
      events: [],
      observations,
      nextCursor: {
        streamId: params.streams[0] ?? "markets",
        value: String(nextOffset),
        retrievedAt: now,
      },
    };
  }
}
