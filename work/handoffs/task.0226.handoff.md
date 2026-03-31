---
id: task.0226.handoff
type: handoff
work_item_id: task.0226
status: active
created: 2026-03-30
updated: 2026-03-30
branch: staging
last_commit: 5f99d8b8
---

# Handoff: Cogni Poly — Backend Research & Integration

## Context

- **Cogni Poly** is a community-built AI prediction market bot that researches, monitors, and signals across Polymarket, Kalshi, and more — with human-in-the-loop bet approvals
- The **landing page** (`apps/poly`) is merged to staging (PR #12) with mock data throughout: market cards, brain activity feed, agent streaming terminal
- This task is to **replace the mocks with real backend**: API integrations, a langgraph "brain" that runs on a schedule, and public endpoints that feed the landing page
- The product framing is "community intelligence" — the bot researches and signals, users approve or skip. It is NOT a trading fund or coordinated betting platform
- The full requirements are in `work/items/task.0226.poly-bot-backend-design.md`

## Current State

- Landing page is live with simulated data in `BrainFeed.tsx`, `MarketCards.tsx`, and `AgentStream.tsx`
- No backend code exists yet — this is greenfield
- No API keys or accounts for Polymarket/Kalshi yet
- Existing infra to reuse: `@cogni/langgraph-graphs`, `@cogni/scheduler-core`, `@cogni/ingestion-core`, Temporal workflows, Redis Streams → SSE pattern
- The `apps/poly` app is standalone Next.js (port 3100), independent from `apps/web`

## Decisions Made

- **Framing**: community-intelligence bot, not a trading fund. See hero/content copy in `apps/poly/src/components/`
- **Architecture**: reuse existing langgraph + Temporal + Redis infra rather than building new — see task.0226 §6 (Langgraph Brain Heartbeat Loop)
- **Zod-shaped output**: the langgraph graph must produce structured `MarketSignal[]` output matching the shapes already mocked in `BrainFeed.tsx` (lines 10-25) and `MarketCards.tsx` (lines 10-30)
- **Public endpoints**: `/api/v1/poly/brain/status` and `/api/v1/poly/brain/signals` — no auth required, public-facing heartbeat
- **Platform priority**: Polymarket + Kalshi first (live), Manifold + Metaculus later (read-only signal sources)

## Next Actions

- [ ] Research Polymarket API: REST/WS endpoints, auth (wallet signing), rate limits, CLOB mechanics
- [ ] Research Kalshi API: REST endpoints, auth (API key/OAuth), regulated restrictions, position limits
- [ ] Define Zod schemas: `MarketSignal`, `BrainStatus`, `BrainHeartbeatOutput` in a contracts file
- [ ] Build langgraph graph that fetches + normalizes market data from at least one platform
- [ ] Wire graph to Temporal cron schedule for continuous heartbeat loop
- [ ] Create public API routes (`/api/v1/poly/brain/status`, `/brain/signals`) serving real data
- [ ] Replace mock data in `BrainFeed.tsx` and `MarketCards.tsx` with API calls to the new endpoints
- [ ] Wire `AgentStream.tsx` to real SSE stream (stretch — Redis Streams pattern exists in `apps/web`)

## Risks / Gotchas

- Polymarket auth requires wallet signing (crypto), not simple API keys — research carefully before committing to an approach
- Kalshi is CFTC-regulated with US-only restrictions and position limits — legal implications for community-pooled participation
- The landing page (`apps/poly`) is a separate Next.js app — if backend routes need to live in `apps/web`, you'll need a cross-app API call pattern or shared service
- The existing `@cogni/langgraph-graphs` package has its own build step (`pnpm packages:build`) — any new graph must be registered in its catalog
- CI for this repo has pre-existing failures (stack-test GHCR access, sonar token) — static/unit/component checks pass fine

## Pointers

| File / Resource                                           | Why it matters                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `work/items/task.0226.poly-bot-backend-design.md`         | Full requirements: 7 design areas, research questions, deliverables, validation criteria                       |
| `apps/poly/src/components/BrainFeed.tsx`                  | Mock `MarketSignal` and `BrainStatus` types (lines 10-40) — your Zod schemas should match these shapes         |
| `apps/poly/src/components/MarketCards.tsx`                | Mock market data with `Market` and `MarketOutcome` types (lines 10-35) — normalize real API data to this shape |
| `apps/poly/src/components/AgentStream.tsx`                | Simulated agent streaming sequences — will connect to real SSE                                                 |
| `packages/langgraph-graphs/src/`                          | Existing graph catalog, runtime, and inproc execution — add new poly brain graph here                          |
| `packages/scheduler-core/`                                | Temporal workflow scheduling — use for cron heartbeat loop                                                     |
| `apps/web/src/app/api/v1/ai/runs/[runId]/stream/route.ts` | Existing SSE streaming pattern (Redis Streams → client) — reuse for brain activity stream                      |
| `packages/ingestion-core/`                                | Existing data ingestion patterns — reuse for market data normalization                                         |
| `apps/web/src/contracts/`                                 | Convention for Zod contract files — follow same pattern for poly contracts                                     |
