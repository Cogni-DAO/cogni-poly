---
id: create-service-guide
type: guide
title: Create a New Service
status: draft
trust: draft
summary: v0 plan + executable playbook for adding a new deployable service (k8s deployment, sibling container, MCP, Compose, cron) and shipping it through candidate-a → preview → production.
read_when: Adding any new service, sidecar, MCP server, cron job, or Compose process to the deployed stack.
owner: derekg1729
created: 2026-02-06
verified: 2026-05-16
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

```
Does the workload have meaningfully independent lifecycle from any existing pod?
│
├─ Yes (or unsure)
│  ├─ Is it an HTTP/SSE MCP server?           → SHAPE 1
│  └─ Anything else with its own restart      → SHAPE 1  (DEFAULT)
│
├─ Must share network namespace, in-pod volume, or restart in lockstep
│  ├─ stdio MCP spawned by host pod           → SHAPE 2
│  └─ Sibling container                        → SHAPE 2
│
├─ Upstream third-party with no usable k8s path + already pinned image
│                                              → SHAPE 4  (LEGACY — sign-off)
│
└─ Periodic / one-shot
   ├─ One-shot at deploy time (migration)     → initContainer in node-app base
   ├─ Triggered / queued                       → SHAPE 1 worker (scheduler-worker)
   └─ Periodic (cron)                          → SHAPE 5  (gap; workaround inside)
```

**Hard rules** (reject in code review):

- `:latest` in any new manifest — tag by SHA only (existing `sandbox-openclaw` debt is tracked separately, do not replicate)
- Manual VM SSH as part of any deploy — every change lands in git
- Compose service for code we author — Shape 1 instead
- Sibling container when it could be standalone — Shape 1 instead

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

## Shape 1: Standalone k8s Deployment (DEFAULT)

A pod with its own Deployment, Service, optional Ingress, and per-env deploy branch. Fully integrated with the pipeline.

**Precedent**: [`services/scheduler-worker/`](../../services/scheduler-worker/) — every reference below is to this implementation.

### Files to create / edit

**One PR. Operator-domain** ([`single-node-scope`](../spec/node-ci-cd-contract.md)).

- [ ] `services/<name>/` (TS) or `infra/images/<name>/` (Python/polyglot) — source + `Dockerfile`
- [ ] `infra/catalog/<name>.yaml` — validated by [`_schema.json`](../../infra/catalog/_schema.json), model on [`scheduler-worker.yaml`](../../infra/catalog/scheduler-worker.yaml):
  ```yaml
  name: <name> # must match filename; ^[a-z][a-z0-9-]*$
  type: service # "node" only for full top-level node app (then node_id required)
  port: 9000
  dockerfile: services/<name>/Dockerfile # or infra/images/<name>/Dockerfile
  image_tag_suffix: "-<name>"
  migrator_tag_suffix: "-<name>-migrate" # alias; no-op for services without per-node migrator
  path_prefix: services/<name>/ # MUST end with /
  candidate_a_branch: deploy/candidate-a-<name>
  preview_branch: deploy/preview-<name>
  production_branch: deploy/production-<name>
  ```
- [ ] `infra/k8s/base/<name>/{deployment,service,kustomization}.yaml` — reference [`infra/k8s/base/scheduler-worker/`](../../infra/k8s/base/scheduler-worker/) (worker) or [`infra/k8s/base/node-app/`](../../infra/k8s/base/node-app/) (HTTP)
- [ ] `infra/k8s/overlays/{candidate-a,preview,production}/<name>/kustomization.yaml` — overlay's `images:` block uses `newTag: "<env>-placeholder-<name>"` or `digest: "sha256:..."`; [`promote-k8s-image.sh`](../../scripts/ci/promote-k8s-image.sh) handles either
- [ ] **`infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml`** — add a generator block in each. **This is the silent killer**: skip it and the catalog entry + overlay exist on disk but no Argo Application materializes. Pattern:
  ```yaml
  - git:
      repoURL: https://github.com/cogni-dao/cogni-poly.git
      revision: deploy/<env>-<name>
      files:
        - path: "infra/catalog/<name>.yaml"
  ```

### Deploy branch bootstrap (chicken-and-egg)

The AppSet generator's `revision: deploy/<env>-<name>` errors on first reconcile if the branch doesn't exist. Two viable orderings:

- **Preferred** — split into two PRs:
  1. PR1 adds catalog + base + overlay; after merge, run `git push origin main:deploy/candidate-a-<name> main:deploy/preview-<name> main:deploy/production-<name>` to seed the deploy branches
  2. PR2 wires the AppSet generators (Argo's reconcile now finds the branches)
- **One-shot** — single PR with explicit post-merge admin step in the PR body: "after merge, push the three deploy branches from `main` HEAD."

Pick one and stick to it for the PR.

### Flight phase 3 → 5 mechanics

- **Flight to candidate-a**: [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) resolves digests via [`resolve-pr-build-images.sh`](../../scripts/ci/resolve-pr-build-images.sh), writes them into `deploy/candidate-a-<name>` via [`promote-build-payload.sh`](../../scripts/ci/promote-build-payload.sh), then [`wait-for-argocd.sh`](../../scripts/ci/wait-for-argocd.sh) + [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) block until Argo + rollout + `/version.buildSha` agree. `PROMOTED_APPS` is dynamic — there is **no** manual `APPS=(...)` list to maintain. If a service shouldn't gate flights, don't put it in the catalog.
- **Auto-preview on merge**: [`flight-preview.yml`](../../.github/workflows/flight-preview.yml) re-tags `pr-{N}-{sha}` → `preview-{sha}` and dispatches `promote-and-deploy.yml`. [`promote-preview-digest-seed.yml`](../../.github/workflows/promote-preview-digest-seed.yml) handles preview overlay digest seeding on `main`.
- **Manual prod**: see Phase 5 in the pipeline table above.

### Validate

`/validate-candidate` scorecard rows:

- `/livez` 200 from outside the cluster
- `/readyz` 200 from outside the cluster
- `/version.buildSha` matches PR head SHA
- One real request observed in Loki at the deployed SHA

---

## Shape 2: Sibling Container in Existing Pod

A second container in an existing pod's Deployment, patched in via the host's overlay. Shares network namespace and lifecycle with the host.

**Precedent**: `poly-paper-sidecar`. Canonical pattern is commit `ce9e5fc66` ("canonical Shape 2 sidecar pinning"). The journey there: `377134f42` (`newTag:` in `images:` block — broken by first-newTag-wins) → `a391d026c` (inline-pin in container patch — works but harder to argocd-image-updater) → `ce9e5fc66` (**`digest:` in `images:` block for both host + sidecar; bare `image:` in container patch** — works AND is image-updater-friendly).

### When

Sibling is justified when the workload **must** share network namespace (localhost IPC), an in-pod volume, or restart in lockstep with the host. Anything else → Shape 1.

### Files to create / edit

**One PR. Operator-domain** (overlay paths live under `infra/`).

- [ ] `infra/images/<sidecar-name>/Dockerfile` + source
- [ ] `.github/workflows/build-<sidecar-name>.yml` — model on [`build-poly-paper-sidecar.yml`](../../.github/workflows/build-poly-paper-sidecar.yml):
  - Path-triggered on `infra/images/<sidecar-name>/**` + `workflow_dispatch`
  - Tag `sha-<short>` always
  - **Do not** push `:latest` to a tag any deploy manifest references
- [ ] `infra/k8s/overlays/{candidate-a,preview,production}/<host-node>/kustomization.yaml` — add the sidecar's digest to the `images:` block (alongside the host's), and add a bare-`image:` container patch. Reference: [`infra/k8s/overlays/candidate-a/poly/kustomization.yaml`](../../infra/k8s/overlays/candidate-a/poly/kustomization.yaml).
  ```yaml
  images:
    - name: ghcr.io/cogni-dao/cogni-poly                    # host (already there)
      newName: ghcr.io/cogni-dao/cogni-poly
      digest: "sha256:<host-digest>"
    - name: ghcr.io/cogni-dao/<sidecar-name>                # add this block
      newName: ghcr.io/cogni-dao/<sidecar-name>
      digest: "sha256:<sidecar-digest>"                     # bump after each new build

  patches:
    - target: { kind: Deployment, name: <host-deployment> }
      patch: |
        - op: add
          path: /spec/template/spec/containers/-
          value:
            name: <sidecar-name>
            image: ghcr.io/cogni-dao/<sidecar-name>           # bare — kustomize substitutes from images: block
            ports: [{ containerPort: <port>, name: <port-name>, protocol: TCP }]
            livenessProbe:  { httpGet: { path: /healthz, port: <port-name> }, initialDelaySeconds: 5, periodSeconds: 30 }
            readinessProbe: { httpGet: { path: /healthz, port: <port-name> }, initialDelaySeconds: 3, periodSeconds: 10 }
            resources:
              requests: { memory: 128Mi, cpu: 50m }
              limits:   { memory: 384Mi, cpu: 500m }
  ```
- [ ] If host needs to call the sidecar, add `<NAME>_URL: http://localhost:<port>` (or equivalent) via a separate ConfigMap patch in the same overlay.

### The digest-only rule (sidesteps the first-newTag-wins bug)

**Both host and sidecar entries in `images:` MUST use `digest:`, never `newTag:`.** Reason: [`promote-k8s-image.sh:77-81`](../../scripts/ci/promote-k8s-image.sh) is image-name-blind. Its branches:

```bash
if grep -q 'newTag:'  → rewrites the FIRST newTag: in the file (clobbers wrong slot if a sidecar uses newTag:)
elif grep -q 'digest:' → rewrites the FIRST digest:  in the file (= host app, correctly)
```

If both entries use `digest:`, the `newTag:` branch never fires, the elif branch targets the first `digest:` (host), and the sidecar's `digest:` is never touched by host promotion. Sidecar digest bumps are manual edits to that block. Fixing the script to be image-name-aware is a follow-up that would let this become single-form `newTag:` for everyone.

### Production overlay decision

Decide explicitly whether the sidecar runs in production. The paper-trading sidecar deliberately does **not** ship to prod (enforces `mode=paper` — wrong in prod). Omit the patch from `infra/k8s/overlays/production/<host-node>/kustomization.yaml` if so.

### Flight phase 3 (pre-merge candidate-a)

Sidecar-only PRs **can** flight pre-merge via standard `candidate-flight.yml`. Mechanism: [`detect-affected.sh:155`](../../scripts/ci/detect-affected.sh) lights up `<host-node>` when its overlay changes; [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) rsyncs the PR overlay onto `deploy/candidate-a-<host-node>` before promotion; the snapshot-and-restore step preserves the host digest while the sidecar's `digest:` entry advances.

Procedure:

1. Push the branch — `build-<sidecar-name>.yml` builds + pushes `sha-<short>` to GHCR. Resolve the resulting digest: `docker buildx imagetools inspect ghcr.io/cogni-dao/<sidecar-name>:sha-<short> --format '{{.Manifest.Digest}}'`
2. Bump the sidecar's `digest: "sha256:..."` in `infra/k8s/overlays/candidate-a/<host-node>/kustomization.yaml`'s `images:` block → commit, push
3. `gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <branch> -f pr_number=<N>`
4. `/validate-candidate`

**Wart**: this rebuilds the host image even though only the overlay changed. Wasted compute, correct behavior. Tracked as a CI gap.

### Flight phase 4 → 5 (post-merge promote)

- **Preview**: bump the sidecar's `digest:` in `infra/k8s/overlays/preview/<host-node>/kustomization.yaml`'s `images:` block on `main`. Push triggers `flight-preview.yml`. Since only the sidecar digest changed, no host-image promote step runs — the `digest:` edit IS the advance.
- **Production**: same on `infra/k8s/overlays/production/<host-node>/kustomization.yaml`. Production overlay edits are human-gated by the standard merge gate.

### Validate

`/validate-candidate` scorecard rows for Shape 2:

- Host pod `/livez` + `/readyz` still pass at the deployed SHA
- Sidecar Ready in `kubectl describe pod`
- `kubectl exec <host-pod> -c <sidecar-name> -- wget -qO- localhost:<port>/healthz` returns 200
- One real request to the sidecar observed in Loki at the deployed sidecar SHA

---

## Shape 3: MCP Server

No separate playbook — slot into Shape 1 or Shape 2 by transport.

| Transport                   | Shape              | Why                               |
| --------------------------- | ------------------ | --------------------------------- |
| HTTP / SSE                  | Shape 1            | Own port, own probes, own scaling |
| stdio (spawned by consumer) | Shape 2            | Must share pod with the consumer  |
| Compose-only third-party    | Shape 4 (sign-off) | Closed for code we author         |

HTTP/SSE MCP exposes `/livez` + `/readyz` like any Shape 1 service. stdio MCP rides the host pod's readiness.

---

## Shape 4: Compose-Stack Service (LEGACY — closed for new code we author)

Process in `infra/compose/runtime/docker-compose.yml`, deployed via [`candidate-flight-infra.yml`](../../.github/workflows/candidate-flight-infra.yml) → [`deploy-infra.sh`](../../scripts/ci/deploy-infra.sh).

**Valid only for**: upstream third-party processes already pre-dating the k8s pipeline (postgres, temporal, redis, alloy, caddy, litellm, doltgres, db-backup). Net-new additions require explicit sign-off.

**Procedure** (after sign-off):

- Add definition to [`infra/compose/runtime/docker-compose.yml`](../../infra/compose/runtime/docker-compose.yml) with **explicit image tag** (never bare `image: vendor/foo`)
- If local extension needed (e.g. `litellm` custom callback), add Dockerfile under [`infra/images/<name>/`](../../infra/images/)
- Document env vars in [`docs/spec/environments.md`](../spec/environments.md)
- Flight: `gh workflow run candidate-flight-infra.yml -R Cogni-DAO/cogni-poly --ref <branch>`
- Verify: `docker compose ps` healthy + external probe (no Argo, no `/version.buildSha`, no rollout-status)

---

## Shape 5: Cron / One-Shot Job

| Trigger                 | Shape                          | Today                                                                                                      |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| One-shot at deploy time | initContainer in node-app base | [`infra/k8s/base/node-app/deployment.yaml`](../../infra/k8s/base/node-app/deployment.yaml) (migrator init) |
| Triggered / queued      | Shape 1 worker                 | [`services/scheduler-worker/`](../../services/scheduler-worker/)                                           |
| Periodic schedule       | k8s `CronJob`                  | **GAP — no precedent.** Use scheduler-worker handler as workaround.                                        |

**Workaround for periodic work**: register the task as a periodic handler in [`services/scheduler-worker/`](../../services/scheduler-worker/). Pure Shape 1 code change. If you ever need a true `CronJob` (heavy resource isolation, distinct image), file a follow-up to add `infra/k8s/base/cronjob/`.

---

## Universal Invariants

These apply across shapes. Failures here cause silent deploy issues that the pipeline does not catch.

### Health probes

| Endpoint   | Purpose                       | k8s probe                                                                                    |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `/livez`   | Process alive, not deadlocked | `livenessProbe` (cheap, no DB)                                                               |
| `/readyz`  | Ready to accept work          | `readinessProbe` (set false during drain)                                                    |
| `/version` | `{ buildSha, builtAt }`       | — required for Shape 1; [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) reads it |

**Health probes belong in k8s manifests, NOT in the Dockerfile.** No `HEALTHCHECK` instruction — it bakes probe logic into the image and prevents orchestrator-specific tuning.

### Worker drain semantics (Shape 1 workers + Shape 5 handlers)

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

- Sibling container with `newTag:` in `images:` block (Shape 2 digest-only rule — clobbers host slot via first-newTag-wins)
- Catalog entry without a matching AppSet generator block (silent: pipeline goes green, service never deploys)
- Sidecar without its own `livenessProbe`/`readinessProbe` (host pod becomes Ready while sidecar is broken)
- Hand-editing `deploy/<env>-<name>` directly instead of patching the `main` overlay (bypasses review + single-domain-scope)
- Adding to the catalog a service that should not gate flights — drop it from the catalog instead

Compose / legacy:

- Compose service for code we author (Shape 1, no exceptions)
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

| Shape                | Forward                                                                                              | Rollback                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Standalone k8s    | `gh workflow run promote-and-deploy.yml -f environment=<env> -f source_sha=<new> -f build_sha=<new>` | Same workflow with the prior `source_sha` — look up via `git log deploy/<env>-<name> --oneline` or `.promote-state/source-sha-by-app.json` |
| 2. Sibling container | Edit sidecar `digest:` in `images:` block on `main`'s overlay → reconcile                            | `git revert <overlay-commit>` on `main` (preview auto-reconciles; candidate-a re-flight on a revert branch)                                |
| 4. Compose           | `candidate-flight-infra` / `promote-and-deploy` with new `infra/compose/**`                          | Same workflow with `--ref <older-sha>`                                                                                                     |
| 5. Cron handler      | Standard Shape 1 rollback                                                                            | Same. For "stop the cron immediately" without a redeploy, document a runtime feature-flag at handler creation.                             |

For new services, "rollback = remove" — see Deprecation in [Services Architecture Spec](../spec/services-architecture.md) or run the Shape 1 steps in reverse (empty deploy state → remove AppSet generator → remove catalog → delete deploy branches → remove source).

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
