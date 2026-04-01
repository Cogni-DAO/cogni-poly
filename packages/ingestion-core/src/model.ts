// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core/model`
 * Purpose: Domain types for ingestion — purpose-neutral, shared across ledger, governance, and AI decision consumers.
 * Scope: Pure types. Does not contain I/O, business logic, or adapter deps.
 * Invariants:
 * - ActivityEvent is purpose-neutral: no epoch, user, node, receipt, or payout fields.
 * - ObservationEvent is purpose-neutral: no node fields. Captures state measurements.
 * - Adapter-side type only — mapping to DB tables (which add node_id) is the workflow/store's job.
 * - payloadHash is PROVENANCE_REQUIRED (SHA-256 of canonical payload).
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md#source-adapter-interface
 * @public
 */

/**
 * Raw observation (state measurement) from an external source.
 * Purpose-neutral — consumed by the AI decision plane (triggers → analysis → signals).
 * The adapter produces these; the workflow/store maps them to DB rows with node_id, etc.
 *
 * Unlike ActivityEvent (discrete events), ObservationEvent captures continuous
 * state measurements: prices, latencies, conversion rates, etc.
 */
export interface ObservationEvent {
  /**
   * Deterministic from source data. Format: "{source}:obs:{entityId}:{timestamp}"
   * Examples: "polymarket:obs:polymarket:market:abc123:1711843200000"
   */
  readonly id: string;

  /** Source platform: "polymarket", "kalshi", "grafana", "posthog", etc. */
  readonly source: string;

  /** Stable subject key: "polymarket:market:abc123", "grafana:metric:cpu_usage" */
  readonly entityId: string;

  /** Human-readable label: "Fed cuts rates at June meeting?" */
  readonly entityTitle: string;

  /** Domain-specific category: "economics", "api-latency", "funnel" */
  readonly category: string;

  /** Domain-specific numeric fields: { probabilityBps: 6200, spreadBps: 100 } */
  readonly values: Record<string, number>;

  /** Non-numeric context, source pointers for deep investigation */
  readonly metadata: Record<string, unknown>;

  /** SHA-256 via hashCanonicalPayload() — same as ActivityEvent (PROVENANCE_REQUIRED) */
  readonly payloadHash: string;

  /** When the measurement was taken at the source */
  readonly observedAt: Date;
}

/**
 * Raw activity event from an external source.
 * Purpose-neutral — consumed by ledger (→ curation → allocations) and governance (→ metrics, alerts).
 * The adapter produces these; the workflow/store maps them to DB rows with node_id, etc.
 */
export interface ActivityEvent {
  /**
   * Deterministic from source data. Format: "{source}:{type}:{scope}:{identifier}"
   * Examples: "github:pr:owner/repo:42", "discord:message:guild:channel:msgId"
   */
  readonly id: string;

  /** Source platform: "github", "discord", etc. */
  readonly source: string;

  /** Event classification: "pr_merged", "review_submitted", "message_sent", "issue_closed" */
  readonly eventType: string;

  /** Stable platform actor ID (GitHub numeric user ID, Discord snowflake). Never changes. */
  readonly platformUserId: string;

  /** Display-only actor name (GitHub username, Discord handle). May change over time. */
  readonly platformLogin?: string;

  /** Canonical URL to the activity artifact */
  readonly artifactUrl: string;

  /** Source-specific payload. No domain-specific fields — raw provenance data only. */
  readonly metadata: Record<string, unknown>;

  /** SHA-256 of canonical payload fields (PROVENANCE_REQUIRED) */
  readonly payloadHash: string;

  /** When the activity occurred on the source platform */
  readonly eventTime: Date;
}

/** Definition of a collectible stream within a source adapter. */
export interface StreamDefinition {
  /** Stream identifier: "pull_requests", "reviews", "issues", "messages" */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** How the cursor advances: ISO timestamp or opaque pagination token */
  readonly cursorType: "timestamp" | "token";

  /** Default polling interval in seconds */
  readonly defaultPollInterval: number;
}

/** Cursor checkpoint for incremental sync. One per (source, stream, scope). */
export interface StreamCursor {
  /** Which stream this cursor belongs to */
  readonly streamId: string;

  /** Cursor value: ISO timestamp or opaque token */
  readonly value: string;

  /** When this cursor was last used to fetch data */
  readonly retrievedAt: Date;
}

/** Parameters for a collect() call. */
export interface CollectParams {
  /** Which streams to collect from */
  readonly streams: string[];

  /** Resume from this cursor (null = start from window.since) */
  readonly cursor: StreamCursor | null;

  /** Time window to collect within */
  readonly window: { readonly since: Date; readonly until: Date };

  /** Maximum events to return (adapter may return fewer) */
  readonly limit?: number;
}

/** Result of a collect() call. */
export interface CollectResult {
  /** Collected discrete events (may be empty if no new activity) */
  readonly events: readonly ActivityEvent[];

  /** Collected observations / state measurements (may be empty) */
  readonly observations?: readonly ObservationEvent[];

  /** Updated cursor for next incremental fetch */
  readonly nextCursor: StreamCursor;
}
