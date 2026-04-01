// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/ingestion`
 * Purpose: AI awareness & decision plane tables — observations, analysis runs, signals, outcomes, base rates.
 * Scope: Defines observation_events, analysis_runs, analysis_signals, analysis_outcomes, base_rates tables. Does not contain queries, business logic, or I/O.
 * Invariants:
 * - OBSERVATION_APPEND_ONLY: observation_events is append-only (DB trigger rejects UPDATE/DELETE).
 * - OBSERVATION_IDEMPOTENT: Observation IDs are deterministic via buildEventId().
 * - NODE_SCOPED: observation_events, analysis_runs, analysis_signals include node_id.
 * - NO_ENTITY_REGISTRY: No monitored_entities table. entityId is a stable key on raw records.
 * - ACTION_LEVELS: analysis_signals.action_level must be one of observe/alert/recommend/auto_act/escalate.
 * - All timestamps use withTimezone: true.
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/monitoring-engine.md, work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ANALYSIS_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
] as const;
export type AnalysisRunStatus = (typeof ANALYSIS_RUN_STATUSES)[number];

export const ACTION_LEVELS = [
  "observe",
  "alert",
  "recommend",
  "auto_act",
  "escalate",
] as const;
export type ActionLevel = (typeof ACTION_LEVELS)[number];

// ---------------------------------------------------------------------------
// observation_events — raw observation log (append-only)
// ---------------------------------------------------------------------------

/**
 * Raw observations from external sources. Append-only — DB trigger rejects UPDATE/DELETE.
 * IDs are deterministic: "{source}:obs:{entityId}:{timestamp}" (OBSERVATION_IDEMPOTENT).
 * TimescaleDB hypertable on observed_at when available; plain table otherwise.
 */
export const observationEvents = pgTable(
  "observation_events",
  {
    /** Deterministic: "{source}:obs:{entityId}:{timestamp}" */
    id: text("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    /** Adapter source name: "polymarket", "kalshi", "grafana", etc. */
    source: text("source").notNull(),
    /** Stable subject key: "polymarket:market:abc123" */
    entityId: text("entity_id").notNull(),
    /** Human-readable label */
    entityTitle: text("entity_title").notNull(),
    /** Domain-specific category: "economics", "api-latency", etc. */
    category: text("category").notNull(),
    /** Domain-specific numeric fields: { probabilityBps, spreadBps, volumeUsd, ... } */
    values: jsonb("values").$type<Record<string, number>>().notNull(),
    /** Non-numeric context, source pointers for deep investigation */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** SHA-256 provenance */
    payloadHash: text("payload_hash").notNull(),
    /** When the measurement was taken at the source */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** When we stored it */
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("obs_entity_observed_idx").on(table.entityId, table.observedAt),
    index("obs_source_idx").on(table.source),
    index("obs_category_idx").on(table.category),
    index("obs_node_observed_idx").on(table.nodeId, table.observedAt),
  ]
);

// ---------------------------------------------------------------------------
// analysis_runs — when and why AI was invoked
// ---------------------------------------------------------------------------

/**
 * Analysis run records. ID is the Temporal workflowId.
 */
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    /** Temporal workflowId */
    id: text("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    /** Domain: "prediction-market", "infrastructure", etc. */
    domain: text("domain").notNull(),
    /** Domain-defined trigger type */
    triggerType: text("trigger_type").notNull(),
    /** Human-readable context */
    triggerDetail: text("trigger_detail"),
    entitiesAnalyzed: integer("entities_analyzed").notNull().default(0),
    signalsGenerated: integer("signals_generated").notNull().default(0),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "analysis_runs_status_check",
      sql`${table.status} IN ('running', 'completed', 'failed')`
    ),
    index("analysis_runs_domain_idx").on(table.domain),
    index("analysis_runs_node_idx").on(table.nodeId),
  ]
);

// ---------------------------------------------------------------------------
// analysis_signals — AI conclusions
// ---------------------------------------------------------------------------

/**
 * Scored signals from analysis. ID is deterministic: "signal:{entityId}:{runId}".
 */
export const analysisSignals = pgTable(
  "analysis_signals",
  {
    /** Deterministic: "signal:{entityId}:{runId}" */
    id: text("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    /** Stable subject key (not FK — no entity table) */
    entityId: text("entity_id").notNull(),
    /** Which run produced this */
    runId: text("run_id")
      .notNull()
      .references(() => analysisRuns.id),
    /** Domain */
    domain: text("domain").notNull(),
    /** What was found */
    finding: text("finding").notNull(),
    /** LLM reasoning */
    thesis: text("thesis").notNull(),
    /** 0–100 */
    confidencePct: integer("confidence_pct").notNull(),
    /** observe/alert/recommend/auto_act/escalate */
    actionLevel: text("action_level").notNull(),
    /** Domain-specific structured data */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Evidence references */
    sources: jsonb("sources").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "analysis_signals_action_level_check",
      sql`${table.actionLevel} IN ('observe', 'alert', 'recommend', 'auto_act', 'escalate')`
    ),
    index("analysis_signals_entity_idx").on(table.entityId),
    index("analysis_signals_run_idx").on(table.runId),
    index("analysis_signals_domain_idx").on(table.domain),
    index("analysis_signals_node_idx").on(table.nodeId),
  ]
);

// ---------------------------------------------------------------------------
// analysis_outcomes — ground truth for calibration
// ---------------------------------------------------------------------------

/**
 * Ground truth when entities resolve. Compared against signals for calibration.
 */
export const analysisOutcomes = pgTable(
  "analysis_outcomes",
  {
    id: text("id").primaryKey(),
    /** What resolved */
    entityId: text("entity_id").notNull(),
    /** What actually happened */
    resolution: text("resolution").notNull(),
    /** null until evaluated against signals */
    correct: boolean("correct"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("analysis_outcomes_entity_idx").on(table.entityId)]
);

// ---------------------------------------------------------------------------
// base_rates — historical frequencies for calibration
// ---------------------------------------------------------------------------

/**
 * Historical event frequencies used for AI calibration.
 * Seeded via migration, updated by calibration loop.
 */
export const baseRates = pgTable("base_rates", {
  /** Format: "{domain}:{category}:{event_type}" */
  categoryKey: text("category_key").primaryKey(),
  domain: text("domain").notNull(),
  historicalFrequency: numeric("historical_frequency", {
    precision: 6,
    scale: 4,
  }).notNull(),
  sampleSize: integer("sample_size").notNull(),
  /** Where the rate came from */
  source: text("source").notNull(),
});
