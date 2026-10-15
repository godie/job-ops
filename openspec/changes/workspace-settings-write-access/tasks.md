# Tasks

## 1. Classification

- [x] 1.1 Add the administrator-reserved flag to the seven affected entries in `shared/src/settings-registry.ts` (`backupEnabled`, `backupHour`, `backupMaxCount`, `rxresumeUrl`, `llmBaseUrl`, `pipelineWebhookUrl`, `jobCompleteWebhookUrl`) and expose the derived set for server and client use. Verify: `npm run check:types:shared` passes and a focused assertion in `settings.test.ts` names exactly those seven keys (full enforcement coverage lands in group 2).

## 2. Server authorization

- [x] 2.1 Rewrite the `PATCH /api/settings` gate to allow any authenticated caller whose payload contains no administrator-reserved key, and delete the now-redundant `NON_ADMIN_SEARCH_SETTING_KEYS` allowlist. Verify: `orchestrator/src/server/api/routes/settings.test.ts` covers a non-admin saving `rxresumeApiKey` (`{ ok: true, data, meta.requestId }` plus the persisted value) and a non-admin saving `searchTerms` exactly as before.
- [x] 2.2 Keep administrator-reserved settings refused for members and accepted for administrators. Verify: route tests covering each of the seven keys — `403 FORBIDDEN` for a non-admin and a persisted write for a system admin — plus one test proving a mixed payload persists nothing.
- [x] 2.3 Add cross-tenant regression coverage for the settings surface. Verify: a test where two workspaces save the same key and each reads back its own value, and a member of one workspace cannot observe the other's value.

## 3. Client controls

- [x] 3.1 Filter member-facing Settings controls with the shared registry flag instead of a hardcoded list. Verify: a client test shows the administrator-reserved controls absent for a non-admin and present for a system admin.

## 4. Documentation

- [x] 4.1 Update `docs-site/docs/features/settings.md` to state that a workspace member can save their own workspace settings and to name the administrator-reserved settings. Verify: `npm --workspace docs-site run build` passes and the page lists the reserved keys explicitly.

## 5. Integration verification

- [x] 5.1 Run the CI-parity checks from the repository root and confirm every one passes with no ignored failures: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.
- [x] 5.2 Verify end to end: as a non-admin workspace user, save an integration key through Settings and then generate a PDF for a job in that workspace, confirming the save is accepted and the PDF is produced without an administrator.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result and confirm the new `settings-access-control` spec was synced.
