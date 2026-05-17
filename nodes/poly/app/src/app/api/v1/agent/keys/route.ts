// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/keys/route`
 * Purpose: Mint a Cogni-poly agent bearer for the calling session user — the human self-serve path that pairs with `/api/v1/agent/register` (which onboards NEW users).
 *   The returned key is shown once in the UI and never persisted server-side.
 * Scope: POST only; does not list, name, persist, or revoke keys. Session-cookie auth ONLY — Bearer is rejected with 403.
 * Invariants: HUMAN_ONLY_MINT — `Authorization: Bearer` header rejected;
 *   SESSION_USER_ID_IS_KEY_SUB — JWT `sub` derives from `getServerSessionUser()` only;
 *   MINTED_KEY_NEVER_PERSISTED — server returns the JWT once, no DB write, Loki captures `{userId, displayName, issuedAt}` only.
 * Side-effects: IO (NextAuth session read; HMAC sign via serverEnv.AUTH_SECRET).
 * Links: nodes/poly/packages/node-contracts/src/poly.user-credentials.v1.contract.ts · docs/spec/security-auth.md
 * @public
 */

import { polyAgentKeysCreateOperation } from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.keys.create",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");

    // HUMAN_ONLY_MINT: even if the wrapper accepted a bearer via some
    // future refactor, this route must never mint a key for a Bearer-
    // authenticated caller. Session cookie is the only acceptable path.
    if (
      request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
    ) {
      logComplete(ctx, {
        startedAt,
        status: 403,
        outcome: "error",
        errorCode: "session_required",
      });
      return NextResponse.json(
        {
          error: "session_required",
          message:
            "Key minting requires a browser session cookie. Bearer authentication is not accepted on this endpoint.",
        },
        { status: 403 }
      );
    }

    // Body is empty by contract; parse to enforce no smuggled fields.
    try {
      const body = await request.json().catch(() => ({}));
      const parsed = polyAgentKeysCreateOperation.input.safeParse(body);
      if (!parsed.success) {
        logComplete(ctx, {
          startedAt,
          status: 400,
          outcome: "error",
          errorCode: "invalid_body",
        });
        return NextResponse.json(
          { error: "invalid_body", message: parsed.error.message },
          { status: 400 }
        );
      }
    } catch {
      logComplete(ctx, {
        startedAt,
        status: 400,
        outcome: "error",
        errorCode: "invalid_body",
      });
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const apiKey = issueAgentApiKey({
      userId: sessionUser.id,
      displayName: sessionUser.displayName ?? null,
    });
    const issuedAt = new Date().toISOString();

    logComplete(ctx, {
      startedAt,
      status: 201,
      outcome: "success",
      userId: sessionUser.id,
    });

    return NextResponse.json(
      polyAgentKeysCreateOperation.output.parse({
        apiKey,
        userId: sessionUser.id,
        displayName: sessionUser.displayName ?? null,
        issuedAt,
      }),
      { status: 201 }
    );
  }
);

function logComplete(
  ctx: RequestContext,
  fields: {
    startedAt: number;
    status: number;
    outcome: "success" | "error";
    userId?: string;
    errorCode?: string;
  }
): void {
  logEvent(ctx.log, EVENT_NAMES.POLY_AGENT_KEYS_MINTED, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: fields.status,
    durationMs: Math.round(performance.now() - fields.startedAt),
    outcome: fields.outcome,
    ...(fields.userId ? { userId: fields.userId } : {}),
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
  });
}
