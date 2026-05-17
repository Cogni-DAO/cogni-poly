# poly-echo-sidecar · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Catalog v2 e2e exercise sidecar. Minimal HTTP server (FastAPI) that returns 200 on `/healthz` and echoes back on `/echo/<msg>`. Exists to prove the "add a new in-pod image" contributor path is actually one catalog entry + one source dir (with co-located `k8s/` Component) + one `components:` line per overlay where the sidecar runs. Zero inline container patches in host overlays.

If the recipe drifts, this directory's continued existence + clean render is the canary.

## Pointers

- [Catalog entry](../../../../infra/catalog/poly.yaml) — `images[name=poly-echo-sidecar]`
- [Component (container shape)](k8s/kustomization.yaml)
- [Shape B guide](../../../../docs/guides/create-service.md#shape-b-new-image-on-an-existing-deploy-unit)
- [Catalog v2 spec](../../../../docs/spec/catalog-v2.md)

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `fastapi`, `uvicorn`.

## Public Surface

- `Dockerfile` — single-stage `base`. No test target (the sidecar IS the test — round-trip via `/healthz` from the host pod).
- `server.py` — FastAPI app: `GET /healthz` → `{status, buildSha}`; `GET /echo/<msg>` → `{echo}`.
- `k8s/kustomization.yaml` — kustomize Component appending the container to the host's `node-app` Deployment. Image is referenced unpinned (`ghcr.io/cogni-dao/poly-echo-sidecar`); digest substitution comes from the host overlay's `images:` block.

## Responsibilities

- Stay minimal. Any code added here that isn't load-bearing for the exercise breaks the canary.
- Port 9101 (paper-trader holds 9100; pick from `9100-9199` for new sidecars).

## Notes

- Production overlay deliberately omits this sidecar — exercises the `promote-k8s-image.sh` exit-2 skip path.
