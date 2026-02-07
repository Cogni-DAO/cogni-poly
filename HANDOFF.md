# Handoff: System Integration Testing via Mock-LLM

## Goal

Replace `FakeLlmAdapter` (in-process fake) with a real LiteLLM proxy backed by `mock-openai-api` (deterministic, no model weights). Stack tests exercise the full LLM→LiteLLM→mock path. Design spec: `docs/SYSTEM_TEST_ARCHITECTURE.md`.

## Status: ~80% done, stack tests broken (13/33 failing)

### What's done

- `FakeLlmAdapter` deleted (`src/adapters/test/ai/fake-llm.adapter.ts`, its unit test, barrel export)
- `container.ts` always wires `LiteLlmAdapter` (no more `isTestMode` branch for LLM)
- `invariants.ts` requires `LITELLM_MASTER_KEY` in all environments
- `mock-llm` service added to `docker-compose.dev.yml` on `cogni-edge` network
- LiteLLM volume mount parameterized: `./configs/${LITELLM_CONFIG:-litellm.config.yaml}:/app/config.yaml:ro`
- Test LiteLLM config created: `platform/infra/services/runtime/configs/litellm.test.config.yaml`
- `.env.test` and `.env.test.example` updated with `LITELLM_CONFIG=litellm.test.config.yaml`
- `package.json` `dev:infra:test` script updated to include `mock-llm`
- CI workflow updated: `LITELLM_CONFIG` env var + `mock-llm` in compose up
- Arch probes, AGENTS.md files, test guard messages, docs all updated
- `pnpm check` passes (typecheck, lint, format, arch, unit tests, docs)

### What's broken

**13 stack test files fail** when running `pnpm test:stack:docker` (or `test:stack:dev`). Root cause: **model name mismatch**.

The test config (`litellm.test.config.yaml`) only registers one model: `mock-local`. But stack tests send model names like:

- `"test-model"` (from `TEST_MODEL_ID` in `tests/_fakes/ai/test-constants.ts`)
- Dynamic model from `/api/v1/ai/models` endpoint (which reads the LiteLLM config catalog)

LiteLLM rejects unknown model names. You need to either:

1. Add entries in `litellm.test.config.yaml` that match the models tests actually send (e.g., `test-model`), OR
2. Update `TEST_MODEL_ID` to `"mock-local"` and adjust tests that dynamically pick from the models endpoint

Additionally, tests that previously asserted on `FakeLlmAdapter`'s fixed response shape (e.g., `providerCostUsd: 0.0001`, `usage: { promptTokens: 10, ... }`, `litellmCallId: "fake-litellm-call-id"`) will now get different values from `mock-openai-api` via LiteLLM. These assertions need loosening or updating to match the real response shape.

There may also be other issues once model routing works — you need to actually run the stack tests and iterate on failures.

### What's NOT done (from original plan)

- Fix all 13 failing stack test files
- Verify `dev:stack:test` actually launches mock-llm and routes correctly
- Investigate the ZDR config test (`zdr-config.stack.test.ts`) which checks for production model names that won't exist in the test config
- The `chat-streaming` tests fetch `defaultPreferredModelId` from the models endpoint — that will return `mock-local` now, which may or may not work

## Key Files

| File                                                               | Role                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `docs/SYSTEM_TEST_ARCHITECTURE.md`                                 | Design spec (source of truth)                                        |
| `platform/infra/services/runtime/configs/litellm.test.config.yaml` | **NEW** — test LiteLLM config (needs model entries added)            |
| `platform/infra/services/runtime/configs/litellm.config.yaml`      | Production LiteLLM config (reference for model names)                |
| `platform/infra/services/runtime/docker-compose.dev.yml`           | `mock-llm` service + parameterized litellm config                    |
| `src/bootstrap/container.ts`                                       | DI container — `LiteLlmAdapter` always wired                         |
| `src/adapters/server/ai/litellm.adapter.ts`                        | The real adapter that calls LiteLLM HTTP API                         |
| `tests/_fakes/ai/test-constants.ts`                                | `TEST_MODEL_ID = "test-model"` — must match litellm test config      |
| `tests/_fakes/ai/request-builders.ts`                              | `createCompletionRequest` / `createChatRequest` — uses TEST_MODEL_ID |
| `.env.test`                                                        | `LITELLM_CONFIG=litellm.test.config.yaml`                            |
| `package.json:28`                                                  | `dev:infra:test` script — launches mock-llm                          |

## How to reproduce failures

```bash
pnpm docker:test:stack:fast   # Start containerized test stack
pnpm docker:test:stack:setup  # Provision + migrate DB
pnpm test:stack:docker        # Run stack tests → see 13 failures
```

Or host-mode:

```bash
pnpm dev:stack:test           # Start infra + next dev
pnpm test:stack:dev           # Run stack tests
```

## Important context

- `FakeLlmService` in `tests/_fakes/ai/fake-llm.service.ts` is **untouched** — it's a unit test double, not the container adapter
- Other test fakes (EVM, metrics, web-search, repo) are **untouched** — only LLM wiring changed
- The `mock-openai-api` image (`zerob13/mock-openai-api:latest`) returns canned OpenAI-compatible responses — check what it actually returns by curling `http://localhost:3000/v1/chat/completions` (or read its docs)
- Branch: `refactor/docs-final`
