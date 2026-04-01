---
id: knowledge-data-plane-spec
type: spec
title: "Knowledge Data Plane — Versioned Expertise for Node-Template"
status: draft
spec_state: draft
trust: draft
summary: "Separates hot operational awareness (Postgres) from cold curated knowledge (versioned). The awareness plane owns what the AI sees and decides right now. The knowledge plane owns what the AI has learned — strategies, prompt versions, evaluations, evidence, playbooks. v0 uses Postgres behind a port abstraction; Dolt is the target backend when branching and fork inheritance are exercised."
read_when: Designing a knowledge store for a Cogni node, choosing where data lives (awareness vs knowledge), understanding the promotion boundary, or forking the node-template.
implements:
owner: derekg1729
created: 2026-03-31
verified:
tags: [knowledge, dolt, node-template, awareness, data-plane, cogni-template]
---

# Knowledge Data Plane — Versioned Expertise for Node-Template

> Awareness is what you see. Knowledge is what you've learned. Don't store them in the same place.

### Key References

|                      |                                                                             |                                               |
| -------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| **Awareness Plane**  | [monitoring-engine spec](./monitoring-engine.md)                            | ObservationEvent, triggers, signals, outcomes |
| **Prior Research**   | spike.0137 (branch `docs/spike-0137-knowledge-store`)                       | Three-layer knowledge architecture            |
| **Prior Design**     | proj.knowledge-store (branch `docs/spike-0137-knowledge-store`)             | Postgres-based entity/relation/observation    |
| **Market Provider**  | [market-provider AGENTS.md](../../packages/market-provider/AGENTS.md)       | Polymarket + Kalshi adapters                  |
| **Poly Project**     | [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) | First domain consuming both planes            |
| **Node vs Operator** | [node-operator-contract](./node-operator-contract.md)                       | Fork freedom, data sovereignty                |

## Goal

Enable Cogni nodes to accumulate domain expertise — strategies, prompt versions, evaluations, evidence — in a versioned knowledge store that is architecturally separate from the hot awareness pipeline. Adding a new domain's expertise requires only seed data; the schema is generic. The port abstraction enables a future migration from Postgres to Dolt when branching, fork inheritance, and cross-node sharing are needed.

## Design

### Problem

The monitoring-engine spec defines an awareness plane — observation events, trigger evaluation, AI analysis runs, scored signals, calibration outcomes. All of this is hot operational data: append-only, high-frequency, domain-specific, stored in Postgres.

But there's a second class of data that accumulates slower and has different lifecycle needs:

- **Strategies** — named decision approaches (e.g., "base-rate-anchored calibrated analyst")
- **Prompt versions** — the actual system prompts, versioned, diffable
- **Evaluations** — which strategy+prompt versions performed against what outcomes
- **Evidence references** — curated pointers to external research, papers, data sources
- **Playbooks** — operational runbooks ("if market shows X pattern, consider Y")
- **Knowledge claims** — curated assertions the system believes to be true, with provenance

This data is:

- **Mutable** — strategies evolve, prompts get refined, claims get corrected
- **Versioned** — you need to know what changed, when, and why
- **Forkable** — when a node forks the template, it should inherit the knowledge base
- **Experimental** — you want to branch, test a new prompt on a branch, eval it, merge if it works
- **Shareable** — validated knowledge can flow between nodes (operator → node, node → operator)

Postgres can serve this with append-only version rows, but it gets clumsy at scale — manual `version` columns, `valid_from`/`valid_to` ranges, and audit triggers recreate what a version-controlled database gives you natively. The target architecture uses Dolt for this layer, but the port abstraction means we start with Postgres and swap when the Dolt-specific features (branching, fork inheritance) are actually exercised.

---

## Design: Two Planes, Two Tempos

```
┌────────────────────────────────────────────────────────┐
│              AWARENESS PLANE (Postgres)                 │
│         "What the AI sees and decides right now"        │
│                                                        │
│  observation_events    (append-only measurements)      │
│  analysis_runs         (when/why AI was invoked)       │
│  analysis_signals      (AI conclusions + action level) │
│  analysis_outcomes     (ground truth for calibration)  │
│  base_rates            (live calibration frequencies)  │
│                                                        │
│  Tempo: seconds to minutes                             │
│  Mutability: append-only (immutable facts)             │
│  Owner: monitoring-engine awareness pipeline           │
└──────────────────────────┬─────────────────────────────┘
                           │
                    Promotion Gate
                    (reviewed, repeated, or outcome-backed)
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│         KNOWLEDGE PLANE (Postgres v0 → Dolt v1)        │
│         "What the AI has learned over time"             │
│                                                        │
│  strategies            (named decision approaches)     │
│  strategy_versions     (versioned strategy content)    │
│  strategy_evaluations  (eval results vs outcomes)      │
│  prompt_defs           (system prompt definitions)     │
│  prompt_versions       (versioned prompt content)      │
│  evidence_refs         (curated external pointers)     │
│  playbooks             (operational runbooks)          │
│  knowledge_claims      (curated assertions)            │
│                                                        │
│  Tempo: hours to days                                  │
│  Mutability: versioned (append version rows in v0;     │
│              branch/commit/merge/diff in v1 Dolt)      │
│  Owner: knowledge curation pipeline                    │
└────────────────────────────────────────────────────────┘
```

---

## Phased Implementation

The hexagonal architecture makes this a clean adapter swap. Consumers depend on `KnowledgeStorePort`, not on the storage backend. v0 ships value immediately on existing infrastructure; v1 adds Dolt when its unique capabilities are needed.

### v0 — Postgres (ships with task.0231)

- Knowledge tables in `packages/db-schema/knowledge/` (Drizzle, same patterns as existing slices)
- `packages/knowledge-store/` with `KnowledgeStorePort` + `DrizzleKnowledgeStoreAdapter`
- Versioning via append-only `strategy_versions` / `prompt_versions` rows with monotonic `version` column
- Reuses existing Postgres, Drizzle, db-client, testcontainer, migration tooling — zero new infrastructure
- `currentVersion()` returns latest version number (not a commit hash)

### v1 — Dolt (future task, when branching/forking is exercised)

- Add `dolt` service to docker-compose (MySQL-compatible)
- New `DoltKnowledgeStoreAdapter` implementing same port
- Migrate data from Postgres tables → Dolt
- Branching, diffing, time-travel, fork inheritance become available
- `currentVersion()` returns Dolt commit hash
- `diffVersions()` and `checkoutBranch()` added to port

### When to trigger v1

The concrete trigger for Dolt: **when any of these are actually needed:**

1. A second node forks and needs to inherit + share knowledge
2. Prompt experimentation needs branch-per-experiment (not just version rows)
3. Cross-node knowledge sharing is on the roadmap

Until then, Postgres version rows are simpler and sufficient.

---

## Why Dolt (Target Architecture)

Dolt is a SQL database with git semantics — branch, commit, diff, merge, clone, push, pull — on tables instead of files. It speaks MySQL-compatible SQL with additional system tables and functions for version control.

| Need                    | Postgres v0 workaround         | Dolt v1 native                                  |
| ----------------------- | ------------------------------ | ----------------------------------------------- |
| Version history         | Append-only version rows       | `dolt_log`, `dolt_diff()`, `AS OF` queries      |
| Branch to experiment    | Copy rows + flag column        | `CALL dolt_checkout('-b', 'experiment/foo')`    |
| Diff two versions       | Custom join on version columns | `SELECT * FROM dolt_diff('main', 'experiment')` |
| Merge validated changes | Manual row-level merge         | `CALL dolt_merge('experiment')`                 |
| Fork inheritance        | Drizzle seeds / pg_dump        | `dolt clone operator/knowledge-template`        |
| Cross-node sharing      | Manual export/import           | `dolt pull origin`, `dolt push`                 |
| Time-travel queries     | Query by version number        | `SELECT * FROM strategies AS OF 'HEAD~5'`       |
| Audit by default        | Version rows have `created_at` | Every commit has author + message + timestamp   |

**The key insight:** Awareness data is write-once (facts that happened). Knowledge data is write-many (expertise that evolves). These need fundamentally different storage semantics — but the port abstraction means we defer the infrastructure decision until the value justifies the cost.

### Relationship to Prior Work (spike.0137, proj.knowledge-store)

The spike.0137 research identified a three-layer architecture:

- **Layer 0** (raw archive) — `ingestion-core`, already exists
- **Layer 1** (claims/evidence) — extracted assertions with provenance
- **Layer 2** (canonical knowledge) — resolved entities, relations, observations

The proj.knowledge-store design placed all three layers in Postgres. This spec **refines that design** by:

1. Clarifying the awareness/knowledge boundary (which the prior design blurred)
2. Using a simpler schema for v0 (strategies/prompts/evaluations vs entities/relations/observations)
3. Targeting Dolt as the v1 backend for Layers 1–2 when versioning demands justify it

Layer 0 (raw archive) stays in Postgres permanently — it's append-only, high-frequency, and benefits from Postgres's ecosystem (TimescaleDB, RLS, existing migrations).

---

## The Split: Polymarket Intelligence vs Node-Template Knowledge

This is the critical architectural boundary. Getting it wrong means either:

- Poly-specific data leaks into the generic template (every fork inherits prediction market tables), or
- Generic capabilities get trapped in domain-specific code (other domains can't reuse strategy versioning)

### What stays in the Awareness Plane (Postgres, domain-specific)

The **Polymarket domain pack** owns all hot operational data. This lives in `db-schema/ingestion` (or `db-schema/poly` for domain tables) and follows the monitoring-engine spec:

| Data                          | Why it's awareness, not knowledge                |
| ----------------------------- | ------------------------------------------------ |
| Market price observations     | Raw measurements — append-only facts             |
| Volume/spread/depth snapshots | Raw measurements — append-only facts             |
| Trigger evaluations           | Ephemeral — not even persisted                   |
| Analysis runs                 | Operational — "AI was invoked at 14:32"          |
| Analysis signals              | Operational — "AI concluded X with Y confidence" |
| Market resolutions (outcomes) | Operational — ground truth for calibration       |
| Live base rates               | Operational — current calibration state          |
| Cross-platform spread alerts  | Operational — ephemeral trigger output           |

This data is **high-frequency, append-only, domain-specific**. It belongs in Postgres where the awareness pipeline already lives.

### What lives in the Knowledge Plane (node-template)

The **knowledge plane** owns curated expertise that accumulates and evolves. This is the generic capability that every node fork inherits:

| Data                   | Description                                           | Why it's knowledge, not awareness               |
| ---------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `strategies`           | Named decision approaches with metadata               | Evolves over time, needs version history        |
| `strategy_versions`    | Versioned content: prompt ref, parameters, thresholds | Iterated artifact, diff to compare              |
| `strategy_evaluations` | Eval results linking strategy versions to outcomes    | Accumulated evidence, informs future selection  |
| `prompt_defs`          | System prompt definitions with domain + purpose       | Shared across domains, versioned                |
| `prompt_versions`      | Actual prompt text, model params, temperature         | Most-iterated artifact — needs version tracking |
| `evidence_refs`        | Curated pointers to research, papers, data sources    | Slowly accumulated, annotated, shared           |
| `playbooks`            | Operational runbooks: "if X pattern, consider Y"      | Operational expertise, evolves with experience  |
| `knowledge_claims`     | Curated assertions with provenance + confidence       | Mutable (correctable), needs version history    |

This data is **low-frequency, mutable, domain-agnostic in structure**. Domains add domain-specific _content_ (a prediction market strategy vs an infra monitoring strategy) but the _schema_ is generic.

### Domain Extension Pattern

Domains don't add tables to the knowledge plane. They add **rows with domain-specific content**:

```sql
-- Generic schema, domain-specific content
INSERT INTO strategies (id, domain, name, description)
VALUES ('poly-calibrated-analyst', 'prediction-market',
        'Calibrated Market Analyst',
        'Base rate -> news update -> fair probability -> thesis');

INSERT INTO strategy_versions (strategy_id, version, prompt_ref, params)
VALUES ('poly-calibrated-analyst', 1, 'poly-synth-prompt',
        '{"triggerThresholdBps": 500, "confidenceFloor": 40}');

-- Same schema, different domain
INSERT INTO strategies (id, domain, name, description)
VALUES ('infra-anomaly-detector', 'infrastructure',
        'Anomaly Detector',
        'Baseline -> deviation -> root cause -> severity');
```

If a domain truly needs domain-specific columns, it adds a **companion table** (e.g., `poly_market_categories` for prediction market category taxonomy). But the core knowledge schema stays generic.

---

## Knowledge Schema

All types use Postgres-native types in v0. Column names are snake_case to match existing Drizzle conventions. The schema is backend-agnostic — these same tables map to Dolt when the adapter swaps.

### `strategies` — named decision approaches

| Column        | Type        | Constraints            | Description                                    |
| ------------- | ----------- | ---------------------- | ---------------------------------------------- |
| `id`          | text        | PK                     | Human-readable slug: `poly-calibrated-analyst` |
| `domain`      | text        | NOT NULL               | `prediction-market`, `infrastructure`, etc.    |
| `name`        | text        | NOT NULL               | Display name                                   |
| `description` | text        |                        | What this strategy does and when to use it     |
| `active`      | boolean     | NOT NULL, default true | Is this in rotation                            |
| `created_at`  | timestamptz | NOT NULL, default now  |                                                |

### `strategy_versions` — versioned strategy content

| Column        | Type        | Constraints               | Description                                       |
| ------------- | ----------- | ------------------------- | ------------------------------------------------- |
| `id`          | text        | PK                        | `{strategy_id}:v{n}`                              |
| `strategy_id` | text        | FK → strategies, NOT NULL |                                                   |
| `version`     | integer     | NOT NULL                  | Monotonic within strategy                         |
| `prompt_ref`  | text        |                           | FK → prompt_defs — which prompt this version uses |
| `params`      | jsonb       |                           | Domain-specific parameters (thresholds, weights)  |
| `notes`       | text        |                           | What changed and why                              |
| `created_at`  | timestamptz | NOT NULL, default now     |                                                   |

**Unique:** `(strategy_id, version)`

### `strategy_evaluations` — eval results

| Column              | Type         | Constraints                      | Description                     |
| ------------------- | ------------ | -------------------------------- | ------------------------------- |
| `id`                | text         | PK                               |                                 |
| `strategy_version`  | text         | FK → strategy_versions, NOT NULL |                                 |
| `eval_type`         | text         | NOT NULL                         | `backtest`, `live`, `manual`    |
| `sample_size`       | integer      | NOT NULL                         |                                 |
| `accuracy_pct`      | numeric(5,2) |                                  | 0–100                           |
| `calibration_error` | numeric(6,4) |                                  | Mean absolute calibration error |
| `edge_bps`          | integer      |                                  | Average edge in basis points    |
| `details`           | jsonb        |                                  | Full eval breakdown             |
| `evaluated_at`      | timestamptz  | NOT NULL                         |                                 |

### `prompt_defs` — system prompt definitions

| Column    | Type | Constraints | Description                          |
| --------- | ---- | ----------- | ------------------------------------ |
| `id`      | text | PK          | Human-readable slug                  |
| `domain`  | text | NOT NULL    |                                      |
| `purpose` | text | NOT NULL    | `synthesis`, `enrichment`, `scoring` |
| `name`    | text | NOT NULL    |                                      |

### `prompt_versions` — versioned prompt content

| Column        | Type         | Constraints                | Description                              |
| ------------- | ------------ | -------------------------- | ---------------------------------------- |
| `id`          | text         | PK                         | `{prompt_id}:v{n}`                       |
| `prompt_id`   | text         | FK → prompt_defs, NOT NULL |                                          |
| `version`     | integer      | NOT NULL                   | Monotonic within prompt                  |
| `system_text` | text         | NOT NULL                   | The actual system prompt                 |
| `model`       | text         |                            | Target model (for model-specific tuning) |
| `temperature` | numeric(3,2) |                            |                                          |
| `notes`       | text         |                            | What changed and why                     |
| `created_at`  | timestamptz  | NOT NULL, default now      |                                          |

**Unique:** `(prompt_id, version)`

### `evidence_refs` — curated external pointers

| Column        | Type        | Constraints           | Description                                 |
| ------------- | ----------- | --------------------- | ------------------------------------------- |
| `id`          | text        | PK                    |                                             |
| `domain`      | text        | NOT NULL              |                                             |
| `title`       | text        | NOT NULL              |                                             |
| `url`         | text        |                       |                                             |
| `source_type` | text        | NOT NULL              | `paper`, `dataset`, `api`, `news`, `expert` |
| `summary`     | text        |                       | Why this evidence matters                   |
| `tags`        | jsonb       |                       | Searchable tags                             |
| `added_at`    | timestamptz | NOT NULL, default now |                                             |

### `playbooks` — operational runbooks

| Column         | Type    | Constraints            | Description                |
| -------------- | ------- | ---------------------- | -------------------------- |
| `id`           | text    | PK                     |                            |
| `domain`       | text    | NOT NULL               |                            |
| `name`         | text    | NOT NULL               |                            |
| `trigger`      | text    | NOT NULL               | When this playbook applies |
| `steps`        | jsonb   | NOT NULL               | Ordered action steps       |
| `strategy_ref` | text    |                        | FK → strategies (optional) |
| `active`       | boolean | NOT NULL, default true |                            |

### `knowledge_claims` — curated assertions

| Column           | Type        | Constraints           | Description                                            |
| ---------------- | ----------- | --------------------- | ------------------------------------------------------ |
| `id`             | text        | PK                    |                                                        |
| `domain`         | text        | NOT NULL              |                                                        |
| `entity_id`      | text        | NOT NULL              | Stable subject key (same namespace as awareness plane) |
| `claim`          | text        | NOT NULL              | The assertion                                          |
| `confidence_pct` | integer     | NOT NULL              | 0–100                                                  |
| `source_type`    | text        | NOT NULL              | `analysis_signal`, `human`, `external`, `derived`      |
| `source_ref`     | text        |                       | Pointer to origin (signal ID, URL, etc.)               |
| `valid_from`     | timestamptz |                       |                                                        |
| `valid_until`    | timestamptz |                       |                                                        |
| `created_at`     | timestamptz | NOT NULL, default now |                                                        |

---

## Port Interface

```typescript
interface KnowledgeStorePort {
  // Read operations
  getStrategy(id: string): Promise<Strategy | null>;
  listStrategies(domain: string): Promise<Strategy[]>;
  getLatestStrategyVersion(strategyId: string): Promise<StrategyVersion | null>;
  getPromptVersion(
    promptId: string,
    version?: number
  ): Promise<PromptVersion | null>;
  getPlaybooks(domain: string): Promise<Playbook[]>;
  getEvidenceRefs(domain: string, tags?: string[]): Promise<EvidenceRef[]>;

  // Write operations
  createStrategy(strategy: NewStrategy): Promise<Strategy>;
  addStrategyVersion(version: NewStrategyVersion): Promise<StrategyVersion>;
  addPromptVersion(version: NewPromptVersion): Promise<PromptVersion>;
  recordEvaluation(eval: NewStrategyEvaluation): Promise<StrategyEvaluation>;
  addEvidenceRef(ref: NewEvidenceRef): Promise<EvidenceRef>;
  addKnowledgeClaim(claim: NewKnowledgeClaim): Promise<KnowledgeClaim>;

  // Version info (backend-dependent semantics)
  currentVersion(): Promise<string>;
}
```

**v0 adapter:** `DrizzleKnowledgeStoreAdapter` — uses `@cogni/db-client` against Postgres. `currentVersion()` returns a content hash or timestamp.

**v1 adapter:** `DoltKnowledgeStoreAdapter` — uses `mysql2` against Dolt server. `currentVersion()` returns Dolt commit hash. Adds `diffVersions()`, `checkoutBranch()`, `mergeBranch()` to extended interface.

---

## Promotion Gate: Awareness → Knowledge

Not every signal becomes knowledge. The promotion gate decides what crosses the boundary:

```
Awareness (Postgres)                    Knowledge (Postgres v0 / Dolt v1)
────────────────────                    ─────────────────────────────────

analysis_signal ──→ [promotion criteria] ──→ knowledge_claims
                                             evidence_refs

analysis_outcomes ─→ [calibration eval] ──→ strategy_evaluations

repeated pattern ──→ [codification] ────→ playbooks

prompt iteration ──→ [validated A/B] ───→ prompt_versions
```

### Promotion Criteria

An awareness artifact becomes knowledge when at least one holds:

| Criterion                     | Example                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| **Outcome-validated**         | Signal predicted correctly against resolved market               |
| **Statistically significant** | Strategy version outperforms baseline in N>30 evals              |
| **Human-reviewed**            | Operator marks a signal as high-quality insight                  |
| **Repeated pattern**          | Same trigger+analysis pattern fires >3 times with similar result |

### What does NOT get promoted

- Individual observations (raw data stays in awareness)
- Failed analysis runs (operational artifact, not knowledge)
- Low-confidence signals that weren't validated
- One-off alerts that didn't recur

---

## Knowledge Classes

All knowledge belongs to exactly one class. The class determines visibility, ownership, and how it moves between layers.

| Class             | Visibility       | Owner    | Mutability                  | Example                                                      |
| ----------------- | ---------------- | -------- | --------------------------- | ------------------------------------------------------------ |
| **Public/shared** | All nodes        | Operator | Operator writes, nodes read | Base strategies, reference prompts, evidence library         |
| **Node-private**  | Owning node only | Node     | Node writes freely          | Tuned prompts, local evaluations, domain-specific strategies |
| **Experimental**  | Owning node only | Node     | Branch, discard freely      | Prompt A/B tests, threshold experiments                      |

Knowledge moves **upward** by explicit promotion only:

```
experimental ──→ node-private    (node merges validated experiment)
node-private ──→ public/shared   (operator reviews + accepts node contribution)
```

Knowledge moves **downward** by explicit pull only:

```
public/shared ──→ node-private   (node pulls operator update into local store)
```

**No default visibility across nodes.** Monorepo code sharing does not imply knowledge sharing. A node's tuned prompts and evaluations are private unless explicitly promoted.

---

## Per-Node Knowledge Distribution

Each Cogni node has its own agent graphs package (domain logic) and its own knowledge store (domain expertise). The operator maintains base knowledge that new nodes inherit. This section designs how knowledge flows between operator and nodes across the lifecycle.

### Three-Layer Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  OPERATOR BASE KNOWLEDGE                                     │
│  Curated strategies, reference prompts, evidence library     │
│  Published as: @cogni/knowledge-seeds (v0) or Dolt remote   │
│  Class: public/shared                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ seed (v0) / pull (v1)
                           │ node decides when
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  NODE-LOCAL SOVEREIGN KNOWLEDGE (per-node, isolated)         │
│  Own Postgres DB (v0) / own Dolt database (v1)              │
│  Base (pulled from operator) + private tuned knowledge      │
│  Class: node-private (+ merged public/shared)                │
└──────────────────────────┬───────────────────────────────────┘
                           │ KnowledgeStorePort
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  GRAPH LAYER (per-node agent graphs)                         │
│  packages/langgraph-graphs/ reads from KnowledgeStorePort    │
│  Doesn't know or care about distribution mechanism           │
└──────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │  OPTIONAL: PUBLISHED COMMONS          │
                    │  Shared Dolt remote or DoltHub repo  │
                    │  Nodes explicitly promote into this  │
                    │  Class: public/shared                │
                    └──────────────────────────────────────┘
```

**Key separation:** The agent graphs package is **code** (the logic). The knowledge store is **data** (the expertise). The awareness plane is **operational data** (what's happening now). A node's graphs read strategies and prompts from its local knowledge store — they never import them as code constants.

### v0: Knowledge Seeds (Postgres, zero new infra)

The operator publishes a `@cogni/knowledge-seeds` package containing SQL seed files:

```
packages/knowledge-seeds/
  src/
    strategies/prediction-market.sql   ← base strategies for poly domain
    strategies/infrastructure.sql      ← base strategies for infra domain
    prompts/poly-synth.sql             ← system prompts for market analysis
    evidence/base-refs.sql             ← evidence library
    index.ts                           ← export seed paths for programmatic use
```

**At node provision** (`provisionNode` workflow):

1. Node's Postgres database is created (existing step — already per-node isolated)
2. Drizzle migrations create knowledge tables (from task.0231)
3. Seed step runs: `pnpm knowledge:seed` imports base strategies + prompts
4. Seeded rows are now node-private — the node owns them

**Upstream updates:**

- Operator bumps `@cogni/knowledge-seeds` version
- Node decides when to pull: `pnpm upgrade @cogni/knowledge-seeds && pnpm knowledge:seed --upsert`
- Seed script upserts new versions (existing rows untouched, new versions appended)
- `UPGRADE_AUTONOMY` preserved — node is never forced to update

**Node customization:**

- Node adds its own rows via `KnowledgeStorePort.addStrategyVersion()` etc.
- Custom strategies have `domain` matching the node's domain
- Custom prompts are tuned for the node's specific use case
- All node-written knowledge is **node-private** by default

### v1: Shared Dolt Server, Per-Node Databases

When the trigger conditions are met, knowledge migrates from Postgres to Dolt. One shared Dolt server operationally, but **per-node databases** — not branch-per-node, not one shared database.

**One server, per-node databases:**

```
┌─────────────────────────────────────────────────────────────┐
│ Shared Dolt Server (operational — one process, shared infra) │
│                                                             │
│  knowledge_base          ← operator base knowledge          │
│  (read-only for nodes)     upstream remote / seed source    │
│                                                             │
│  knowledge_poly          ← poly node's sovereign store      │
│    main                    production knowledge             │
│    └── experiment/         prompt experiments (node-only)   │
│        prompt-v4                                            │
│                                                             │
│  knowledge_infra         ← infra node's sovereign store     │
│    main                    production knowledge             │
│    └── experiment/         threshold experiments (node-only) │
│        lower-thresholds                                     │
│                                                             │
│  knowledge_commons       ← optional shared published repo   │
│    (nodes explicitly promote validated knowledge here)      │
└─────────────────────────────────────────────────────────────┘
```

**Why per-node databases, not branches?**

- **DATA_SOVEREIGNTY** — a node's database is its own. No other node can `USE` it without explicit access grants. Branch-per-node in a single database means any session can `dolt_checkout` any branch — sovereignty is advisory, not enforced.
- **KNOWLEDGE_SOVEREIGN_BY_DEFAULT** — isolation is the default, sharing is explicit. Per-node databases make this structural, not policy-based.
- **Self-hosted exit** — a node leaving the monorepo takes its Dolt database as a standalone repo. No branch extraction needed.
- **Operational simplicity** — one Dolt server process, multiple databases. Same pattern as Postgres (one server, `CREATE DATABASE knowledge_{node_short_id}`).

**At node provision** (`provisionNode` workflow, enhanced):

1. Node's Postgres database created (awareness plane — existing step)
2. Node's Dolt database created: `CREATE DATABASE knowledge_{node_short_id}`
3. Operator base knowledge seeded into node's database (SQL import from `knowledge_base` or Dolt remote)
4. `KnowledgeStorePort` adapter connects to `knowledge_{node_short_id}`

**Operator base as upstream remote:**

```sql
-- Node pulls base knowledge updates from operator
USE knowledge_poly;
CALL dolt_remote('add', 'operator', 'dolthub/cogni-dao/knowledge-base');
CALL dolt_pull('operator', 'main');
CALL dolt_merge('operator/main');
CALL dolt_commit('-m', 'pulled operator base knowledge update');
```

**Prompt experimentation** (branches within node's own database):

```sql
USE knowledge_poly;
CALL dolt_branch('experiment/prompt-v4', 'main');
CALL dolt_checkout('experiment/prompt-v4');
-- ... modify prompts, run evals ...
CALL dolt_checkout('main');
CALL dolt_merge('experiment/prompt-v4');
CALL dolt_commit('-m', 'prompt v4 merged — 12% calibration improvement');
```

**Publishing to commons** (explicit promotion, not default):

```sql
-- Node explicitly pushes validated knowledge to shared commons
USE knowledge_poly;
CALL dolt_remote('add', 'commons', 'dolthub/cogni-dao/knowledge-commons');
CALL dolt_push('commons', 'main');
-- Operator reviews before merging into knowledge_base
```

**Self-hosted node exit path:** Node takes `knowledge_{node_short_id}` as a standalone Dolt repo. `dolt backup` or `dolt clone` to local instance. Fork freedom preserved — the node's entire knowledge history comes with it.

### When to Trigger v1

The concrete trigger for Dolt migration — **all three must hold:**

1. **Multiple active nodes** — at least 2 nodes need to share/inherit knowledge
2. **Active prompt experimentation** — version rows aren't sufficient; need branch-per-experiment
3. **Proven v0 knowledge flow** — strategies and prompts are actually being read from the knowledge store (not hardcoded)

Until then, Postgres + knowledge-seeds is simpler and sufficient. The `KnowledgeStorePort` makes the swap transparent to consumers.

### Pinning Analysis to Knowledge State

Every analysis run in the awareness plane records which knowledge version it used:

```
analysis_runs.knowledge_version = "v7"        -- v0: version string
analysis_runs.knowledge_version = "abc123def"  -- v1: Dolt commit hash
```

This enables reproducibility: given the same observations + the same knowledge version, the analysis should produce the same signals.

---

## Invariants

### Core (all phases)

| Rule                            | Constraint                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWARENESS_HOT_KNOWLEDGE_COLD    | Live operational data (observations, runs, signals, outcomes) stays in Postgres awareness tables. Curated expertise (strategies, prompts, evaluations, evidence) lives in knowledge tables. |
| KNOWLEDGE_SOVEREIGN_BY_DEFAULT  | Node production knowledge is local and private by default. Cross-node sharing is explicit promotion, never default visibility. Monorepo code sharing does not imply knowledge sharing.      |
| PROMOTE_NOT_MIRROR              | Knowledge is promoted from awareness via explicit gate. Only artifacts that are reviewed, repeated, or outcome-backed cross the boundary. Never bulk-copy.                                  |
| PORT_BEFORE_BACKEND             | All knowledge access goes through `KnowledgeStorePort`. The adapter (Postgres or Dolt) is an implementation detail. Consumers never depend on the storage backend.                          |
| SCHEMA_GENERIC_CONTENT_SPECIFIC | The knowledge schema is domain-agnostic. Domain specificity lives in row content (`domain` column, `params` JSONB), not in table structure.                                                 |
| KNOWLEDGE_VERSION_PINNED        | Analysis runs should record their `knowledge_version`. Given same inputs + same knowledge state → same outputs.                                                                             |

### v1-only invariants (deferred until Dolt migration)

| Rule                     | Constraint                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| DOLT_PER_NODE_DATABASE   | Each node gets its own Dolt database (`knowledge_{node_short_id}`). Per-node databases, not branch-per-node in a shared DB. |
| DOLT_OWNS_VERSIONING     | All knowledge versioning uses Dolt branches/commits. No manual version columns.                                             |
| FORK_TAKES_KNOWLEDGE     | When a node leaves the monorepo (self-hosts), it takes its Dolt database as a standalone repo with full history.            |
| SHARING_IS_EXPLICIT_PUSH | Knowledge enters the commons only via explicit `dolt push` to a shared remote. Never by default cohabitation.               |

---

## Non-Goals

- Replacing Postgres for hot operational data (awareness plane stays where it is)
- Real-time knowledge updates during analysis (knowledge is read at analysis start, not mid-flight)
- Automatic promotion without any validation gate (human or statistical)
- Embedding/vector search in the knowledge plane (stays in Postgres with pgvector if needed)
- Dolt infrastructure in v0 (port abstraction defers this to v1)

## Open Questions

- [ ] Should `knowledge_claims` use the same `entity_id` namespace as `observation_events`? (Likely yes — same stable key, different storage)
- [ ] Should `analysis_runs.knowledge_version` be added in v0 or deferred?
- [ ] Should the promotion gate be a Temporal workflow or a simpler cron-based batch?
- [ ] Dolt driver maturity for Node.js (v1 concern) — mysql2 works, but `dolt_checkout` / `dolt_merge` session semantics need verification through the driver
- [ ] Dolt server resource footprint — acceptable alongside Postgres in shared cluster?
- [ ] Branch naming convention — `node/{name}` vs `node/{short_id}`? Must be stable across renames.

## Related

- [Monitoring Engine Spec](./monitoring-engine.md) — awareness plane (Postgres)
- [Architecture](./architecture.md) — hexagonal layering
- [Node vs Operator Contract](./node-operator-contract.md) — fork freedom, data sovereignty, upgrade autonomy
- [Node Launch Spec](./node-launch.md) — `provisionNode` workflow, per-node infrastructure
- [Node Formation Spec](./node-formation.md) — DAO creation, repo-spec output
- spike.0137 (branch) — knowledge store research
- proj.knowledge-store (branch) — prior Postgres-based design (refined here)
- [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) — first domain consuming both planes
- task.0233 (cogni-template) — node-template extraction design
