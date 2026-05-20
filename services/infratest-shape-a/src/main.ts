// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import pino from "pino";

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const config = loadConfig();

const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "infratest-shape-a", buildSha: config.BUILD_SHA },
});

const state = { ready: false };
const server = startServer({ config, state });
state.ready = true;

logger.info(
  { port: config.PORT, heartbeatMs: config.HEARTBEAT_INTERVAL_MS },
  "infratest-shape-a started"
);

const heartbeat = setInterval(() => {
  logger.info({ uptimeSec: Math.round(process.uptime()) }, "heartbeat");
}, config.HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

function shutdown(signal: string): void {
  logger.info({ signal }, "shutdown");
  state.ready = false;
  clearInterval(heartbeat);
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
