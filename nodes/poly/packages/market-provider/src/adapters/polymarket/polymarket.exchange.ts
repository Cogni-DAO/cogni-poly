// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/exchange`
 * Purpose: Polymarket CTF Exchange V2 + NegRisk Exchange V2 read surface on Polygon — pinned mainnet contract addresses + `OrderFilled` event ABI. Consumed by the chain-driven wallet-watch source (task.5043) to receive target-fill notifications in ~2s instead of the ~5min Data-API drain.
 * Scope: Constants + ABI fragments only. No client, no signer, no transaction submission. Sibling to `polymarket.ctf.ts` (which holds the ConditionalTokens redeem surface).
 * Invariants:
 *   - POLYGON_MAINNET_V2_ONLY — addresses pinned to chain id 137, V2 contracts only. Pre-V2 (collateral=USDC.e) addresses live in @polymarket/clob-client-v2's getContractConfig but are not exported here — new trade activity migrated to V2 on 2026-04-28 per `poly-tenant-and-collateral.md`.
 *   - ORDERFILLED_SHAPE_PINNED — `OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)` matches Polymarket's open-source CTFExchange + NegRiskCTFExchange contracts. Maker = order signer (proxy wallet), taker = counterparty. Both indexed; topic filters at the RPC layer match either-side participation.
 * Side-effects: none (pure constants + parseAbi)
 * Links: docs/spec/poly-tenant-and-collateral.md (V2 cutover), work/items/task.5043
 * @public
 */

import { parseAbi } from "viem";

/** Polymarket CTF Exchange V2 — regular (non-neg-risk) markets on Polygon. */
export const POLYGON_POLYMARKET_EXCHANGE_V2 =
  "0xE111180000d2663C0091e4f400237545B87B996B" as const;

/** Polymarket NegRisk CTF Exchange V2 — multi-outcome (event) markets on Polygon. */
export const POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2 =
  "0xe2222d279d744050d28e00520010520000310F59" as const;

/**
 * `OrderFilled` event — emitted by both V2 exchange contracts on every match.
 *
 * - `orderHash`: the matched order's EIP-712 hash (indexed)
 * - `maker`: address that signed the resting order (indexed) — target's proxy when target's resting order fills
 * - `taker`: address that crossed against the maker (indexed) — target's proxy when target market-buys/sells
 * - `makerAssetId` / `takerAssetId`: 0 for the collateral side, the CTF tokenId for the outcome side
 * - `makerAmountFilled` / `takerAmountFilled`: integer units (USDC has 6 decimals, CTF outcome tokens have 6 decimals)
 * - `fee`: protocol fee charged on the trade
 */
export const polymarketExchangeOrderFilledAbi = parseAbi([
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
]);
