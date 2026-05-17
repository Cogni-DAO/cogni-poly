// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

describe("poly-test-worker server", () => {
  const config = loadConfig({
    PORT: "0",
    BUILD_SHA: "test-sha",
    BUILD_TS: "2026-05-16",
  });
  const state = { ready: false };
  const server = startServer({ config, state });

  let baseUrl: string;

  beforeAll(() => {
    const addr = server.address();
    if (addr == null || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("/livez returns 200 ok", async () => {
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/readyz returns 503 before ready, 200 after", async () => {
    state.ready = false;
    const before = await fetch(`${baseUrl}/readyz`);
    expect(before.status).toBe(503);
    state.ready = true;
    const after = await fetch(`${baseUrl}/readyz`);
    expect(after.status).toBe(200);
  });

  it("/version returns buildSha from config", async () => {
    const res = await fetch(`${baseUrl}/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildSha: string; service: string };
    expect(body.buildSha).toBe("test-sha");
    expect(body.service).toBe("poly-test-worker");
  });

  it("unknown path returns 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
