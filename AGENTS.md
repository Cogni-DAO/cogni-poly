# AGENTS.md — Cogni-Poly

> Repo-wide orientation. Subdir `AGENTS.md` extends; closest file wins ([agents.md spec](https://agents.md/)). Each `nodes/<node>/AGENTS.md` defines that node's rules — read it once you know your scope.

You are an agent inside a multi-agent system. This repo (`cogni-poly`) owns its own work items + flight pipeline; the upstream **operator** at `https://cognidao.org` remains the cross-node visibility layer but is not on this repo's critical path. Whether you run hosted or as a Claude Code / Conductor session on a human's laptop, the contract is the same.

## Required Loop

1. Adopt one work item, **one node** (`single-node-scope` is a CI gate; cross-node ⇒ separate item). Read `nodes/<node>/AGENTS.md` for that node's rules.
2. Work items live at this repo's own API: `https://poly.cognidao.org/api/v1/work/items` (full CRUD: GET list, POST create, GET/PATCH/DELETE by id). Coordination sub-routes (claims/heartbeat/pr/coordination) are not yet wired in cogni-poly — track session state via PR description + work item PATCHes for now.
3. Implement on a worktree branch. Push — **CI is your verification.** Watch `gh pr checks`; iterate file-scoped fixes if red.
4. After CI green + reviewed implementation, dispatch the candidate-flight workflow directly (no operator-mediated path exists for this repo): `gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <branch> -f pr_number=<N>`. The build lands at `https://poly-test.cognidao.org`.
5. Run [`/validate-candidate`](.claude/skills/validate-candidate/SKILL.md) against the deployed build. Adherence to its validation flow and scorecard format is strict — that's how the system confirms you followed the contract.
6. Hit a contract blocker (auth, broken endpoint, invariant you can't satisfy)? File a bug against this repo's API: `POST https://poly.cognidao.org/api/v1/work/items {type:'bug', node:'poly'}`, link from your active item.

> Bearer token: `$COGNI_API_KEY_PROD` from `.env.cogni` (poly-scoped). If missing, register against the poly node and save the result back: `curl -X POST https://poly.cognidao.org/api/v1/agent/register -H 'content-type: application/json' -d '{"name":"<agent>"}'` returns `{apiKey, userId, billingAccountId}` — write those as `COGNI_API_KEY_PROD` / `COGNI_USER_ID_PROD` / `COGNI_BILLING_ACCOUNT_PROD`. Full lifecycle: [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md).

## Definition of Done

`status: done` ⇔ code merged. **Code only merges after both**:

1. Full green: reviewed implementation + CI green on the PR.
2. `deploy_verified: true` — flighted to candidate-a, `/validate-candidate` scorecard posted, your own request observed in Loki at the deployed SHA.

Two named human stops: `needs_review` post-`/design`, `needs_human_qa` post-flight. Drive yourself between them.

## Principles

- **Reuse + reproducibility.** Find existing code (this repo or OSS) that meets your need before writing new. When you do code, code for reuse. For deployments, reproducibility is non-negotiable — no ad-hoc actions; solve each problem once and capture it in git.
- **Search before designing.** `docs/spec/`, `docs/guides/`, `.claude/skills/`, `.claude/commands/`, and this repo's own API at `https://poly.cognidao.org` (work items + knowledge) hold prior thinking, designs, and priorities. Refine + simplify + clean what exists rather than add parallel artifacts.
- **Goal-driven execution.** Up front, with the user, identify the before/after I/O that will be clearly testable by a human or an agent. Before closing the work item, you must be able to prove the starting goal is met.
- **Clean architecture.** Hexagonal layering. Strongly-typed boundaries (Zod). Systemic observability (Pino → Loki). Idempotent operations. Strict typing — no `any`.
- **Purge legacy.** Backwards-compat shims are debt unless the user explicitly asks for them.
- **Clarity, conciseness, syntropy.** Code and prose alike — fewer words, sharper meaning, aligned with what already exists. Entropy creeps in through volume.

## Anti-patterns

- Adding backwards-compatibility unless specifically user-instructed. Purge legacy in place.
- Inline comments narrating _what_ code does, or verbose prose. More text, more entropy — names + types are the docs.
- Ending a turn before `deploy_verified` without an armed `Monitor`/`ScheduleWakeup` on the gating signal (CI, flight, `/version`). Silent end-of-turn = work lost.

## Pointers

- [Development Lifecycle](docs/spec/development-lifecycle.md) · [CI/CD](docs/spec/ci-cd.md) · [Agent-First API Validation](docs/guides/agent-api-validation.md) · [`/validate-candidate`](.claude/skills/validate-candidate/SKILL.md)
- [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) — registration + executable contributor contract
- [Architecture](docs/spec/architecture.md) · [Style](docs/spec/style.md) · [Common Mistakes](docs/guides/common-mistakes.md) · [Work Management](work/README.md)
- **Stuck?** File a bug against this repo's work-items API (step 6 above), or read [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) end-to-end.
