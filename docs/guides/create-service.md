---
id: create-service-guide
type: guide
title: Create a New Service
status: draft
trust: draft
summary: Decision tree + per-shape playbook for adding any new deployable service (k8s deployment, sibling container, MCP, Compose, cron) and flighting it through candidate-a → preview → production.
read_when: Adding any new service, sidecar, MCP server, cron job, or Compose process to the deployed stack.
owner: derekg1729
created: 2026-02-06
verified: 2026-05-16
tags: [deployment, infra, k8s, argo]
---

# Create a New Service

## When to Use This

You are adding any net-new process that runs in the deployed stack. This includes:

- A standalone HTTP service or worker (e.g. `scheduler-worker`)
- A sidecar container that shares a pod with an existing workload (e.g. `poly-paper-sidecar`)
- An MCP server
- A scheduled job
- A Compose-stack process (rare — see Shape 4)

**Do NOT use this guide for:** shared libraries (`packages/`), feature code inside a node app (`nodes/<node>/app/src/features/`), or local-only scripts (`scripts/`).

## K8s-Native Default

> **Every new service we author runs in k3s under Argo CD.** Docker Compose is **legacy infrastructure** for third-party processes that pre-date the k8s pipeline (postgres, temporal, redis, caddy, alloy, litellm, doltgres). Adding a new Compose service for code we own is a code-review reject unless you can prove no k8s shape applies.

Why: only k8s gets BUILD_ONCE_PROMOTE_DIGEST, Argo reconciliation, the candidate → preview → production flight chain, and reproducibility from `provision-test-vm.sh` + GitOps state. Compose only gets rsync-and-restart via [`scripts/ci/deploy-infra.sh`](../../scripts/ci/deploy-infra.sh), which by design never touches k8s ([`deploy-infra.sh:26-28`](../../scripts/ci/deploy-infra.sh)).

## Decision Tree

Pick your shape in 30 seconds:

```
Does the new process serve traffic / do work the deployed stack depends on?
│
├─ Yes
│  │
│  ├─ Can it run as its own pod with its own restart lifecycle?
│  │  └─ YES → SHAPE 1: Standalone k8s Deployment   (DEFAULT)
│  │
│  ├─ Must it share network namespace, volumes, or restart with an existing pod?
│  │  └─ YES → SHAPE 2: Sibling Container
│  │
│  ├─ Is it an MCP server?
│  │  ├─ HTTP / SSE transport  → SHAPE 1
│  │  └─ stdio (spawned by host pod) → SHAPE 2
│  │
│  └─ Is it a third-party process that doesn't run cleanly in k8s yet
│     AND that's already pinned to a published image?
│     └─ YES → SHAPE 4: Compose-Stack Service  (LEGACY — needs explicit sign-off)
│
└─ Periodic / one-shot work?
   ├─ One-shot at deploy time (migration, seed) → initContainer in node-app base
   ├─ Periodic (cron)                            → SHAPE 5  (gap today — see workaround)
   └─ Triggered (queued work)                    → SHAPE 1 worker (scheduler-worker pattern)
```

Hard rules:

- **Reject Compose** for code we author. Force a Shape 1 or Shape 2 answer.
- **Reject sibling** if the workload needs its own `Service`, `Ingress`, independent scaling, or independent restart. Use Shape 1 instead.
- **Reject `:latest`** in any manifest. Tag by SHA only.
- **Reject manual VM SSH** as part of any deploy. Every change lands in git.

---

## Shape 1: Standalone k8s Deployment (DEFAULT)

A new pod with its own Deployment, Service, optional Ingress, and per-env deploy branch. Fully integrated with the pipeline: PR build matrix, candidate-flight, preview, production.

### When

- Workload has its own restart lifecycle
- Workload needs its own `Service` or `Ingress`, or is independently scalable
- Workload exposes HTTP/SSE health endpoints (`/livez`, `/readyz`) or can be probed via `tcpSocket`/`exec`

**Anti-cases:** lifecycle-coupled to another pod (use Shape 2); stdio-only MCP (use Shape 2); upstream-pinned Compose-only process (use Shape 4 under sign-off).

**Precedent:** [`services/scheduler-worker/`](../../services/scheduler-worker/) — catalog entry [`infra/catalog/scheduler-worker.yaml`](../../infra/catalog/scheduler-worker.yaml), base [`infra/k8s/base/scheduler-worker/`](../../infra/k8s/base/scheduler-worker/).

### Build pipeline

The **catalog SSOT** at [`infra/catalog/`](../../infra/catalog/) is the only switch you need to flip. [`scripts/ci/lib/image-tags.sh:27-29`](../../scripts/ci/lib/image-tags.sh) reads every `*.yaml` in that directory into `ALL_TARGETS`; every downstream workflow ([`pr-build.yml`](../../.github/workflows/pr-build.yml), [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml), [`promote-and-deploy.yml`](../../.github/workflows/promote-and-deploy.yml)) iterates that list. **Add to the catalog → the pipeline picks you up automatically. Skip the catalog → you opt out of every standard primitive.**

Steps:

- [ ] Create source dir at `services/<name>/` (TS/Node) or `infra/images/<name>/` (Python, nginx, polyglot)
- [ ] Create `infra/catalog/<name>.yaml` against [`infra/catalog/_schema.json`](../../infra/catalog/_schema.json):
  ```yaml
  name: <name>
  type: service # use "node" only for a full top-level node app
  port: 9000 # health port; main port if HTTP
  dockerfile: services/<name>/Dockerfile # or infra/images/<name>/Dockerfile
  image_tag_suffix: "-<name>"
  migrator_tag_suffix: "-<name>-migrate" # alias; harmless no-op for services without per-node migrators
  path_prefix: services/<name>/
  candidate_a_branch: deploy/candidate-a-<name>
  preview_branch: deploy/preview-<name>
  production_branch: deploy/production-<name>
  ```
- [ ] Add the three per-env deploy branches (empty initial commit is fine — Argo ApplicationSet reads them by name)
- [ ] Add `path_prefix` paths to [`scripts/ci/detect-affected.sh`](../../scripts/ci/detect-affected.sh) if your service source lives outside the conventional `services/<name>/` / `infra/images/<name>/` tree

### Deploy state

- [ ] Create the k8s base at `infra/k8s/base/<name>/`:
  - `deployment.yaml` (replicas: 1, security context per **Cross-Cutting: Observability + Health Hooks** below)
  - `service.yaml`
  - `kustomization.yaml`
  - Cite [`infra/k8s/base/scheduler-worker/`](../../infra/k8s/base/scheduler-worker/) for a worker; [`infra/k8s/base/node-app/`](../../infra/k8s/base/node-app/) for an HTTP service
- [ ] Create per-env overlays at `infra/k8s/overlays/{candidate-a,preview,production}/<name>/kustomization.yaml`. The overlay's `images:` block is what [`scripts/ci/promote-k8s-image.sh`](../../scripts/ci/promote-k8s-image.sh) edits on promotion — leave `newTag` empty/placeholder.
- [ ] Add the service name to [`scripts/ci/wait-for-argocd.sh`](../../scripts/ci/wait-for-argocd.sh) `APPS=(...)` **only if** the service is flight-critical (a broken instance must block the flight). Optional services stay off the list so they don't gate releases — see `proj.cicd-services-gitops.md` bug.0312 for the failure mode.

### Flight + validate

After CI green:

```bash
gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly \
  --ref <branch> \
  -f pr_number=<N>
```

[`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) resolves your new target via [`scripts/ci/resolve-pr-build-images.sh`](../../scripts/ci/resolve-pr-build-images.sh), writes the digest into `deploy/candidate-a-<name>` via [`scripts/ci/promote-build-payload.sh`](../../scripts/ci/promote-build-payload.sh), and waits for Argo + rollout-status + `/version.buildSha` agreement via [`scripts/ci/wait-for-argocd.sh`](../../scripts/ci/wait-for-argocd.sh) + [`scripts/ci/verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh).

Then run [`/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md) against `https://poly-test.cognidao.org` (or your service's ingress). Scorecard rows for Shape 1:

- `/livez` returns 200 from outside the cluster
- `/readyz` returns 200 from outside the cluster
- `/version.buildSha` matches your PR head SHA
- One real request observed in Loki at the deployed SHA

### Promote

- **Preview**: automatic via [`flight-preview.yml`](../../.github/workflows/flight-preview.yml) on push to `main` (re-tags `pr-{N}-{sha}` → `preview-{sha}`, dispatches [`promote-and-deploy.yml`](../../.github/workflows/promote-and-deploy.yml) with `environment=preview`). Preview overlay digest seeding for `main` is handled by [`promote-preview-digest-seed.yml`](../../.github/workflows/promote-preview-digest-seed.yml).
- **Production**: human-gated manual dispatch of [`promote-and-deploy.yml`](../../.github/workflows/promote-and-deploy.yml) with `environment=production` (bug.0361 — no PR-dance). See the [`/promote` skill](../../.claude/skills/promote/SKILL.md).

### Implementation detail — Node.js / TypeScript

If your service is TS/Node, the workspace + Dockerfile + tsup pattern from the legacy version of this guide still applies. Reference implementation: [`services/scheduler-worker/`](../../services/scheduler-worker/).

Critical TS rules (do not re-derive):

1. **Workspace** — Add `services/<name>/` package.json with `"name": "@cogni/<name>-service"`. Standalone `tsconfig.json` (not in root references).
2. **tsup transpile-only (`bundle: false`)** — ESM bundling breaks pino. Model B (transpile + node_modules copy) is the default.
3. **ESM `.js` extensions on relative imports** — `import { x } from "./y.js"` (TypeScript resolves `.js`→`.ts` at compile; Node needs `.js` at runtime).
4. **Config via Zod** — `src/config.ts` parses `process.env` and exits on failure; never use `process.env` in business code.
5. **Health via raw `node:http`** — no Fastify/Express for workers; see `src/health.ts` pattern in scheduler-worker.
6. **Graceful shutdown** — `SIGTERM` → `ready = false` (stops poll loop and routing) → drain → close DB → `exit 0`.
7. **Dockerfile** — multi-stage, pin pnpm to the root `packageManager` field, install `python3 make g++` in builder, run as non-root user, NO `HEALTHCHECK` instruction (probes belong to k8s manifests).

For implementations in Python or other languages, mirror the spirit: Zod-equivalent config validation, separate health port, signal-handled drain, multi-stage Docker, non-root.

See [Services Architecture Spec](../spec/services-architecture.md), [Health Probes Spec](../spec/health-probes.md).

### Anti-patterns

- ❌ Catalog entry pointing at a Dockerfile that doesn't produce a digest-stable image (timestamps, random IDs, `git rev-parse` baked into env vars at build time)
- ❌ `:latest` anywhere in deploy state — overlay `images:` `newTag` must be `pr-…`, `preview-…`, or `prod-…` (or a `sha-…` digest)
- ❌ `HEALTHCHECK` instruction in the Dockerfile — probes are orchestrator concerns
- ❌ Service in catalog but not in `wait-for-argocd.sh` while you treat it as critical — silent-success on broken flights
- ❌ Service in `wait-for-argocd.sh` while it's still in-flight / optional — broken optional service blocks all promotion
- ❌ Adding to Compose "for parity" — Compose is for upstream infra only; Shape 1 services are k8s-only

---

## Shape 2: Sibling Container in Existing Pod

A second container inside an existing pod's Deployment, patched in via a kustomize overlay. Shares network namespace and lifecycle with the host workload.

### When

- Workload **must** share network namespace with another pod (e.g. localhost IPC)
- Workload **must** share an emptyDir or other in-pod volume
- Workload **must** restart in lockstep with another pod (no independent rollout)

**Anti-cases:** needs its own `Service`/`Ingress` (Shape 1); benefits from independent scaling (Shape 1); just "easier to deploy alongside" (Shape 1 — that's not a justification).

**Precedent:** `poly-paper-sidecar`, codified on this branch by commits `377134f42` (drop `:latest`, pin via kustomize images block), `c18eed2da` (restore Dockerfile from PR 1 defer), `3ee5913f8` (pin to `sha-c18eed2`).

### Build pipeline

Sidecars **cannot** be cataloged — the catalog assumes 1 image = 1 overlay = 1 Argo app, and a sidecar shares the host's overlay/app. Use a standalone path-triggered build workflow:

- [ ] Source at `infra/images/<sidecar-name>/` with its own Dockerfile
- [ ] Standalone workflow at `.github/workflows/build-<sidecar-name>.yml` modeled on [`build-poly-paper-sidecar.yml`](../../.github/workflows/build-poly-paper-sidecar.yml):
  - Trigger on push to main + edits under `infra/images/<sidecar-name>/**`, plus `workflow_dispatch`
  - Tag `sha-<short>` always; **never** push `:latest` to a tag a deploy manifest references
  - Push to `ghcr.io/cogni-dao/<sidecar-name>`

### Deploy state

Patch the host pod's overlay (one per environment):

- [ ] In `infra/k8s/overlays/{candidate-a,preview,production}/<host-node>/kustomization.yaml`:
  - **`images:` block** — pin `newTag` to a specific `sha-<short>` (placeholder `sha-pending-first-build` is acceptable pre-first-build):
    ```yaml
    images:
      - name: ghcr.io/cogni-dao/<sidecar-name>
        newName: ghcr.io/cogni-dao/<sidecar-name>
        newTag: "sha-<short>"
    ```
  - **`patches:` block** — append container to the host Deployment:
    ```yaml
    patches:
      - target: { kind: Deployment, name: <host-node> }
        patch: |-
          - op: add
            path: /spec/template/spec/containers/-
            value:
              name: <sidecar-name>
              image: ghcr.io/cogni-dao/<sidecar-name>
              ports: [{ containerPort: <port>, name: <name> }]
              livenessProbe: { httpGet: { path: /healthz, port: <port> }, ... }
              readinessProbe: { httpGet: { path: /healthz, port: <port> }, ... }
              resources: { requests: { memory: 128Mi, cpu: 50m }, limits: { memory: 384Mi, cpu: 500m } }
    ```
  - Reference example: [`infra/k8s/overlays/candidate-a/poly/kustomization.yaml:13-28,96-132`](../../infra/k8s/overlays/candidate-a/poly/kustomization.yaml)

### Flight + validate

**Today there is no automated flight lever for sidecar images.** The current path:

1. Build workflow runs on push to main (or `workflow_dispatch`), producing `sha-<short>` in GHCR
2. Author manually bumps `newTag` in each environment overlay (one commit per environment)
3. Argo CD on the target env reconciles the host pod with the new sidecar tag

This is reproducible-from-git (every state is committed) but **manual**. The closest existing automated primitive is `argocd-image-updater`, which is installed but not wired for non-catalog images. See **Known Gaps**.

**Validate** via [`/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md) once the host pod's overlay has been bumped on `deploy/candidate-a-<host-node>`:

- Host pod `/livez` + `/readyz` still pass
- Sidecar container Ready in `kubectl describe pod`
- Sidecar HTTP probe responds from inside the pod
- One real request to the sidecar observed in Loki at the deployed SHA

### Promote

- **Preview**: bump `newTag` in `infra/k8s/overlays/preview/<host-node>/kustomization.yaml` on `main`. Push triggers `flight-preview.yml`. If only the sidecar tag changed (no host-image rebuild), the preview pipeline will see the overlay change via Argo but **will not** trigger an image-resolve/promote step — bump is the digest advance.
- **Production**: bump `newTag` in `infra/k8s/overlays/production/<host-node>/kustomization.yaml` on `main`; production overlay change is human-gated by the same merge gate as any prod overlay edit.

### Anti-patterns

- ❌ `:latest` in the overlay `images:` block — destroys reproducibility, masks rollouts
- ❌ Hand-editing the deploy branch overlay (`deploy/candidate-a-<host>`) directly instead of patching the `main` overlay — bypasses `single-domain-scope` and review
- ❌ Adding a sidecar to the catalog — schema-incompatible, gets you double-deployed and double-Argo-managed
- ❌ Sidecar without its own `livenessProbe`/`readinessProbe` — pod becomes Ready while sidecar is broken
- ❌ Adding a sidecar to a node pod from a poly-domain PR — overlay lives in `infra/` (operator domain); this is an operator-domain PR (cite [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) `single-node-scope`)

---

## Shape 3: MCP Server

There is **no separate playbook** — MCP servers slot into Shape 1 or Shape 2 based on transport.

### Decision

| Transport                                                              | Shape                         | Why                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| **HTTP** (streamable-http)                                             | Shape 1                       | Has its own port, own probes, own scaling; behaves like any HTTP service              |
| **SSE** (legacy MCP transport)                                         | Shape 1                       | Same as HTTP — its own port + endpoints                                               |
| **stdio** (spawned per request by consumer)                            | Shape 2                       | Must share pod with the consumer that spawns it; no useful health endpoint of its own |
| **Compose-only** (third-party MCP that doesn't ship a clean container) | Shape 4 — only under sign-off | Closed for net-new code we own                                                        |

For HTTP/SSE MCP, expose `/readyz` + `/livez` like any other Shape 1 service. For stdio MCP, the host pod's readiness gates everything; the sidecar's only contract is "process runs."

### Anti-patterns

- ❌ Hardcoded MCP port collisions across nodes — choose a port range under `9100-9199` for sidecar MCPs, declare in the catalog or overlay
- ❌ stdio MCP given an Ingress — no transport for it to serve
- ❌ MCP server with secrets baked into the image — secrets come via env from sealed-secrets or the env block in the overlay

---

## Shape 4: Compose-Stack Service (LEGACY — closed for net-new code we author)

A process declared in `infra/compose/runtime/docker-compose.yml`, deployed via [`scripts/ci/deploy-infra.sh`](../../scripts/ci/deploy-infra.sh) (rsync + `docker compose up`).

### When

Only valid for upstream third-party processes that already pre-date the k8s pipeline and would be high-effort to k8s-ify:

- **Existing legacy entries** (sanctioned): postgres, temporal, redis, alloy, caddy, litellm, doltgres, db-backup
- **Net-new additions** (require explicit sign-off): an upstream Docker-distributed process that we do not author, that has no usable Helm chart, and that we are not ready to operator-ify

**Hard reject** for any code we author. Use Shape 1.

### Procedure (only after sign-off)

- [ ] Add service definition to [`infra/compose/runtime/docker-compose.yml`](../../infra/compose/runtime/docker-compose.yml)
- [ ] If image needs local extension (e.g. `litellm` with custom callback), add Dockerfile under [`infra/images/<name>/`](../../infra/images/) and reference via `build.context`
- [ ] Wire env vars in [`docs/spec/environments.md`](../spec/environments.md)
- [ ] Verify [`scripts/ci/deploy-infra.sh`](../../scripts/ci/deploy-infra.sh) reconciles cleanly: rsync the new `infra/compose/**` + `docker compose up -d` must produce a healthy service from a freshly provisioned VM

### Flight + validate

- [ ] Use [`candidate-flight-infra.yml`](../../.github/workflows/candidate-flight-infra.yml) with `--ref <branch>` to flight `infra/compose/**` to candidate-a. This is the ONLY shape that uses this workflow.
- [ ] No automatic Argo loop, no `/version.buildSha`, no per-app rollout-status. Validation = `docker compose ps` healthy + external probe.

### Anti-patterns

- ❌ Adding a Compose service for code authored in this repo — Shape 1, no exceptions
- ❌ Image reference without explicit tag (`image: vendor/foo` instead of `image: vendor/foo:1.2.3`) — drift on every VM rebuild
- ❌ Compose service with no `healthcheck:` if downstream services use `depends_on: condition:` — silent dependency breakage
- ❌ `restart: always` masking a crash loop — use `restart: unless-stopped` + alerting

---

## Shape 5: Cron / One-Shot Job

### When

| Trigger                                   | Shape                          | Today's pattern                                                                                                              |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| One-shot at deploy time (migration, seed) | initContainer in node-app base | [`infra/k8s/base/node-app/deployment.yaml:32-54`](../../infra/k8s/base/node-app/deployment.yaml) (DB migrator initContainer) |
| Queued / event-triggered work             | Shape 1 worker                 | [`services/scheduler-worker/`](../../services/scheduler-worker/)                                                             |
| Periodic schedule (cron)                  | k8s `CronJob`                  | **GAP — no precedent.** See workaround below.                                                                                |

### Today's workaround for periodic work

No `infra/k8s/base/cronjob/` template exists. Until one lands (see Known Gaps), the only sanctioned options are:

1. **scheduler-worker handler** — register a periodic task in the Temporal-based scheduler; pure code change in `services/scheduler-worker/`, no new deploy shape needed. **Preferred** for any cron that's <1min, <30s runtime, and doesn't need its own resource limits.
2. **initContainer at startup** — for one-shot tasks at deploy time, not cron.
3. **Compose sidecar with sleep loop** — `db-backup` precedent. **Closed** for net-new code (Shape 4 reject).

### Anti-patterns

- ❌ Adding a `restart: always` Compose process with `while true; sleep 3600; do_thing` — that's not cron, that's a leaking process. Use scheduler-worker.
- ❌ Embedding cron logic inside a node app — gives it deploy-time coupling to a multi-replica app where exactly one replica should run the cron
- ❌ k8s `CronJob` without `concurrencyPolicy: Forbid` (or `Replace`) — overlapping runs corrupt state

---

## Cross-Cutting: Reproducibility Audit

**Pass criterion**: destroy the candidate-a VM, run [`scripts/setup/provision-test-vm.sh`](../../scripts/setup/provision-test-vm.sh), wait for Argo + the pipeline to reconcile. Your service must come back with **zero manual SSH steps**.

Walk this for each shape before opening the PR:

| Shape                              | Brought back by                                                                                                     | Audit fail signal                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Standalone k8s                  | Argo ApplicationSet reads catalog entry from `deploy/candidate-a-<name>` → applies overlay → image pulled by digest | Catalog entry missing from `deploy/candidate-a-*` branches → AppSet skips it                       |
| 2. Sibling container               | Host pod's Argo Application reads the host overlay (with sidecar patch) → reconciles                                | Overlay `images:` `newTag` left at placeholder → sidecar fails ImagePull                           |
| 3. MCP (HTTP/SSE)                  | Same as Shape 1                                                                                                     | Same as Shape 1                                                                                    |
| 3. MCP (stdio)                     | Same as Shape 2                                                                                                     | Same as Shape 2                                                                                    |
| 4. Compose (legacy)                | Re-run of [`candidate-flight-infra.yml`](../../.github/workflows/candidate-flight-infra.yml) with `--ref main`      | `infra/compose/**` references a build context that doesn't exist on main, or pulls a `:latest` tag |
| 5. Cron (scheduler-worker handler) | Same as Shape 1 (handler ships in scheduler-worker image)                                                           | Handler registration only in dev branch, not main                                                  |

**Hard fail**: if any step in your service's bring-up is "ssh in and run X." That is a bug in the PR, not a known operational quirk. Fix it before merge.

---

## Cross-Cutting: Observability + Health Hooks

Per [Health Probes Spec](../spec/health-probes.md):

| Endpoint   | Purpose                       | k8s probe        | Notes                                                                                                                                         |
| ---------- | ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/livez`   | Process alive, not deadlocked | `livenessProbe`  | Cheap. No DB.                                                                                                                                 |
| `/readyz`  | Ready to accept work          | `readinessProbe` | Set false during drain. Workers MUST gate their poll loop on this, not just HTTP routing.                                                     |
| `/version` | `{ buildSha, builtAt }`       | —                | **Required for Shape 1.** [`scripts/ci/verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) reads this to prove digest promotion landed. |

Pod security context (k8s shapes):

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

Logging:

- Structured JSON to stdout (Pino for Node, equivalent elsewhere)
- Alloy on the VM scrapes container logs → Loki
- Validate by self-lookup at `https://grafana.cognidao.org` after deploy, querying for your service's container name at the deployed buildSha

---

## Known Gaps + Follow-up Work

Each gap below has a minimum-viable follow-up. Mark a task when you hit one in the wild.

### Gap 1 — Sidecar image auto-advance via argocd-image-updater

**Today**: Shape 2 requires a manual `newTag` bump in each environment overlay after every sidecar build. argocd-image-updater is installed but not wired for non-catalog images.

**Fix**: add per-app annotations to the host node's Argo Application (candidate-a + preview) so argocd-image-updater watches the sidecar image and auto-bumps the `images:` block. Production stays manual.

**Effort**: one PR per host node, ~30 lines of annotation YAML.

### Gap 2 — Pre-merge flight for k8s overlay changes with no image rebuild

**Today**: refactoring a kustomize patch (resource limits, new initContainer, ExternalName Service) with no image rebuild has no automated flight lane. [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) requires a digest promotion; [`candidate-flight-infra.yml`](../../.github/workflows/candidate-flight-infra.yml) is Compose-only ([`deploy-infra.sh:26-28`](../../scripts/ci/deploy-infra.sh)). The only "flight" today is merge to main and watch Argo reconcile.

**Fix**: extend [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) to accept a "no-promote" mode that writes the overlay change to `deploy/candidate-a-<name>` without resolving image digests, then runs the same Argo + rollout + buildSha verification chain. Don't add a parallel workflow — `SCRIPTS_ARE_THE_API` (per [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md)) says extend the existing one.

**Effort**: one PR; mostly a new branch in [`scripts/ci/promote-build-payload.sh`](../../scripts/ci/promote-build-payload.sh) + a workflow input.

### Gap 3 — k8s CronJob base template

**Today**: no `infra/k8s/base/cronjob/` template, no catalog `type: cron` shape, no Argo example.

**Fix**: add `infra/k8s/base/cronjob/` with a parametric `CronJob` + `kustomization.yaml`. Decide whether cron jobs get their own catalog entry (`type: cron`, no per-env deploy branches — they're driven from the host node's overlay) or live as overlay patches like sidecars. Lean toward the latter for first version — fewer moving parts.

**Effort**: one PR; first real CronJob use case will tune the abstraction.

### Gap 4 — MCP server precedent

**Today**: no MCP server runs in the deployed stack. Shape 3 is a forward-looking decision tree without a live reference.

**Fix**: once we ship the first MCP server, link it as the canonical example from Shape 3 and capture any hardening lessons (port allocation, secrets handling, MCP-side auth).

**Effort**: write-up only; ride alongside the first MCP service PR.

### Gap 5 — Single-domain scope for shared overlay edits

**Today**: a Shape 2 sidecar that exists "for poly" still lives at `infra/k8s/overlays/<env>/poly/` and `infra/images/poly-paper-sidecar/` — both operator-domain paths per [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) `single-node-scope`. So a sidecar PR cannot be authored as a poly-domain PR even when the workload is exclusively poly's.

**Fix**: long-term, support `nodes/<node>/services/<name>/` and `nodes/<node>/infra/overlays/` as node-domain paths the catalog/AppSet pick up. Short-term, file sidecar work as operator-domain PRs and accept the scope split.

**Effort**: large; not blocking, but call it out when the substrate-request signal accumulates.

---

## Related

- [Services Architecture Spec](../spec/services-architecture.md) — invariants, import boundaries, structure contracts
- [Health Probes Spec](../spec/health-probes.md) — liveness vs readiness, drain semantics
- [Multi-Node Dev Guide](./multi-node-dev.md) — local stack, per-node DB, dev commands
- [Node ↔ Operator Contract](../spec/node-operator-contract.md) — DEPLOY_INDEPENDENCE, STATELESS_CONTAINERS, HEALTH_ENDPOINTS_REQUIRED
- [Node CI/CD Contract](../spec/node-ci-cd-contract.md) — BUILD_ONCE_PROMOTE_DIGEST, SINGLE_DOMAIN_HARD_FAIL, SCRIPTS_ARE_THE_API
- [Candidate Flight V0 Guide](./candidate-flight-v0.md) — flighting a PR to candidate-a
- [`/validate-candidate` skill](../../.claude/skills/validate-candidate/SKILL.md) — post-flight verification scorecard
- [`/promote` skill](../../.claude/skills/promote/SKILL.md) — preview / production promotion playbook
- [CI/CD & Services GitOps Project](../../work/projects/proj.cicd-services-gitops.md) — pipeline roadmap + active blockers
