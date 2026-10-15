# Tasks

## 1. Settings registry

- [ ] 1.1 Add `opencodeUrl` (`kind: "string"`, `envKey: "OPENCODE_URL"`, nullable URL schema like `rxresumeUrl`) and `opencodePassword` (`kind: "secret"`, `envKey: "OPENCODE_PASSWORD"`) to `shared/src/settings-registry.ts`, and extend any derived shared types that do not pick the keys up automatically. Verify: `npm run check:types:shared` passes.
- [ ] 1.2 Confirm the two keys are not treated as non-admin search settings (absent from `NON_ADMIN_SEARCH_SETTING_KEYS` in `orchestrator/src/server/api/routes/settings.ts`). Verify: a focused assertion in `settings.test.ts` that a non-admin `PATCH` with `opencodeUrl` is refused (the full route coverage lands in group 3).

## 2. Endpoint and credential resolution

- [ ] 2.1 Change `resolveOpenCodeEndpoint()` in `orchestrator/src/server/services/llm/opencode/service.ts` to take a stored base URL and password, order them registration → stored setting → environment variable, and drop the `llmApiKey` password fallback. Verify: unit tests covering registration wins, stored beats env, env used when nothing is stored, and the configuration error when nothing resolves.
- [ ] 2.2 Thread the stored settings through every caller (`OpenCodeClient`, `LlmService`, and the credential path in `orchestrator/src/server/services/llm/credentials.ts` so `resolveLlmApiKey` no longer feeds the OpenCode password). Verify: `npm --workspace orchestrator run test:run -- src/server/services/llm` passes.

## 3. Settings API

- [ ] 3.1 In the `PATCH /api/settings` handler, run `assertSecureOpenCodeTransport()` when either key is present and reject with `422 UNPROCESSABLE_ENTITY` and the guard message; keep the existing `403 FORBIDDEN` for non-admins. Verify: route tests in `orchestrator/src/server/api/routes/settings.test.ts` cover a successful admin save (`{ ok: true, data, meta.requestId }`), `403` for a non-admin, `400 INVALID_REQUEST` for a malformed URL, and `422` for a remote `http://` URL.
- [ ] 3.2 Guarantee the password never leaves the server: only the masked hint (or a not-set marker) is serialized, and no log or error `details` carries the value. Verify: a route test asserting the settings read response contains no password value, plus a log assertion in the same test file.
- [ ] 3.3 Add cross-tenant regression coverage. Verify: extend `orchestrator/src/server/services/llm/opencode/cross-tenant.test.ts` so a second tenant can neither write the two keys nor read the password value, and its own resolution is unaffected.

## 4. Settings UI and docs

- [ ] 4.1 Add the admin-only "OpenCode server" section (Server URL + Password with masked hint) to the Settings → Model page, rendered when the provider is OpenCode and the caller is a system administrator. Verify: a client test (or documented manual check) shows the section for an admin and its absence for a non-admin.
- [ ] 4.2 Wire the section's connection check to the existing `POST /api/settings/llm-models` route instead of a new endpoint. Verify: the action reports success against a reachable OpenCode server and a readable failure against an unreachable one.
- [ ] 4.3 Update `docs-site/docs/features/settings.md` (OpenCode provider section: the two fields, admin-only access, and the new resolution order with its environment fallback). Verify: `npm --workspace docs-site run build` passes and the page states the precedence explicitly.

## 5. Integration verification

- [ ] 5.1 Run the CI-parity checks from the repository root and confirm every one passes with no ignored failures: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.
- [ ] 5.2 Verify end to end in Docker: save a server URL and password in Settings, then run a scoring flow and confirm the request reaches the OpenCode server with the saved values and the pipeline still scores jobs.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result and confirm the `llm-providers` spec delta was synced.
