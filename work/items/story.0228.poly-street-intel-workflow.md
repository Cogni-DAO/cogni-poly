---
id: story.0228
type: story
title: "Poly Street Intel — user-reported events matched to live prediction markets"
status: done
priority: 1
rank: 99
estimate: 3
summary: Let users report real-world observations to Cogni, which cross-references them against active Polymarket markets to surface exploitable informational edges.
outcome: A user can describe something they witnessed, and Cogni returns a ranked list of live markets where that observation creates a thesis with an edge over current odds.
spec_refs:
  - task.0226
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
labels: [poly, prediction-markets, ai, user-input, langgraph]
external_refs:
---

# Poly Street Intel — User-Reported Events Matched to Live Markets

## Problem

The current Poly bot design (task.0227) is autonomous: it polls market data, detects threshold triggers, and runs analysis on its own schedule. But some of the highest-alpha signals come from humans who witness events before they hit the news cycle — a warehouse fire, a politician's gaffe, a product launch gone wrong, an unexpected crowd at a rally.

There is no way for a user to inject a real-world observation into the system and ask: "does this give me an edge on any live bet?"

## Who Benefits

- **Active bettors** who see things in real life or on social media before prices move
- **Casual users** who don't track prediction markets but notice something newsworthy — Cogni turns their observation into actionable intelligence
- **The Cogni community** — aggregating street-level reports creates a proprietary signal source that no pure-data bot can replicate

## What Success Looks Like

1. User submits a natural-language observation (e.g. "I just saw National Guard trucks heading toward the southern border in Tucson")
2. Cogni searches active markets across platforms (Polymarket initially, Kalshi later) for any where the observation is materially relevant
3. For each matched market, Cogni returns:
   - The market question and current odds
   - A thesis explaining why the user's observation creates an informational edge
   - A confidence/edge score (how much the observation should move the probability)
   - Suggested direction (buy YES / buy NO)
4. Results are ranked by estimated edge magnitude
5. If no markets match, Cogni says so honestly — no hallucinated connections

## Requirements

- Natural-language input endpoint (text, possibly voice-to-text later)
- Semantic search over active market corpus — must handle fuzzy/indirect connections (e.g., "warehouse fire at port" matches "US CPI above X%" via supply chain reasoning)
- LLM reasoning step that evaluates whether the observation actually creates an edge (not just topical relevance)
- Edge scoring: estimate how much the observation should shift probability vs. current market odds
- Structured output matching the existing `MarketSignal` Zod schema from poly-core
- Rate limiting / abuse prevention (no spam, no market manipulation signals)

## Allowed Changes

- `packages/poly-core/` — new schemas for user observations, edge analysis requests/responses
- `packages/langgraph-graphs/graphs/poly-synth/` — new graph variant or extended prompt for observation-triggered analysis
- `packages/temporal-workflows/` — new workflow for user-triggered brain runs (vs. threshold-triggered)
- `apps/poly/` — input UI and results display
- `packages/db-schema/poly` — table for user observations and matched signals

## Plan

- [ ] Define Zod schemas: `UserObservation`, `EdgeAnalysisRequest`, `EdgeAnalysisResponse`
- [ ] Design semantic search strategy over active market corpus (embedding-based vs. LLM classification)
- [ ] Build observation-triggered Temporal workflow (parallels `PolyBrainRunWorkflow` but user-initiated)
- [ ] Extend or create LangGraph reasoning graph for observation-to-edge analysis
- [ ] Build input endpoint and results API
- [ ] Build UI for observation submission and edge results display
- [ ] Add abuse prevention (rate limits, content filtering)

## Design Questions (spike candidate)

- **Semantic search approach**: Embedding similarity over market descriptions? LLM-as-judge for relevance? Hybrid? This is the hardest technical question — the connection between "warehouse fire" and "CPI market" requires multi-hop reasoning, not keyword matching.
- **Latency target**: User expects near-real-time response. Can we search 1000+ active markets in <10s? May need pre-computed embeddings + vector index.
- **Deduplication**: If 50 users report the same event, how do we avoid redundant brain runs? Temporal workflowId idempotency (same pattern as task.0227) keyed on event hash?
- **Trust scoring**: Should repeated accurate reporters get higher signal weight over time?

## Validation

**Command:**

```bash
# Unit: edge scoring and schema validation
pnpm test packages/poly-core/

# Integration: observation → market matching → edge analysis pipeline
pnpm dotenv -e .env.test -- vitest run --config vitest.stack.config.mts src/__tests__/poly-street-intel
```

**Expected:** User observation produces ranked market matches with valid `MarketSignal` output. Zero matches returns empty array, not hallucinated connections.

## Review Checklist

- [ ] **Work Item:** `story.0228` linked in PR body
- [ ] **Spec:** all invariants of linked specs (here, or project) are upheld
- [ ] **Tests:** new/updated tests cover the change
- [ ] **Reviewer:** assigned and approved

## PR / Links

- Parent design: [task.0226](task.0226.poly-bot-backend-design.md)
- MVP workflows: [task.0227](task.0227.poly-mvp-agent-workflows-and-taps.md)

## Attribution

- derekg1729 — idea and product spec
