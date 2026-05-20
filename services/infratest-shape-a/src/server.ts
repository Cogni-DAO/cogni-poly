// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { Config } from "./config.js";

export interface ServerDeps {
  config: Config;
  state: { ready: boolean };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export function buildHandler(deps: ServerDeps): Handler {
  const version = {
    version: "0.0.1",
    buildSha: deps.config.BUILD_SHA,
    buildTime: deps.config.BUILD_TS,
    service: "infratest-shape-a",
  };

  return (req, res) => {
    const url = req.url ?? "/";
    if (url === "/livez" || url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else if (url === "/readyz") {
      if (deps.state.ready) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("not ready");
      }
    } else if (url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(version));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  };
}

export function startServer(deps: ServerDeps): Server {
  const server = createServer(buildHandler(deps));
  server.listen(deps.config.PORT);
  return server;
}
