# infratest-shape-a - AGENTS.md

> Scope: this directory only. Keep <=150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Re-runs the catalog v2 **Shape A** onboarding exercise from
`docs/guides/create-service.md` end-to-end, this time on top of **task.5006**
(image-native build-provenance via OCI labels - PR #123). Mirror of
`services/poly-test-worker/`, named distinctly so both can coexist while the
guide is validated.

Slated for removal in a follow-up PR once `/validate-candidate` passes on
candidate-a. If you find this directory still present after that test cycle
closed, it is debt and should be deleted.

## Pointers

- [Catalog entry](../../infra/catalog/infratest-shape-a.yaml)
- [k8s base](../../infra/k8s/base/infratest-shape-a/)
- [Create-a-Service guide Shape A](../../docs/guides/create-service.md#shape-a-new-deploy-unit-own-catalog-file)
- [Reference: poly-test-worker](../poly-test-worker/) - original canonical Shape A

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

**External deps:** `pino`, `zod`. Transpile-only (NOT bundled) - pino's
runtime `require('os')` + worker-thread spawn need real `node_modules` at
startup. No `@cogni/*` workspace deps - the exercise demonstrates that a
brand-new standalone service ships without taking on internal couplings.

## Public Surface

- `src/main.ts` - entry: loads config, starts HTTP server, logs heartbeat every `HEARTBEAT_INTERVAL_MS` (default 30s).
- `src/server.ts` - `GET /livez` / `/healthz` (always 200), `GET /readyz` (503 until ready), `GET /version`.
- `src/config.ts` - Zod env parse.
- `Dockerfile` - multi-stage; runner copies `dist/` + `node_modules/` + `package.json` from builder.

## Responsibilities

- Stay minimal. Adding runtime behavior beyond the Shape A validation exercise
  makes the rollback harder to review.
- Do not introduce workspace deps (`@cogni/*`). This service demonstrates the
  minimum surface for a standalone deploy unit.
- Keep it temporary. Remove this directory and its catalog/k8s wiring in the
  rollback PR after candidate-a validation passes.

## Notes

- Non-Ingress service -> no `public_url` block in catalog -> verify via
  `kubectl rollout status` + `verify-buildsha.sh` reading the OCI
  `org.opencontainers.image.revision` label off the overlay-pinned digest.
- Bootstrap deploy branches after merge:
  `scripts/ops/bootstrap-per-node-deploy-branches.sh`.
