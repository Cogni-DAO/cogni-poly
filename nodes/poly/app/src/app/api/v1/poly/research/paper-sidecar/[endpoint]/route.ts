// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/paper-sidecar/[endpoint]`
 * Purpose: HTTP GET — proxy three pm_trader pass-through endpoints on the
 *   poly-paper-sidecar (loopback-only) out through a session-authed Next.js
 *   route so Derek can observe paper-trade balance / portfolio / history
 *   from a browser or curl without kubectl-exec.
 * Scope: Pure transport — whitelist `balance | portfolio | history`, forward
 *   query params to the sidecar, return the JSON. No body parsing, no shape
 *   transformation. The sidecar already returns Loki-friendly JSON.
 * Invariants:
 *   - SIDECAR_GLOBAL_VIEW: the sidecar runs ONE pm_trader account across all
 *     paper tenants (per v0 architecture in proj.poly-paper-trading.md). This
 *     route exposes that single-account view. Per-tenant PnL still requires a
 *     cogni-side aggregator OR a multi-account sidecar refactor — neither
 *     ships here.
 *   - WHITELIST: only the three sidecar pass-through paths are accepted;
 *     any other [endpoint] returns 404 so the proxy can't be turned into a
 *     general fetcher against arbitrary sidecar surfaces.
 *   - AUTH: getSessionUser required. No admin-only gate yet — candidate-a is
 *     single-tenant-Derek; add an email/role gate when a second human gets
 *     credentials.
 *   - LOOPBACK_ONLY_SOURCE: PAPER_SIDECAR_URL defaults to localhost:9100;
 *     the sidecar is a sibling container in the same pod and is not
 *     externally reachable.
 * Side-effects: IO (one HTTP GET to the loopback sidecar).
 * Notes: Read-only. No mutation. The sidecar itself is the source of truth.
 * Links: nodes/poly/sidecars/paper-trader/server.py (the three endpoints
 *   this proxies), docs/spec/poly-paper-trading.md.
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env/server-env";

export const dynamic = "force-dynamic";

const ALLOWED_ENDPOINTS = new Set(["balance", "portfolio", "history"]);
const DEFAULT_SIDECAR_BASE_URL = "http://localhost:9100";
const PROXY_TIMEOUT_MS = 10_000;

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research.paper_sidecar",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");

    // Next.js 15: the dynamic segment is the last path component.
    const pathname = new URL(request.url).pathname;
    const endpoint = pathname.split("/").filter(Boolean).pop() ?? "";

    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      return NextResponse.json({ error: "unknown_endpoint" }, { status: 404 });
    }

    const env = serverEnv();
    const base = env.PAPER_SIDECAR_URL ?? DEFAULT_SIDECAR_BASE_URL;

    // Forward only the limit query param (the only one any of the three
    // sidecar endpoints accepts — `history?limit=N`). Avoids passing
    // through arbitrary client-controlled query strings.
    const { searchParams } = new URL(request.url);
    const upstreamUrl = new URL(`${base.replace(/\/$/, "")}/${endpoint}`);
    const limit = searchParams.get("limit");
    if (limit !== null) upstreamUrl.searchParams.set("limit", limit);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const resp = await fetch(upstreamUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      const bodyText = await resp.text();
      // Pass the sidecar's status code through so 400 (bad limit) /
      // 503 (sidecar down) surface clearly to the caller.
      return new NextResponse(bodyText, {
        status: resp.status,
        headers: {
          "content-type":
            resp.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: "sidecar_unreachable", detail: message },
        { status: 502 }
      );
    } finally {
      clearTimeout(timer);
    }
  }
);
