// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/market-provider/adapters/kalshi/kalshi.types`
 * Purpose: Zod schemas for raw Kalshi Trading API response shapes.
 * Scope: Pure type definitions for API response validation. Does not contain I/O or runtime logic.
 * Invariants: PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: work/items/task.0230.market-data-package.md
 * @public
 */

import { z } from "zod";

/**
 * Raw market shape from Kalshi Trading API: GET /trade-api/v2/markets
 * Gotchas: Values in cents (0–100), multiply by 100 for bps.
 * All endpoints require API key auth (RSA-PSS signed).
 */
export const KalshiRawMarketSchema = z.object({
  ticker: z.string(),
  title: z.string(),
  category: z.string().optional().nullable(),
  event_ticker: z.string(),
  yes_bid: z.number().default(0),
  yes_ask: z.number().default(0),
  no_bid: z.number().default(0),
  no_ask: z.number().default(0),
  volume: z.number().default(0),
  status: z.string(),
  expiration_time: z.string(),
  close_time: z.string().optional().nullable(),
});
export type KalshiRawMarket = z.infer<typeof KalshiRawMarketSchema>;

/** Kalshi paginated response envelope */
export const KalshiMarketsResponseSchema = z.object({
  markets: z.array(KalshiRawMarketSchema),
  cursor: z.string().optional().nullable(),
});
export type KalshiMarketsResponse = z.infer<typeof KalshiMarketsResponseSchema>;
