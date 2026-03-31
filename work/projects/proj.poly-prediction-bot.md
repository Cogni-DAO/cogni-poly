---
id: proj.poly-prediction-bot
type: project
primary_charter:
title: "Cogni Poly — Prediction Market Intelligence Bot"
state: Active
priority: 1
estimate: 5
summary: Build an autonomous prediction market bot that ingests live market data, generates AI-powered trading signals, and progressively moves toward paper trading and DAO-managed treasury growth.
outcome: A self-improving prediction market intelligence system — from read-only market access through autonomous analysis to simulated trading with tracked P&L.
assignees: derekg1729
created: 2026-03-31
updated: 2026-03-31
labels: [poly, prediction-markets, ai, langgraph, temporal]
---

# Cogni Poly — Prediction Market Intelligence Bot

## Goal

Build a prediction market bot that starts by reading and searching live markets (Polymarket, Kalshi), graduates to continuous autonomous scanning and signal generation with real edge, and ultimately runs paper trading simulations with DAO treasury accounting. Each phase delivers standalone user value: Crawl gives market access + search, Walk gives intelligence + alpha, Run gives simulated returns and the foundation for real money.

## Roadmap

### Crawl (P0) — Market Port

**Goal:** Live market data flowing through the system. Users can browse and search active markets across platforms. The landing page shows real data instead of mocks.

| Deliverable                                                              | Status      | Est | Work Item              |
| ------------------------------------------------------------------------ | ----------- | --- | ---------------------- |
| Backend research + API integration plan                                  | In Progress | 3   | task.0226              |
| MVP agent workflows + data stream design                                 | In Progress | 5   | task.0227              |
| `poly-core` package — Zod schemas, normalizers, threshold math           | Not Started | 2   | (create at impl start) |
| `db-schema/poly` — market tables + TimescaleDB snapshots                 | Not Started | 2   | (create at impl start) |
| Polymarket data adapter (REST polling, market normalization)             | Not Started | 3   | (create at impl start) |
| Kalshi data adapter (REST polling, market normalization)                 | Not Started | 2   | (create at impl start) |
| Market search API — browse, filter, full-text search over active markets | Not Started | 2   | (create at impl start) |
| Landing page wired to live data (replace mocks)                          | Not Started | 2   | (create at impl start) |

### Walk (P1) — Intelligence Engine

**Goal:** Continuous autonomous scanning with threshold-triggered AI analysis. Users receive signals with real edge. Street intel workflow turns user observations into market-matched alpha. The system builds expertise through calibration.

| Deliverable                                                          | Status      | Est | Work Item            |
| -------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Temporal data stream workflow (poll → snapshot → trigger)            | Not Started | 3   | (create at P1 start) |
| `poly-synth` LangGraph reasoning graph                               | Not Started | 3   | (create at P1 start) |
| Temporal analysis run workflow (context → LLM → score → persist)     | Not Started | 3   | (create at P1 start) |
| Public signals API + brain status endpoint                           | Not Started | 2   | (create at P1 start) |
| Semantic search spike — observation-to-market matching approach      | Not Started | 2   | spike.0229           |
| Street intel workflow — user observations matched to live markets    | Not Started | 3   | story.0228           |
| Calibration loop — outcomes → base rate updates → improving accuracy | Not Started | 3   | (create at P1 start) |
| Enrichment sources — GDELT news, Metaculus expert forecasts          | Not Started | 2   | (create at P1 start) |

### Run (P2+) — Paper Trading & Treasury

**Goal:** Simulated trading with full position tracking and P&L accounting. DAO treasury grows on paper. "Follow a wallet" lets users shadow successful traders. System proves edge before real money.

| Deliverable                                                                | Status      | Est | Work Item            |
| -------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Paper trading engine — simulated order execution against live odds         | Not Started | 4   | (create at P2 start) |
| Position tracking + P&L ledger (integrated with `@cogni/financial-ledger`) | Not Started | 3   | (create at P2 start) |
| Balance sheet dashboard — portfolio view, historical returns, Sharpe ratio | Not Started | 3   | (create at P2 start) |
| Follow-a-wallet — track and mirror top Polymarket wallets                  | Not Started | 3   | (create at P2 start) |
| Strategy backtesting — replay historical signals against resolved markets  | Not Started | 3   | (create at P2 start) |
| DAO governance integration — community votes on risk parameters, strategy  | Not Started | 2   | (create at P2 start) |
| Human-in-the-loop approval flow — signal → approve → execute               | Not Started | 3   | (create at P2 start) |

## Constraints

- No real money in Crawl or Walk — paper trading only until edge is proven with statistical significance
- All prediction market operations must be audit-logged for DAO transparency
- Must work without Temporal in local dev (adapters callable standalone for testing)
- Polymarket adapter must handle CLOB API (not just AMM) — that's where the liquidity is
- LLM reasoning stays in LangGraph, I/O stays in Temporal — never mix (per temporal-patterns-spec)
- Rate limits respected per platform — backoff built into adapters, not callers
- US regulatory constraints acknowledged — no execution features for US users until legal review

## Dependencies

- [x] Landing page (`apps/poly`) — merged in PR #12
- [ ] `packages/monitor-core` — generic monitoring backbone (Part A of task.0227)
- [ ] `packages/db-schema/monitor` — generic tables (Part A of task.0227)
- [ ] Temporal infrastructure in dev/preview environments
- [ ] TimescaleDB extension available in Postgres
- [ ] Polymarket API access (CLOB API key)
- [ ] Kalshi API access (API key)

## As-Built Specs

- (none yet — specs created when code merges)

## Design Notes

- **Generic engine + domain pack split** (task.0227 v4): The monitoring backbone (`monitor-core`, `db-schema/monitor`, generic workflows) lives in cogni-template and is reusable across any Cogni node. The Polymarket-specific logic (`poly-core`, adapters, `poly-synth` graph) is additive on top. This means another node could build a Grafana monitor or social media monitor using the same backbone.

- **Semantic search for street intel** (spike.0229): The hardest open question. Connecting "warehouse fire" to "CPI market" requires multi-hop reasoning. Spike will benchmark embeddings vs LLM-as-judge vs hybrid. This gates the Walk phase street intel deliverable.

- **Follow-a-wallet** (Run phase): Polymarket transactions are on-chain (Polygon). Can index top wallets' positions and backtest their strategies. Potential signal source: if a known-profitable wallet takes a large position, that's a trigger. Needs separate research spike when P2 starts.

- **Edge-first philosophy**: The bot doesn't just surface markets — it must demonstrate real edge. Calibration loop (outcomes → base rate updates) is critical to Walk. Paper trading in Run proves edge with tracked P&L before any DAO treasury commitment.
