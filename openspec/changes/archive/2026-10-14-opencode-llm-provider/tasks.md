# Tasks

## 1. Register the provider and its types

- [x] 1.1 Add `"opencode"` to `LLM_PROVIDER_VALUES` in `shared/src/types/settings.ts` and export any derived types. Verify: `npm run check:types:shared` passes.
- [x] 1.2 Add a strategy stub `orchestrator/src/server/services/llm/providers/opencode.ts` (provider `opencode`, `requiresApiKey: false`, `modes: ["text","none"]`, placeholder `buildRequest`/`extractText`) and register it in `providers/index.ts`. Verify: `npm --workspace orchestrator run check:types` passes.
- [x] 1.3 Add a provider label/hint in `orchestrator/src/client/pages/settings/utils.ts` (`LLM_PROVIDER_LABELS`, `PROVIDER_HINTS`) so the option renders. Verify: `npm --workspace orchestrator run build:client` passes and "OpenCode" appears in the provider selector.

## 2. Resolve endpoint and credential

- [x] 2.1 Add a resolver that reads `$XDG_STATE_HOME/opencode/service.json` (falling back to `~/.local/state/opencode/service.json`) and returns `{ url, password }`, with a fallback to a configured base URL and `OPENCODE_PASSWORD`. Verify: a unit test covers (a) file present, (b) file absent + env fallback, (c) neither present → configuration error.
- [x] 2.2 Wire the resolver into `LlmService` for the `opencode` provider so `baseUrl` and the password are taken from the resolver instead of the standard settings-only path (mirror the `codex`/CLI special-casing). Verify: a unit test asserts the resolved base URL/password are used and that no other provider is affected.
- [x] 2.3 Ensure the resolved password and `Authorization` header never reach logs or error `details` (use the shared sanitizer). Verify: a unit test asserts the password is absent from a captured log/error payload.
- [x] 2.4 Validate the endpoint/transport: default to loopback, and require a secure transport (TLS/tunnel) or refuse plaintext Basic when the host is not loopback. Verify: a unit test asserts a non-loopback plaintext endpoint is rejected or flagged and a loopback endpoint is accepted.

## 3. Generation call path

- [x] 3.1 Implement `buildRequest` to POST `{baseUrl}/api/experimental/generate` with `Authorization: Basic base64("opencode:" + password)` and body `{ prompt, model }`. Verify: a unit test asserts the URL, method, `Authorization` header, and body.
- [x] 3.2 Implement `extractText` to return `data.text`. Verify: a unit test asserts the text is extracted and that a missing `data.text` yields `null`.
- [x] 3.3 Flatten `system` + conversation messages into a single prompt string (role labels preserved, order kept). Verify: a unit test asserts a multi-message input maps to one prompt containing both parts.
- [x] 3.4 Classify errors: HTTP 401 → configuration error; 5xx/network/timeout → retryable error. Verify: unit tests for each case assert the resulting error class the flow consumes.
- [x] 3.5 Assert the provider uses only the session-less generation endpoint and never creates a session or calls the agent path. Verify: a unit test fails if any session/agent endpoint is invoked.

## 4. Structured output handling

- [x] 4.1 When a JSON schema is supplied, parse the response with `parseJsonFromContent`, validate against the schema, and on failure request a repair through the same generate endpoint (bounded attempts). Verify: unit tests for (a) valid JSON returns the object, (b) invalid-then-repaired returns the repaired object, (c) still-invalid surfaces an error.
- [x] 4.2 Ensure repair calls reuse the same auth/redaction path and do not log the prompt or password. Verify: the repair test asserts no secret is logged.

## 5. Settings and model catalogue

- [x] 5.1 Add the provider's model (and optional password) as tenant-scoped settings, and the server **endpoint as operator-level (env/global) configuration — not per-tenant**. Default the model to a free model (e.g. `opencode/space-bunny-free`). Verify: settings tests assert the model default and that a tenant cannot set or override the endpoint.
- [x] 5.2 Expose model suggestions by calling `GET {baseUrl}/api/model` for the `opencode` provider. Verify: a unit test asserts the catalogue is mapped to `providerID/modelID` suggestions.
- [x] 5.3 Render the provider's fields in Settings → Model (base URL and password only when relevant, matching the existing provider-field pattern). Verify: `npm --workspace orchestrator run build:client` passes and `SettingsPage.test.tsx` stays green.

## 6. Tests and cross-tenant coverage

- [x] 6.1 Add `providers/opencode.test.ts` covering request/response mapping, prompt flattening, discovery fallbacks, redaction, and error classification.
- [x] 6.2 Add a cross-tenant regression test asserting the tenant-scoped `opencode` settings (password, model) are scoped to the active tenant and do not leak across workspaces, and that the operator-level endpoint cannot be overridden by a tenant.
- [x] 6.3 Run the targeted tests first, then the full suite. Verify: `npm --workspace orchestrator run test:run` passes with no ignored failures.

## 7. Docs and CI-parity

- [x] 7.1 Add a user-facing docs section ("OpenCode provider") following the feature-page structure and frontmatter rules, linking related pages via `/docs/...`.
- [x] 7.2 Run the full CI-parity checks from the repo root and confirm all pass: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.
