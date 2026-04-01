// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core`
 * Purpose: Pure domain types, schemas, triggers, and scoring for prediction market monitoring.
 * Scope: Pure package — no I/O, no adapter dependencies. Does not contain HTTP clients or database calls.
 * Invariants: PACKAGES_NO_ENV, PACKAGES_NO_LIFECYCLE, PACKAGES_NO_SRC_IMPORTS.
 * Side-effects: none
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md, docs/spec/monitoring-engine.md
 * @public
 */

// Normalizers
export {
  formatVolume,
  marketToObservation,
  marketToResponse,
} from "./normalizers.js";
// Schemas
export {
  type ActionLevel,
  ActionLevelSchema,
  type BrainSignalsResponse,
  BrainSignalsResponseSchema,
  type BrainStatus,
  type BrainStatusResponse,
  BrainStatusResponseSchema,
  BrainStatusSchema,
  type MarketOutcomeResponse,
  MarketOutcomeResponseSchema,
  type MarketResponse,
  MarketResponseSchema,
  type MarketSignal,
  MarketSignalSchema,
  type MarketsResponse,
  MarketsResponseSchema,
  type RawAssessment,
  RawAssessmentSchema,
  type SynthesisOutput,
  SynthesisOutputSchema,
} from "./schemas.js";

// Scoring
export {
  lookupBaseRate,
  SCORING_THRESHOLDS,
  type ScoredSignal,
  scoreEdge,
} from "./scoring.js";
// Triggers
export {
  checkCrossPlatformSpread,
  checkPriceMove,
  checkVolumeSpike,
  THRESHOLDS,
  type TriggerCheck,
} from "./triggers.js";
