---
id: create-service-guide
type: guide
title: Create a New Service
status: draft
trust: draft
summary: Catalog v2 playbook for adding a new image to the deployed stack (new deploy unit OR new image on an existing unit) and shipping it through candidate-a → preview → production.
read_when: Adding any new service, sidecar, MCP server, cron job, or Compose process to the deployed stack.
owner: derekg1729
created: 2026-02-06
verified: 2026-05-18
revisions:
  - 2026-05-18: Shape B gains digest-authority + bootId + sidecar-buildSha-parity invariants (bug.5013 fallout — preview's paper-sidecar was silently regressing to v0 on every non-sidecar PR's promote for ~5 days).
  - 2026-05-16: Shape A re-exercised post catalog v2 via `poly-test-worker` (canonical minimal living reference). Bootstrap canonicalized on `scripts/ops/bootstrap-per-node-deploy-branches.sh`. Validate section split by Ingress vs non-Ingress probe semantics.
  - 2026-05-16: Shape B rewritten — sidecar container shape lives in kustomize Component co-located with source; host overlays use `components:` line + `images:` placeholder only. Zero inline container patches.
tags: [deployment, infra, k8s, argo]
---

# Create a New Service (v0)

## When to Use

You are adding any net-new process that runs in the deployed stack: standalone service, sidecar, MCP server, scheduled job, or (rarely) a Compose process.

**Do NOT use this guide for:** shared libraries (`packages/`), feature code inside a node app (`nodes/<node>/app/src/features/`), local-only scripts (`scripts/`).

## K8s-Native Default

**Every new service we author runs in k3s under Argo CD.** Compose is **legacy** for upstream third-party processes (postgres, temporal, redis, caddy, alloy, litellm, doltgres). Adding a Compose service for code we own is a review reject.

K8s gets BUILD_ONCE_PROMOTE_DIGEST, Argo reconciliation, the candidate → preview → production flight chain, and full reproducibility from `provision-test-vm.sh` + GitOps. Compose only gets rsync-and-restart via [`scripts/ci/deploy-infra.sh`](../../scripts/ci/deploy-infra.sh), which by design never touches k8s ([`deploy-infra.sh:26-28`](../../scripts/ci/deploy-infra.sh)).

## Decision Tree

Catalog v2 (docs/spec/catalog-v2.md) collapsed the shape space:

```
Does the new image have its OWN deploy lifecycle (Argo Application + per-env deploy branches)?
│
├─ Yes  →  SHAPE A — New deploy unit
│          Add a new `infra/catalog/<name>.yaml` with deploy{} + images:[{role: app}]
│
└─ No, it ships inside an EXISTING deploy unit's pod
   │
   ├─ Sibling container in the same pod         →  SHAPE B (role: sidecar)
   ├─ initContainer migration                    →  SHAPE B (role: migrator)
   ├─ stdio MCP spawned by host pod              →  SHAPE B (role: sidecar)
   │
   Add an entry to the host's `infra/catalog/<host>.yaml::images[]` — no new catalog file.
```

**Specialty cases (unchanged from pre-v2):**

- **Periodic cron** → no first-class CronJob support yet. Register as a periodic handler in [`services/scheduler-worker/`](../../services/scheduler-worker/) (a SHAPE A deploy unit). Filed gap for a future `infra/k8s/base/cronjob/` shape.
- **Upstream third-party Compose** → legacy `infra/compose/runtime/docker-compose.yml` path. Sign-off required. See § Compose (legacy).

**Hard rules** (reject in code review):

- `:latest` in any new manifest — tag by SHA only.
- Manual VM SSH as part of any deploy — every change lands in git.
- Compose service for code we author — SHAPE A instead.
- Sibling container when it could be standalone — SHAPE A instead.
- A parallel `.github/workflows/build-<name>.yml` for any new image — catalog v2 absorbs the matrix; standalone build workflows are an anti-pattern.

---

## The Pipeline (End-to-End)

Same for every shape. Five phases. Each shape's playbook below maps to these.

| Phase                     | What                                                 | How                                                                                                                                                                                                  | Verify                                                                                                               |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **1. Author**             | Code + manifests + wiring                            | Per-shape file checklist                                                                                                                                                                             | `pnpm check`; `docker build` locally; `kustomize build infra/k8s/overlays/candidate-a/<name>`                        |
| **2. PR Build**           | Image to GHCR                                        | Automatic via [`pr-build.yml`](../../.github/workflows/pr-build.yml) on PR open/sync                                                                                                                 | `gh pr checks <N>` green; image at `ghcr.io/cogni-dao/cogni-poly:pr-<N>-<sha><suffix>`                               |
| **3. Candidate-A Flight** | Push to `deploy/candidate-a-<name>`; Argo reconciles | `gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <branch> -f pr_number=<N>`                                                                                                       | Workflow green; `/validate-candidate` scorecard PASS                                                                 |
| **4. Preview Promote**    | Auto on merge to `main`                              | [`flight-preview.yml`](../../.github/workflows/flight-preview.yml) re-tags `pr-` → `preview-` and dispatches [`promote-and-deploy.yml`](../../.github/workflows/promote-and-deploy.yml)              | `https://poly-preview.cognidao.org/version.buildSha` matches merge SHA; Loki shows your service requests at that SHA |
| **5. Production Promote** | Human-dispatched                                     | `gh workflow run promote-and-deploy.yml -R Cogni-DAO/cogni-poly -f environment=production -f source_sha=<sha> -f build_sha=<sha>` — or use [`/promote` skill](../../.claude/skills/promote/SKILL.md) | `https://poly.cognidao.org/version.buildSha` matches; no Loki error spike vs prior 1h                                |

**Production promote gate** (verify before dispatching prod):

1. Preview soak ≥ 1 hour with real traffic
2. `/version.buildSha` on preview matches the source SHA you'll promote
3. No new error spike in Loki vs. the prior preview SHA (`{service=~"<name>", level=~"error|fatal"} | rate(5m)`)
4. Rollback plan written into the PR body (see [Rollback](#rollback))

---

## Shape A: New Deploy Unit (own catalog file)

A pod with its own Deployment, Service, optional Ingress, and per-env deploy branch. Fully integrated with the pipeline. Use this when the new image has independent lifecycle (own restart, own scaling, own /readyz).

**Precedents**:

- [`services/poly-test-worker/`](../../services/poly-test-worker/) — **minimal canonical reference** (catalog v2 Shape A e2e exercise). Standalone (no `@cogni/*` workspace deps), two-stage Dockerfile (builder transpiles via tsup, runner gets `dist/` + `node_modules/` + `package.json`). Mirror this when adding any net-new Shape A service. Source dir + catalog entry + base + 3 overlays + 3 AppSet generator entries — that's the whole surface.
- [`services/scheduler-worker/`](../../services/scheduler-worker/) — fuller real-world Shape A. Carries workspace dep wiring via `turbo prune` + `pnpm deploy`. Use this when the new service depends on `@cogni/*` packages or needs to talk to other components in-cluster.

> **Do NOT use `bundle: true` in `tsup.config.ts`.** Pino (and other Node packages with runtime worker-threads or native-module `require()`) cannot be packed into an ESM bundle — they crash on first import with `Error: Dynamic require of "os" is not supported`. The canonical pattern is `bundle: false` + transpile every `src/**/*.ts` + copy `node_modules/` into the runner image. Both precedents above follow this.

**Sub-case — HTTP/SSE MCP server**: Shape A. Own port, own probes, own scaling.

### Files to create / edit

**One PR. Node-autonomous if owned by a node** ([`node-ci-cd-contract.md § Node-autonomous service evolution`](../spec/node-ci-cd-contract.md)); operator-domain for shared services.

- [ ] `services/<name>/` (TS) or `nodes/<host>/sidecars/<name>/` (Python/polyglot under a node) — source + `Dockerfile`
- [ ] `infra/catalog/<name>.yaml` — catalog v2 shape, validated by [`pnpm check:catalog`](../../tests/ci-invariants/catalog-v2.spec.ts):

  ```yaml
  schema_version: 2
  name: <name> # must match filename; ^[a-z][a-z0-9-]*$
  type: service # "node" requires node_id

  deploy:
    candidate_a_branch: deploy/candidate-a-<name>
    preview_branch: deploy/preview-<name>
    production_branch: deploy/production-<name>
    path_prefix: services/<name>/ # MUST end with /
    port: 9000
    # public_url block only if this unit has an Ingress (omit for workers)

  images:
    - name: <name>
      role: app # exactly one role:app per unit
      dockerfile: services/<name>/Dockerfile
      image_name: ghcr.io/cogni-dao/cogni-poly # shared package, suffix discriminates
      image_tag_suffix: "-<name>" # repo-wide unique
      build:
        target: runner # optional docker buildx --target
  ```

- [ ] `infra/k8s/base/<name>/{deployment,service,kustomization}.yaml` — reference [`infra/k8s/base/scheduler-worker/`](../../infra/k8s/base/scheduler-worker/) (worker) or [`infra/k8s/base/node-app/`](../../infra/k8s/base/node-app/) (HTTP)
- [ ] `infra/k8s/overlays/{candidate-a,preview,production}/<name>/kustomization.yaml` — overlay's `images:` block uses `newTag: "<env>-placeholder-<name>"` or `digest: "sha256:..."`; [`promote-k8s-image.sh`](../../scripts/ci/promote-k8s-image.sh) replaces either with the promoted digest.
- [ ] **`infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml`** — add a generator block in each. **This is the silent killer**: skip it and the catalog entry + overlay exist on disk but no Argo Application materializes. Pattern:
  ```yaml
  - git:
      repoURL: https://github.com/cogni-dao/cogni-poly.git
      revision: deploy/<env>-<name>
      files:
        - path: "infra/catalog/<name>.yaml"
  ```
- [ ] **[`scripts/ci/wait-for-in-cluster-services.sh`](../../scripts/ci/wait-for-in-cluster-services.sh)** — add the deploy unit to the `PROMOTED_APPS` → Kubernetes Deployment mapping. Internal Shape A services usually map `<name>` → `<name>`; node apps map `<node>` → `<node>-node-app`.
- [ ] **`biome/base.json`** — if you add `tsup.config.ts` and/or `vitest.config.ts` (both use `export default`), append their paths to the `noDefaultExport: off` overrides allowlist. Known Shape A friction; tracked as a follow-up to fold config-file globbing into the rule.

### Deploy branch bootstrap (chicken-and-egg)

The AppSet generator's `revision: deploy/<env>-<name>` errors on first reconcile if the branch doesn't exist.

**Canonical path** — run [`scripts/ops/bootstrap-per-node-deploy-branches.sh`](../../scripts/ops/bootstrap-per-node-deploy-branches.sh) **after merge**. It reads the v2 catalog, finds your new deploy unit, and pushes `deploy/{candidate-a,preview,production}-<name>` from the corresponding `deploy/<env>` whole-slot tips (atomic + idempotent + fast-forward-only). Document the post-merge command in the PR body.

**Manual fallback** — `git push origin main:deploy/candidate-a-<name> main:deploy/preview-<name> main:deploy/production-<name>` if the bootstrap script isn't available.

### Flight phase 3 → 5 mechanics

- **Flight to candidate-a**: [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) resolves digests via [`resolve-pr-build-images.sh`](../../scripts/ci/resolve-pr-build-images.sh), writes them into `deploy/candidate-a-<name>` via [`promote-build-payload.sh`](../../scripts/ci/promote-build-payload.sh) (per-image, iterating `images_for_deploy_unit`), then [`wait-for-argocd.sh`](../../scripts/ci/wait-for-argocd.sh) + [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) block until Argo + rollout agree and every promoted image's `org.opencontainers.image.revision` label matches the per-image source-sha map (task.5006).
- **Auto-preview on merge**: [`flight-preview.yml`](../../.github/workflows/flight-preview.yml) re-tags `pr-{N}-{sha}` → `preview-{sha}` per image and dispatches `promote-and-deploy.yml`.
- **Manual prod**: see Phase 5 in the pipeline table above.

### Validate

`/validate-candidate` scorecard rows:

- `kubectl rollout status deploy/<name>` reaches `successfully rolled out` (proves the new ReplicaSet replaces the old — Argo `Healthy` alone is insufficient per [Axiom 15](../spec/ci-cd.md))
- `/version.buildSha` matches PR head SHA
- One real request observed in Loki at the deployed SHA

**Ingress vs non-Ingress probe semantics:** uniform under task.5006. `verify-buildsha.sh` reads `org.opencontainers.image.revision` off the overlay-pinned digest via `crane config` — no HTTP, no Ingress, no `kubectl exec`. Ingress-only signals stay live elsewhere: `/livez` + `/readyz` 200 from outside the cluster for `deploy.public_url.<env>` units (`scripts/ci/smoke-candidate.sh`); for non-Ingress deploy units (workers, internal services — `poly-test-worker` is the canonical example) `kubectl rollout status` covers the rollout side. The build-SHA witness itself is identical across both: same label, same `crane` read, same per-image map.

---

## Shape B: New Image on an Existing Deploy Unit

A new **in-pod image** — sidecar, migrator initContainer, or stdio MCP — that ships **inside an existing deploy unit's pod**. "In-pod image" ≠ "service": a service is a deploy unit (Shape A). Catalog v2 + kustomize Components make Shape B a thin, declarative add — no inline container patches in host overlays.

**Precedent**: `poly-paper-sidecar` and `poly-echo-sidecar`. Source + Dockerfile live under `nodes/poly/sidecars/<name>/`; the kustomize Component (container patch) lives under `infra/k8s/components/sidecars/<image-name>/`. Host overlays reference each via one `components:` line per env where the sidecar runs. The split is operational: component files must travel with overlays to the deploy branch (which only syncs `infra/k8s/`), source files don't need to.

### When

- Sidecar must share network namespace (localhost IPC), an in-pod volume, or restart in lockstep with the host.
- Migrator runs once at pod startup as an `initContainer`.
- stdio MCP that the host pod spawns over a pipe.

Anything that could run independently → Shape A instead.

### Files to create / edit

**One PR. Node-autonomous** (host node's catalog file + host node's overlay).

- [ ] Source + `Dockerfile` under the host's tree:
  - Sidecar: `nodes/<host>/sidecars/<name>/Dockerfile`
  - Migrator: `nodes/<host>/db/Dockerfile`
- [ ] A kustomize Component holding the container patch — MUST live under `infra/k8s/components/sidecars/<image-name>/` so it gets synced to the deploy branch with the rest of `infra/k8s/`. Co-locating it under `nodes/<host>/sidecars/<name>/k8s/` looks tidier but breaks Argo render (`infra/k8s` is the only synced tree):

  ```yaml
  # infra/k8s/components/sidecars/<image-name>/kustomization.yaml
  apiVersion: kustomize.config.k8s.io/v1alpha1
  kind: Component

  patches:
    - target: { kind: Deployment, name: node-app }
      patch: |
        - op: add
          path: /spec/template/spec/containers/-
          value:
            name: <host>-<name>-sidecar
            image: ghcr.io/cogni-dao/<host>-<name>-sidecar
            ports:
              - { containerPort: <port>, name: <short>, protocol: TCP }
            livenessProbe: { httpGet: { path: /healthz, port: <short> } }
            readinessProbe: { httpGet: { path: /healthz, port: <short> } }
            resources:
              requests: { memory: "64Mi", cpu: "20m" }
              limits: { memory: "128Mi", cpu: "100m" }
  ```

- [ ] Add an entry to the host's catalog file's `images:[]`:

  ```yaml
  # infra/catalog/<host>.yaml
  images:
    - name: <host>          # existing role:app entry — don't touch
      role: app
      ...
    - name: <host>-<name>-sidecar    # new — repo-wide unique
      role: sidecar                  # or "migrator"
      dockerfile: nodes/<host>/sidecars/<name>/Dockerfile
      image_name: ghcr.io/cogni-dao/<host>-<name>-sidecar
      image_tag_suffix: ""
      path_prefix: nodes/<host>/sidecars/<name>/
      build:
        context: nodes/<host>/sidecars/<name>
        target: base                 # optional --target
        test_target: test            # optional pre-push smoke (no --push)
  ```

- [ ] Activate the sidecar in each overlay where it runs — **one line** under `components:` and **one entry** in `images:` (placeholder digest, overwritten on first promote):

  ```yaml
  # infra/k8s/overlays/<env>/<host>/kustomization.yaml
  components:
    - ../../../components/sidecars/<image-name>   # NEW — Component holds the container patch

  images:
    - name: ghcr.io/cogni-dao/<host>                    # host app (already there)
      ...
    - name: ghcr.io/cogni-dao/<host>-<name>-sidecar     # NEW — must match catalog image_name
      newName: ghcr.io/cogni-dao/<host>-<name>-sidecar
      newTag: "<env>-placeholder-<host>-<name>-sidecar" # overwritten by promote-k8s-image
  ```

  `promote-build-payload.sh` rewrites BOTH `images:` entries on flight — host and sidecar are independent because `promote-k8s-image.sh` matches by `name:`. **The overlay `images[]` entry MUST exist before the first promote** — otherwise `promote-k8s-image` returns exit-2 (legitimate skip, no overlay write). Container _shape_ (port, probes, resources) lives in the Component file and is never edited per overlay.

- [ ] If host needs to call the sidecar, add `<NAME>_URL: http://localhost:<port>` via a ConfigMap patch in the same overlay.

- [ ] **Loki collection is automatic when the container writes structured JSON to stdout/stderr.** The cluster's log-collector picks up every container under `{namespace=~"cogni-.*"}` and parses `| json`; the container's own name becomes the `container=` label. No DaemonSet patch, no annotation. Verify after first deploy with `scripts/loki-query.sh '{namespace="cogni-candidate-a", container="<your-sidecar>"}'` — if streams return, you're done. If empty, the container is logging to a file instead of stdout (fix the app, not the infra). Emit Pino/`structlog`-shaped JSON so adapter errors classify cleanly via `errorCode`/`errorClass` labels — bare `throw new Error("…")` paths vanish into a generic bucket (bug.5060).

### Production overlay decision

Decide explicitly whether the image runs in production. The paper-trading sidecar deliberately does **not** ship to prod — its overlay simply omits the `images:` entry for the sidecar. `promote-build-payload.sh` exits-2 (legitimate skip, not error) when there's no matching `images:` entry; the deploy unit's `promoted_apps` still reflects the apps that actually wrote.

### Digest authority (bug.5013 — read this before merging your first Shape B PR)

For multi-image deploy units, the **deploy branch's prior digest pin is authoritative** for every image not rebuilt by the current PR. The promote workflow snapshots the deploy branch's overlay before rsyncing from main, then replays the snapshot, then layers PR-affected digests on top (`RESTORE_MODE=always` for both candidate-flight and promote-and-deploy since bug.5013). This means:

- An unaffected sidecar **cannot** silently regress to whatever digest `main:infra/k8s/overlays/<env>/<host>/kustomization.yaml` happens to carry. This was the live bug class (bug.5013) where `poly-paper-sidecar` was frozen at v0 on preview for five sidecar PRs in a row.
- `main`'s overlay digest pin for your new sidecar **only matters for cold-start** — the first time the image lands on a fresh `deploy/<env>-<host>` branch. After that, the deploy branch is the source of truth.
- The [`task.0349` digest-seed loop](../../.github/workflows/promote-preview-digest-seed.yml) tries to keep main's overlay current, but it is best-effort and not load-bearing for live deploys.

### `bootId` invariant (for sidecars with externally-visible state)

If your sidecar returns IDs or refs that callers persist (order IDs, job IDs, transaction IDs), **namespace them by a per-process `BOOT_ID`** (uuid4().hex[:12] is fine) so they don't collide across pod restarts. Bug.5005 cost two days when the paper-trading sidecar's SQLite-backed `order_id` autoincrement reset on every pod boot and collided with persisted Postgres rows from prior boots (PR #69 fix). Also include `bootId` as a structured-log field so Loki queries can correlate a request to a specific pod incarnation.

### Sidecar buildSha parity (closed by task.5006)

Sidecars and Shape A units share the same verify gate. Every image baked by `scripts/ci/build-and-push-images.sh` carries `org.opencontainers.image.revision=<build SHA>` at the OCI manifest level; [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) reads the label back via `crane config` off the overlay-pinned digest and asserts it matches the per-image entry in `.promote-state/source-sha-by-app.json`. No `/version` endpoint on the sidecar is required — the witness travels with the digest. Adding a new sidecar gets buildSha parity automatically as long as it builds through the catalog.

### Validate

`/validate-candidate` scorecard rows for Shape B:

- Host pod `/livez` + `/readyz` still pass at the deployed SHA
- Sidecar container Ready in `kubectl describe pod`
- For sidecars exposed over localhost: `kubectl exec <host-pod> -c <name> -- wget -qO- localhost:<port>/healthz` returns 200
- One real request to the new image observed in Loki at the deployed SHA

---

## stdio MCP (sub-shape of B)

stdio MCP servers spawn as child processes from the host pod and share its lifecycle — Shape B with `role: sidecar`. HTTP/SSE MCP is Shape A.

---

## Compose (legacy — closed for code we author)

Process in `infra/compose/runtime/docker-compose.yml`, deployed via [`candidate-flight-infra.yml`](../../.github/workflows/candidate-flight-infra.yml) → [`deploy-infra.sh`](../../scripts/ci/deploy-infra.sh).

**Valid only for**: upstream third-party processes already pre-dating the k8s pipeline (postgres, temporal, redis, alloy, caddy, litellm, doltgres, db-backup). Net-new additions require explicit sign-off.

**Procedure** (after sign-off):

- Add definition to [`infra/compose/runtime/docker-compose.yml`](../../infra/compose/runtime/docker-compose.yml) with **explicit image tag** (never bare `image: vendor/foo`)
- If local extension needed (e.g. `litellm` custom callback), add Dockerfile under [`infra/images/<name>/`](../../infra/images/)
- Document env vars in [`docs/spec/environments.md`](../spec/environments.md)
- Flight: `gh workflow run candidate-flight-infra.yml -R Cogni-DAO/cogni-poly --ref <branch>`
- Verify: `docker compose ps` healthy + external probe (no Argo, no `/version.buildSha`, no rollout-status)

---

## Cron / One-Shot Job

| Trigger                 | Where it lives                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| One-shot at deploy time | Shape B `role: migrator` — initContainer in the host's Deployment                                         |
| Triggered / queued      | Shape A worker — register the handler in [`services/scheduler-worker/`](../../services/scheduler-worker/) |
| Periodic schedule       | **GAP — no precedent.** Use scheduler-worker handler as workaround.                                       |

**Workaround for periodic work**: register the task as a periodic handler in scheduler-worker. Pure Shape A code change. If you ever need a true `CronJob` (heavy resource isolation, distinct image), file a follow-up to add `infra/k8s/base/cronjob/`.

---

## Universal Invariants

These apply across shapes. Failures here cause silent deploy issues that the pipeline does not catch.

### Health probes

| Endpoint   | Purpose                       | k8s probe                                                                                                                                                             |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/livez`   | Process alive, not deadlocked | `livenessProbe` (cheap, no DB)                                                                                                                                        |
| `/readyz`  | Ready to accept work          | `readinessProbe` (set false during drain)                                                                                                                             |
| `/version` | `{ buildSha, builtAt }`       | — Shape A operator/debugging convenience; [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) no longer reads it (task.5006 uses the baked OCI label instead) |

**Health probes belong in k8s manifests, NOT in the Dockerfile.** No `HEALTHCHECK` instruction — it bakes probe logic into the image and prevents orchestrator-specific tuning.

### Worker drain semantics (Shape A workers + Shape B (cron handler) handlers)

`/readyz=false` must **gate the work-claim loop**, not just HTTP routing:

1. SIGTERM → `ready=false` immediately
2. Stop polling / claiming new jobs
3. Drain in-flight work with timeout (typical: 30s)
4. Close DB pool + external connections
5. `process.exit(0)`

In k8s, `ready=false` also drops the pod from Service endpoints. **Workers must NOT rely on that** — claim-loop gating is mandatory because there is no Service routing pressure on Temporal workers.

### Dockerfile rules

- Multi-stage; final stage `node:22-bookworm-slim` (glibc — broad native-dep compatibility; Alpine only if no native deps + CI smoke proves it)
- Pin pnpm via `corepack prepare pnpm@<root-package.json-packageManager> --activate` — **not** `pnpm@latest`
- Install `python3 make g++` in builder for native modules (`bufferutil` etc. from shared lockfile)
- Run as non-root (`addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 worker; USER worker`)
- **No `HEALTHCHECK`** (see above)
- Digest-stable build: no timestamps, no random IDs, no `git rev-parse` baked into env at build time — BUILD_ONCE_PROMOTE depends on this

Reference: `services/scheduler-worker/Dockerfile`.

### ESM rules (TS services)

- `tsup` transpile-only (`bundle: false`) — ESM bundling breaks libs that use dynamic requires (pino throws `Dynamic require of "os" is not supported`)
- All relative imports include `.js` extensions: `import { x } from "./y.js"` — TypeScript resolves `.js`→`.ts` at compile; Node needs `.js` at runtime
- Standalone `tsconfig.json` (not in root references — services are isolated)
- Config via Zod (`src/config.ts` parses `process.env`, exits non-zero on failure) — **never** use `process.env` in business code

### Security context (k8s)

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
volumeMounts:
  - { name: tmp, mountPath: /tmp }
volumes:
  - { name: tmp, emptyDir: {} }
```

### Secrets (sops + ksops)

- Per-env encrypted secrets at `infra/k8s/secrets/<env>/<name>.enc.yaml` (template: [`sandbox-openclaw.enc.yaml.example`](../../infra/k8s/secrets/staging/sandbox-openclaw.enc.yaml.example))
- Reference via `envFrom.secretRef.name: <name>-secrets` in the Deployment
- Encrypt: `sops --encrypt --age <env-recipient> --in-place <file>.enc.yaml` (age pubkeys in `.sops.yaml`)
- Argo's config-management plugin decrypts at sync time using the VM's age key
- **Never** bake secrets into images or `kubectl create secret` on the VM (reprovision wipes it)
- **Not used**: sealed-secrets, external-secrets-operator, Vault

### HA reality

The repo runs `replicas: 1` everywhere. Zero `PodDisruptionBudget`, zero `HorizontalPodAutoscaler`. A pod restart is downtime. **Do not bolt on speculative HA** in a new-service PR — multi-replica + PDB + HPA is a deliberate repo-wide project, not per-service work. Do set tight resource requests/limits + `terminationGracePeriodSeconds` ≥ your drain timeout.

### Reproducibility (zero SSH)

**Pass criterion**: destroy the candidate-a VM, run [`scripts/setup/provision-test-vm.sh`](../../scripts/setup/provision-test-vm.sh), wait for Argo to reconcile. Your service must come back without a single manual SSH step. If your PR's bring-up requires SSH, it's a bug in the PR, not an operational quirk.

---

## Anti-Patterns (consolidated — reject in code review)

Image / build:

- `:latest` in any new deploy manifest
- Catalog entry pointing at a Dockerfile that isn't digest-stable (timestamps, random IDs, git-state at build)
- `HEALTHCHECK` instruction in the Dockerfile
- ESM bundled build for a service that imports pino (breaks at runtime)

Deploy state:

- Adding an `images:` entry to an overlay without a matching `images[]` entry in the host catalog file — `pnpm check:catalog` won't catch this end of the contract, but promote-build-payload won't promote the unknown digest either (silent stale-image).
- Catalog entry without a matching AppSet generator block (silent: pipeline goes green, service never deploys)
- Sidecar without its own `livenessProbe`/`readinessProbe` (host pod becomes Ready while sidecar is broken)
- **Sidecar container patch written inline in a host overlay** — container _shape_ (port, probes, resources) lives in the sidecar's own `k8s/` Component, not in `infra/k8s/overlays/<env>/<host>/kustomization.yaml`. Inline = duplicated across envs = drift.
- Hand-editing `deploy/<env>-<name>` directly instead of patching the `main` overlay (bypasses review + single-domain-scope)
- Adding to the catalog a service that should not gate flights — drop it from the catalog instead

Compose / legacy:

- Compose service for code we author — use Shape A instead, no exceptions
- Compose service with bare `image: vendor/foo` (no tag → drift on every VM rebuild)
- Compose service with `restart: always` masking a crash loop — use `restart: unless-stopped` + alerting

Runtime:

- Worker that gates only HTTP routing on `/readyz=false` and not the poll-claim loop — jobs claimed during drain → corruption
- MCP server with secrets baked into the image (use `envFrom.secretRef` instead)
- Hardcoded MCP / sidecar port collisions — pick from `9100-9199` and document in the overlay

Process:

- New service PR that crosses domains (e.g. catalog change + node app feature wiring in one PR) — split into two PRs per [`single-node-scope`](../spec/node-ci-cd-contract.md)
- Speculative HA (`PodDisruptionBudget` + `replicas: 1` → Argo stuck)
- Manual VM SSH as a step in any deploy or recovery path

---

## Rollback

**If you can't describe rollback in one sentence, the PR is not ready to merge.** Put the rollback recipe in the PR body.

| Shape                     | Forward                                                                                              | Rollback                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A. New deploy unit        | `gh workflow run promote-and-deploy.yml -f environment=<env> -f source_sha=<new> -f build_sha=<new>` | Same workflow with the prior `source_sha` — look up via `git log deploy/<env>-<name> --oneline` or `.promote-state/source-sha-by-app.json` |
| B. Image on existing unit | Standard catalog v2 path — promote-build-payload bumps every image of the host's deploy unit         | `git revert <catalog-or-source-commit>` → re-promote                                                                                       |
| Compose (legacy)          | `candidate-flight-infra` / `promote-and-deploy` with new `infra/compose/**`                          | Same workflow with `--ref <older-sha>`                                                                                                     |
| Cron handler              | Standard Shape A rollback                                                                            | Same. For "stop the cron immediately" without a redeploy, document a runtime feature-flag at handler creation.                             |

For new services, "rollback = remove" — see Deprecation in [Services Architecture Spec](../spec/services-architecture.md) or run the Shape A steps in reverse (empty deploy state → remove AppSet generator → remove catalog → delete deploy branches → remove source).

---

## Related

- [Node CI/CD Contract](../spec/node-ci-cd-contract.md) — BUILD_ONCE_PROMOTE_DIGEST, single-node-scope, SCRIPTS_ARE_THE_API
- [Node ↔ Operator Contract](../spec/node-operator-contract.md) — DEPLOY_INDEPENDENCE, HEALTH_ENDPOINTS_REQUIRED
- [Services Architecture Spec](../spec/services-architecture.md) — invariants, import boundaries
- [Health Probes Spec](../spec/health-probes.md) — full liveness / readiness / drain contract
- [Candidate Flight V0 Guide](./candidate-flight-v0.md)
- [Multi-Node Dev Guide](./multi-node-dev.md)
- [`/validate-candidate` skill](../../.claude/skills/validate-candidate/SKILL.md)
- [`/promote` skill](../../.claude/skills/promote/SKILL.md)
- [CI/CD & Services GitOps Project](../../work/projects/proj.cicd-services-gitops.md) — active gaps, follow-up work, roadmap
