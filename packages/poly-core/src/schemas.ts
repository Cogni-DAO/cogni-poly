// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/schemas`
 * Purpose: Zod schemas for prediction market domain — LLM output, signals, and API response types matching frontend mocks.
 * Scope: Pure type definitions. Does not contain I/O, business logic, or adapter dependencies.
 * Invariants: API response schemas must match frontend mock types in BrainFeed.tsx and MarketCards.tsx exactly.
 * Side-effects: none
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md, apps/poly/src/components/BrainFeed.tsx
 * @public
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// LLM structured output — produced by poly-synth graph
// ---------------------------------------------------------------------------

/** Single LLM assessment for one market. Batched 5 per call. */
export const RawAssessmentSchema = z.object({
  entityId: z.string(),
  fairProbabilityPct: z.number().min(0).max(100),
  confidencePct: z.number().min(0).max(100),
  direction: z.enum(["bullish", "bearish"]),
  thesis: z.string(),
  sourcesUsed: z.array(z.string()),
});
export type RawAssessment = z.infer<typeof RawAssessmentSchema>;

/** Batch response from poly-synth graph. */
export const SynthesisOutputSchema = z.object({
  assessments: z.array(RawAssessmentSchema),
});
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

// ---------------------------------------------------------------------------
// API response types — must match frontend mock types exactly
// ---------------------------------------------------------------------------

const PlatformSignalSchema = z.enum(["Polymarket", "Kalshi", "Manifold"]);

/** Matches MarketSignal in BrainFeed.tsx */
export const MarketSignalSchema = z.object({
  id: z.string(),
  market: z.string(),
  platform: PlatformSignalSchema,
  category: z.string(),
  probability: z.number(),
  direction: z.enum(["bullish", "bearish"]),
  confidence: z.number(),
  thesis: z.string(),
  sources: z.array(z.string()),
  timestamp: z.string(),
});
export type MarketSignal = z.infer<typeof MarketSignalSchema>;

/** Matches BrainStatus in BrainFeed.tsx */
export const BrainStatusSchema = z.object({
  state: z.enum(["scanning", "analyzing", "idle"]),
  marketsScanned: z.number(),
  signalsGenerated: z.number(),
  lastHeartbeat: z.string(),
});
export type BrainStatus = z.infer<typeof BrainStatusSchema>;

const PlatformMarketSchema = z.enum(["Polymarket", "Kalshi"]);

/** Matches MarketOutcome in MarketCards.tsx */
export const MarketOutcomeResponseSchema = z.object({
  label: z.string(),
  probability: z.number(),
  /** positive = up, negative = down */
  change24h: z.number(),
});
export type MarketOutcomeResponse = z.infer<typeof MarketOutcomeResponseSchema>;

/** Matches Market in MarketCards.tsx */
export const MarketResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  platform: PlatformMarketSchema,
  volume: z.string(),
  outcomes: z.array(MarketOutcomeResponseSchema),
  /** ISO date string for market resolution */
  resolves: z.string(),
});
export type MarketResponse = z.infer<typeof MarketResponseSchema>;

// ---------------------------------------------------------------------------
// API endpoint response wrappers
// ---------------------------------------------------------------------------

export const BrainStatusResponseSchema = z.object({
  status: BrainStatusSchema,
});
export type BrainStatusResponse = z.infer<typeof BrainStatusResponseSchema>;

export const BrainSignalsResponseSchema = z.object({
  signals: z.array(MarketSignalSchema),
  nextCursor: z.string().nullable(),
});
export type BrainSignalsResponse = z.infer<typeof BrainSignalsResponseSchema>;

export const MarketsResponseSchema = z.object({
  markets: z.array(MarketResponseSchema),
  nextCursor: z.string().nullable(),
});
export type MarketsResponse = z.infer<typeof MarketsResponseSchema>;

// ---------------------------------------------------------------------------
// Action levels (re-exported for convenience)
// ---------------------------------------------------------------------------

export const ActionLevelSchema = z.enum([
  "observe",
  "alert",
  "recommend",
  "auto_act",
  "escalate",
]);
export type ActionLevel = z.infer<typeof ActionLevelSchema>;
