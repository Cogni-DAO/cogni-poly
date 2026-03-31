---
id: spike.0229
type: spike
title: "Spike: semantic search over live prediction markets for observation matching"
status: needs_triage
priority: 1
rank: 99
estimate: 2
summary: Research how to match a user's natural-language observation against 1000+ active prediction markets, including indirect/multi-hop connections.
outcome: Decision doc recommending semantic search approach (embeddings, LLM-as-judge, hybrid), with latency benchmarks and architecture fit for poly-core.
spec_refs:
  - task.0227
assignees: derekg1729
credit:
project:
branch:
pr:
reviewer:
revision: 0
blocked_by:
deploy_verified: false
created: 2026-03-30
updated: 2026-03-30
labels: [poly, prediction-markets, ai, research, embeddings]
external_refs:
---

# Spike: Semantic Search Over Live Prediction Markets

## Context

story.0228 (Street Intel workflow) requires matching a user's free-text observation against the full set of active prediction markets. The hard part: many valuable connections are indirect. "Warehouse fire at Port of LA" is relevant to "US CPI above 3.5% in Q2" via supply chain disruption, but no keyword or simple embedding similarity will catch that.

This spike answers the design questions that block implementation.

## Research Questions

1. **Embedding approach**: Can we pre-compute embeddings for market questions + descriptions and use cosine similarity to find the top-N candidates? What embedding model (OpenAI `text-embedding-3-large`, Cohere, open-source)? What recall do we get on indirect connections?

2. **LLM-as-judge**: For the top-N candidates from embedding search, can an LLM reliably determine which markets are actually affected by the observation? What's the false positive rate? Can it handle multi-hop reasoning (event → consequence → market)?

3. **Hybrid pipeline**: Is a two-stage pipeline (fast embedding retrieval → LLM reranking/filtering) the right architecture? Or should the LLM see all markets (cost/latency prohibitive at 1000+)?

4. **Latency budget**: What's achievable for each approach? User expectation is <10s for results. Embedding search is fast; LLM reranking over 50 candidates adds how much?

5. **Vector storage**: pgvector in existing Postgres? Dedicated vector DB? In-memory for MVP (market count is small enough)?

6. **Update cadence**: How often do we re-embed the market corpus? On every poll cycle? Only when new markets appear?

## Requirements

- Benchmark at least 2 approaches on a test set of 10 observations x 100 markets
- Measure: recall (did we find the indirect connection?), precision (how many false positives?), latency
- Recommend architecture that fits within poly-core + Temporal workflow boundaries
- Identify any new infrastructure dependencies (vector DB, embedding API)

## Allowed Changes

- `work/items/` — this spike and decision doc
- Scratch code in a local notebook or script (not committed)

## Plan

- [ ] Curate test set: 10 real-world observations with known market connections (including indirect ones)
- [ ] Benchmark embedding similarity (top-50 retrieval) against test set
- [ ] Benchmark LLM-as-judge reranking on embedding candidates
- [ ] Benchmark end-to-end hybrid pipeline latency
- [ ] Write decision doc with recommendation

## Validation

**Command:**

```bash
# Spike produces a decision doc, not code
ls work/items/spike.0229.*.md
```

**Expected:** Decision doc exists with benchmarks and architecture recommendation.

## Review Checklist

- [ ] **Work Item:** `spike.0229` linked in PR body
- [ ] **Spec:** all invariants of linked specs (here, or project) are upheld
- [ ] **Tests:** new/updated tests cover the change
- [ ] **Reviewer:** assigned and approved

## PR / Links

- Parent story: [story.0228](story.0228.poly-street-intel-workflow.md)
- MVP workflows: [task.0227](task.0227.poly-mvp-agent-workflows-and-taps.md)

## Attribution

- derekg1729 — research scoping
