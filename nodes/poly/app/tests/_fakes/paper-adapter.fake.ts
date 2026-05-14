// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/_fakes/paper-adapter.fake`
 * Purpose: In-memory `MarketProviderPort` fake for the paper-trading sidecar. Lets app
 *   tests exercise the executor dispatcher + mirror pipeline against paper-mode intents
 *   without spawning a Python sidecar or hitting localhost.
 * Scope: Test-only. Mirrors the surface of `@cogni/poly-market-provider/adapters/paper`
 *   but stores open orders in a Map and returns canned receipts. `getMarketConstraints`
 *   and `listMarkets` delegate to an injected `readSource` exactly like the real adapter,
 *   so paper-mode tests still exercise the live tick + min-size code path.
 * Invariants:
 *   - FAKE_RETURNS_FILLED_SIZE_USDC — `placeOrder` defaults `filled_size_usdc` to the
 *     intent's `size_usdc` so tests exercise CAP_COUNTS_REALIZED_ON_CANCEL accounting.
 *     Override via `nextPlaceReceipt(...)` for partial-fill / pending scenarios.
 *   - FAKE_GETORDER_NEVER_NULL — same discriminated-union semantics as the real adapter.
 * Side-effects: none (in-memory only).
 * Links: nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts,
 *   work/projects/proj.poly-paper-trading.md
 * @internal
 */

import type {
  GetOrderResult,
  ListMarketsParams,
  MarketConstraints,
  MarketProvider,
  MarketProviderPort,
  NormalizedMarket,
  OrderIntent,
  OrderReceipt,
} from "@cogni/poly-market-provider";

export interface FakePaperAdapterOptions {
  /**
   * Optional live read source for `getMarketConstraints` + `listMarkets` —
   * mirrors `PaperAdapter`'s real-tick/real-min-size delegation. Most tests
   * supply a fake here too.
   */
  readSource?: MarketProviderPort;
  /** Override the provider identity (defaults to "polymarket"). */
  providerIdentity?: MarketProvider;
}

/**
 * In-memory paper-adapter fake. Acts as both `PaperAdapter` (for the
 * executor wiring) and a test harness — `nextPlaceReceipt` / `markFilled` /
 * placed-order inspection lets specs drive specific scenarios.
 */
export class FakePaperAdapter implements MarketProviderPort {
  readonly provider: MarketProvider;
  readonly placed: OrderReceipt[] = [];
  readonly canceled: string[] = [];

  private nextReceipt: Partial<OrderReceipt> | null = null;
  private readonly orders = new Map<string, OrderReceipt>();
  private readonly readSource?: MarketProviderPort;
  private orderCounter = 0;

  constructor(opts: FakePaperAdapterOptions = {}) {
    this.provider = opts.providerIdentity ?? "polymarket";
    this.readSource = opts.readSource;
  }

  /**
   * Queue the next `placeOrder` to return a specific shape (e.g. `pending`,
   * partial fill). One-shot — cleared after the next call.
   */
  nextPlaceReceipt(overrides: Partial<OrderReceipt>): void {
    this.nextReceipt = overrides;
  }

  /** Force-update an existing order's status (simulates sidecar fill detection). */
  markFilled(orderId: string, filledSizeUsdc: number): void {
    const existing = this.orders.get(orderId);
    if (!existing) throw new Error(`fake paper: unknown order_id=${orderId}`);
    const updated: OrderReceipt = {
      ...existing,
      status: "filled",
      filled_size_usdc: filledSizeUsdc,
    };
    this.orders.set(orderId, updated);
  }

  listMarkets(params?: ListMarketsParams): Promise<NormalizedMarket[]> {
    if (!this.readSource) return Promise.resolve([]);
    return this.readSource.listMarkets(params);
  }

  async placeOrder(intent: OrderIntent): Promise<OrderReceipt> {
    this.orderCounter += 1;
    const receipt: OrderReceipt = {
      order_id: `paper-${this.orderCounter}`,
      client_order_id: intent.client_order_id,
      status: this.nextReceipt?.status ?? "filled",
      // FAKE_RETURNS_FILLED_SIZE_USDC — match the real sidecar's contract;
      // override via nextPlaceReceipt for partial / pending scenarios.
      filled_size_usdc: this.nextReceipt?.filled_size_usdc ?? intent.size_usdc,
      submitted_at: this.nextReceipt?.submitted_at ?? new Date().toISOString(),
      attributes: {
        ...(intent.attributes ?? {}),
        ...(this.nextReceipt?.attributes ?? {}),
        paper_fake: true,
      },
    };
    this.nextReceipt = null;
    this.orders.set(receipt.order_id, receipt);
    this.placed.push(receipt);
    return receipt;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.canceled.push(orderId);
    this.orders.delete(orderId);
  }

  async getMarketConstraints(tokenId: string): Promise<MarketConstraints> {
    if (this.readSource) return this.readSource.getMarketConstraints(tokenId);
    return { minShares: 5, tickSize: 0.01, minUsdcNotional: 1 };
  }

  async getOrder(orderId: string): Promise<GetOrderResult> {
    const found = this.orders.get(orderId);
    if (!found) return { status: "not_found" };
    return { found };
  }
}
