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

**Precedent**: [`services/scheduler-worker/`](../../services/scheduler-worker/) — every reference below is to this implementation. **Sub-case — HTTP/SSE MCP server**: this is Shape A. Own port, own probes, own scaling.

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

### Deploy branch bootstrap (chicken-and-egg)

The AppSet generator's `revision: deploy/<env>-<name>` errors on first reconcile if the branch doesn't exist. After merge, run `git push origin main:deploy/candidate-a-<name> main:deploy/preview-<name> main:deploy/production-<name>` to seed the three deploy branches. Document this in the PR body.

### Flight phase 3 → 5 mechanics

- **Flight to candidate-a**: [`candidate-flight.yml`](../../.github/workflows/candidate-flight.yml) resolves digests via [`resolve-pr-build-images.sh`](../../scripts/ci/resolve-pr-build-images.sh), writes them into `deploy/candidate-a-<name>` via [`promote-build-payload.sh`](../../scripts/ci/promote-build-payload.sh) (per-image, iterating `images_for_deploy_unit`), then [`wait-for-argocd.sh`](../../scripts/ci/wait-for-argocd.sh) + [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) block until Argo + rollout + `/version.buildSha` agree.
- **Auto-preview on merge**: [`flight-preview.yml`](../../.github/workflows/flight-preview.yml) re-tags `pr-{N}-{sha}` → `preview-{sha}` per image and dispatches `promote-and-deploy.yml`.
- **Manual prod**: see Phase 5 in the pipeline table above.

### Validate

`/validate-candidate` scorecard rows:

- `/livez` 200 from outside the cluster
- `/readyz` 200 from outside the cluster
- `/version.buildSha` matches PR head SHA
- One real request observed in Loki at the deployed SHA

---

## Shape B: New Image on an Existing Deploy Unit

A new sidecar, migrator, or stdio MCP that ships **inside an existing deploy unit's pod**. Catalog v2 makes this a one-line edit — no parallel build workflow, no manual digest dance.

**Precedent**: `poly-paper-sidecar` (catalog file [`infra/catalog/poly.yaml`](../../infra/catalog/poly.yaml)). The first-newTag-wins / `digest:`-only-rule workaround from v1 is retired — `promote-k8s-image.sh` is now image-name-aware ([Layer 4d](../spec/catalog-v2.md)).

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
- [ ] Add an entry to the host's catalog file's `images:[]`:

  ```yaml
  # infra/catalog/<host>.yaml
  images:
    - name: <host>          # existing role:app entry — don't touch
      role: app
      ...
    - name: <host>-<sub>    # new — repo-wide unique
      role: sidecar          # or "migrator"
      dockerfile: nodes/<host>/sidecars/<sub>/Dockerfile
      image_name: ghcr.io/cogni-dao/<host>-<sub>   # own GHCR repo, OR shared with suffix
      image_tag_suffix: ""                          # empty when image_name is unique
      path_prefix: nodes/<host>/sidecars/<sub>/
      build:
        context: nodes/<host>/sidecars/<sub>
        target: base                                # optional --target
        test_target: test                           # optional pre-push smoke (no --push)
  ```

- [ ] Add an entry to the host's overlay's `images:` block (per env where the image should run). Example for poly + a hypothetical sidecar:

  ```yaml
  # infra/k8s/overlays/<env>/poly/kustomization.yaml
  images:
    - name: ghcr.io/cogni-dao/cogni-poly # host app's image_name (from catalog) — already there
      newName: ghcr.io/cogni-dao/cogni-poly
      digest: "sha256:..."
    - name: ghcr.io/cogni-dao/poly-<sub> # new sidecar — must match catalog images[].image_name
      newName: ghcr.io/cogni-dao/poly-<sub>
      newTag: "<env>-placeholder-poly-<sub>" # placeholder; promote-k8s-image overwrites
  ```

  `promote-build-payload.sh` rewrites BOTH entries on flight — host and sidecar are independent because `promote-k8s-image.sh` matches by `name:`. **The overlay `images[]` entry MUST exist before the first promote** — otherwise `promote-k8s-image` returns exit-2 (legitimate skip, no overlay write), and the deploy unit's `promoted_apps` excludes that image. Add the entry as a placeholder in the same PR that adds the catalog `images[]` entry.

- [ ] If sidecar: add a container patch to inject the second container in the host's Deployment. Reference: [`infra/k8s/overlays/candidate-a/poly/kustomization.yaml`](../../infra/k8s/overlays/candidate-a/poly/kustomization.yaml).
- [ ] If host needs to call the sidecar, add `<NAME>_URL: http://localhost:<port>` via a ConfigMap patch in the same overlay.

### Production overlay decision

Decide explicitly whether the image runs in production. The paper-trading sidecar deliberately does **not** ship to prod — its overlay simply omits the `images:` entry for the sidecar. `promote-build-payload.sh` exits-2 (legitimate skip, not error) when there's no matching `images:` entry; the deploy unit's `promoted_apps` still reflects the apps that actually wrote.

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

| Endpoint   | Purpose                       | k8s probe                                                                                    |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `/livez`   | Process alive, not deadlocked | `livenessProbe` (cheap, no DB)                                                               |
| `/readyz`  | Ready to accept work          | `readinessProbe` (set false during drain)                                                    |
| `/version` | `{ buildSha, builtAt }`       | — required for Shape A; [`verify-buildsha.sh`](../../scripts/ci/verify-buildsha.sh) reads it |

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
