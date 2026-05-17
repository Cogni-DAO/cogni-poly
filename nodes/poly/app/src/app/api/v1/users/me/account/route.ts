// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/users/me/account/route`
 * Purpose: Return the calling user's userId + billingAccountId + displayName for self-onboarding scripts and the Profile UI.
 *   Closes the "I'm a logged-in human; what's my tenant id?" gap that previously
 *   forced a DB poke or an admin in the loop.
 * Scope: GET only; does not list other users' accounts, accept a `userId` parameter, or write any row.
 *   Accepts session cookie OR bearer — both resolve to own-account only.
 * Invariants: OWN_ACCOUNT_ONLY — billing_account_id is resolved from the resolved
 *   sessionUser's id via `accountsForUser(userId).getOrCreateBillingAccountForUser`;
 *   no external userId is accepted.
 * Side-effects: IO (DB read via AccountService; may create a billing_account row on first call).
 * Links: nodes/poly/packages/node-contracts/src/poly.user-credentials.v1.contract.ts
 * @public
 */

import type { UserId } from "@cogni/ids";
import { polyUsersMeAccountOperation } from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "users.me.account",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");

    try {
      const container = getContainer();
      const account = await container
        .accountsForUser(sessionUser.id as UserId)
        .getOrCreateBillingAccountForUser({ userId: sessionUser.id });

      const response = polyUsersMeAccountOperation.output.parse({
        userId: sessionUser.id,
        billingAccountId: account.id,
        displayName: sessionUser.displayName ?? null,
      });

      logComplete(ctx, {
        startedAt,
        status: 200,
        outcome: "success",
        userId: sessionUser.id,
      });
      return NextResponse.json(response);
    } catch {
      logComplete(ctx, {
        startedAt,
        status: 500,
        outcome: "error",
        errorCode: "resolve_failed",
      });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
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
  logEvent(ctx.log, EVENT_NAMES.POLY_USERS_ME_ACCOUNT_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: fields.status,
    durationMs: Math.round(performance.now() - fields.startedAt),
    outcome: fields.outcome,
    ...(fields.userId ? { userId: fields.userId } : {}),
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
  });
}
