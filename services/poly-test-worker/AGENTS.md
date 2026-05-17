# poly-test-worker · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Catalog v2 **Shape A** e2e exercise. A minimal standalone Node TS worker — own pod, own `/livez` `/readyz` `/version`, no external dependencies. Exists to prove that adding a new top-level service through catalog v2 is genuinely _one catalog entry + one source dir + per-env overlay + AppSet generator line_ with **zero edits to scripts, workflows, or schema**.

If the recipe drifts (e.g. someone has to touch `scripts/ci/*` or `.github/workflows/*` to land a new service), this directory's existence is the canary.

## Pointers

- [Catalog entry](../../infra/catalog/poly-test-worker.yaml)
- [k8s base](../../infra/k8s/base/poly-test-worker/)
- [k8s overlays](../../infra/k8s/overlays/candidate-a/poly-test-worker/)
- [AppSets](../../infra/k8s/argocd/) — generator entry in each of `{candidate-a,preview,production}-applicationset.yaml`
- [Create-a-Service guide § Shape A](../../docs/guides/create-service.md#shape-a-new-deploy-unit-own-catalog-file)
- [Catalog v2 spec](../../docs/spec/catalog-v2.md)

## Boundaries

```json
{
  "layer": "services",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "bootstrap",
    "types",
    "packages"
  ]
}
```

**External deps:** `pino`, `zod`. Both bundled by tsup into `dist/main.js`. No workspace (`@cogni/*`) deps — the exercise demonstrates that a brand-new standalone service ships without taking on internal couplings.

## Public Surface

- `src/main.ts` — entry: loads config, starts HTTP server, logs heartbeat every `HEARTBEAT_INTERVAL_MS` (default 30s).
- `src/server.ts` — HTTP server: `GET /livez` (always 200), `GET /readyz` (503 until `state.ready=true`), `GET /version` (returns `{version, buildSha, buildTime, service}`), `GET /healthz` (alias for /livez to satisfy both probe conventions).
- `src/config.ts` — Zod env parse: `PORT` (default 9000), `BUILD_SHA`, `BUILD_TS`, `HEARTBEAT_INTERVAL_MS`, `LOG_LEVEL`.
- `Dockerfile` — multi-stage: builder runs `pnpm install + tsup build`; runner has only `node:22-bookworm-slim` + the bundled `dist/main.js`. Standalone — no workspace dependency wiring.

## Responsibilities

- Stay minimal. Adding any feature here that isn't load-bearing for the Shape A exercise breaks the canary.
- Don't introduce workspace deps (`@cogni/*`). That defeats the "minimum surface to deploy a new service" demonstration.
- Port 9000 matches scheduler-worker convention — both are non-Ingress services serving probes only.

## Notes

- No `public_url` in catalog → catalog v2 verifier filters it as "non-Ingress" → relies on `kubectl rollout status` for proof-of-life (same as scheduler-worker).
- For human-side `/version.buildSha` verification: SSH read-only to the VM and `curl http://poly-test-worker.cogni-candidate-a.svc.cluster.local:9000/version` from inside the cluster.
- This service runs in all three envs (candidate-a, preview, production) — the exercise also validates the full promote-and-deploy chain for a Shape A service.
