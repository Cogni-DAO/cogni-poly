// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().default(9000),
  BUILD_SHA: z.string().default("unknown"),
  BUILD_TS: z.string().default("unknown"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
