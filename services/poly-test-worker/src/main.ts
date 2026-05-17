// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import pino from "pino";

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const config = loadConfig();

const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "poly-test-worker", buildSha: config.BUILD_SHA },
});

const state = { ready: false };
const server = startServer({ config, state });
state.ready = true;

logger.info(
  { port: config.PORT, heartbeatMs: config.HEARTBEAT_INTERVAL_MS },
  "poly-test-worker started"
);

const heartbeat = setInterval(() => {
  logger.info({ uptimeSec: Math.round(process.uptime()) }, "heartbeat");
}, config.HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

function shutdown(signal: string): void {
  logger.info({ signal }, "shutdown");
  state.ready = false;
  clearInterval(heartbeat);
  // closeAllConnections forces existing keep-alive sockets to close (Node 18.2+).
  // Without it, server.close() can wait indefinitely on probe sockets that are
  // technically "open" in keep-alive state, leaving the pod in Terminating state
  // past terminationGracePeriodSeconds and stalling rollout.
  server.closeAllConnections();
  server.close(() => process.exit(0));
  // Hard cap: exit fast even if close callback never fires.
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
