# Proposal

## Why

An operator running JobOps against a local OpenCode server can only point JobOps at it by
editing the OpenCode service registration file or the process environment
(`OPENCODE_URL`, `OPENCODE_PASSWORD`) and restarting the deployment. Neither value is
visible or editable from the app, while Ollama's base URL is already editable in
Settings → Model. That asymmetry makes OpenCode the only LLM provider that cannot be
re-pointed without shell access to the server.

## What Changes

- Add two **operator-level** settings: `opencodeUrl` (string, URL) and `opencodePassword`
  (secret). The `settings` table is key/value, so each key is its own row; both rows share the
  same global scope `(tenant_id = DEFAULT_TENANT_ID, user_id IS NULL)` and are selected
  explicitly rather than from the caller's workspace, so every administrator and every workspace
  reads and updates the same two values and no workspace can set or override them.
- Mark both `adminOnly`, so writing them requires system-admin access. In **hosted mode the
  feature is unavailable**: the platform owns LLM configuration there, so the section is not
  shown and a write to either key is refused.
- Add an admin-only **OpenCode server** section to Settings → Model (local mode only) with
  **Server URL** and **Password** fields plus a connection check. The URL field edits only the
  stored override and stays empty when nothing is stored; the effective URL and its source are
  shown as read-only context, so saving only the password never creates a URL override. The
  password field never renders a value, so leaving it untouched omits it from the request and
  preserves the stored password, while removing it requires an explicit clear action.
- Resolve **per field** in the order **stored operator setting → service registration file →
  the matching environment variable**. A value the operator saved explicitly wins, so
  Settings can re-point an endpoint that a running `opencode serve --service` already
  published in its registration file; the file and the environment are the fallbacks while
  nothing is stored. Each field resolves independently, so a registration file carrying only
  one field does not discard the other field's fallback.
- Define the update semantics: a field omitted from `PATCH /api/settings` keeps its stored
  value, and clearing a field (`null` or an empty string) removes the override so that field
  falls through again — first to the service registration file, and to the environment only
  when the file does not provide it.
- Validate the **effective** URL: the transport guard runs against the URL that results from
  combining the payload with the stored values and the fallbacks, so a partial update (for
  example changing only the password) is validated against the URL that will actually be used.
  Whatever its source — setting, registration file, or environment — a URL must pass the guard
  before a request, and a URL carrying embedded credentials is never used or surfaced. A source
  that provides a value failing the rule **fails closed** with the configuration error instead
  of falling through to a lower source. No request is made until a URL and a password resolve
  and the guard passes.
- Make the connection check exercise **the same effective endpoint the flows use**, rather
  than a value from the form.
- **BREAKING (compatibility)**: the existing fallback that used the stored `llmApiKey` as the
  OpenCode password is removed.
- Keep the password write-only for everyone: **no response, including an administrator's,
  carries the password or any part of it**. A system administrator's response reports only
  whether a password **resolves from any source** (the stored override, the registration file, or
  the environment), never which source provides it; that indicator and the server URL are
  administrator-only, so a non-admin receives neither. The password, the `Authorization` header,
  and any server URL carrying embedded credentials never appear in logs, `error.details`, or
  responses.
- Reject a URL carrying embedded credentials (`userinfo`), since the value can be serialized
  in a settings response.
- Keep the transport guard unchanged: plaintext only for loopback and the Docker host
  aliases; any other host must use TLS.
- Update `docs-site/docs/features/settings.md`.

**Out of scope**

- Per-tenant (non-admin) endpoint configuration, and any relaxation of the transport guard.
- A general SSRF filter: the guard validates the transport, not the host, so an HTTPS
  endpoint on any host is still accepted.
- OpenCode model selection and the model catalogue (already covered by `llm-providers`).
- Onboarding changes, new environment variable names, and a general "test any provider"
  refactor of the Settings page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `llm-providers`: endpoint and credential resolution gains a persisted, operator-level
  source that takes precedence and is shared by every workspace, and the endpoint becomes
  editable from an admin-only Settings surface in local mode while staying out of tenant
  reach.

## Impact

- **Code**: `shared/src/settings-registry.ts` (two settings); the operator-tenant read/write
  for those keys; `orchestrator/src/server/api/routes/settings.ts` (authorization, effective
  URL validation, configured indicator) and the client Settings → Model page;
  `orchestrator/src/server/services/llm/credentials.ts` (drop the OpenCode password fallback)
  and `orchestrator/src/server/services/llm/opencode/service.ts` (per-field resolution order);
  `docs-site/docs/features/settings.md`.
- **Multi-tenant impact**: the two rows live in the operator tenant's global scope and are read
  explicitly, so one workspace cannot redirect another's LLM traffic and all workspaces resolve
  the same endpoint. A non-admin write is refused, and a non-admin read never receives the
  password, the server URL, or the indicator that a password is configured.
- **`/api/*` contract**: `PATCH /api/settings` gains two keys and keeps
  `{ ok: true, data, meta: { requestId } }`. A non-admin write is `403 FORBIDDEN`, a write in
  hosted mode is `403 FORBIDDEN`, a malformed or credential-bearing URL is `400
  INVALID_REQUEST`, and a remote plaintext URL is `422 UNPROCESSABLE_ENTITY`, all with the
  standard error envelope. No response carries the password.
- **Payloads**: no webhook payload changes. LLM prompts are unchanged; the resolved password
  travels only as an `Authorization: Basic` header to the configured OpenCode server.
- **Compatibility**: the `llmApiKey` password fallback is removed, and a saved value now takes
  precedence over the registration file and the environment. A deployment whose password came
  **only** from the stored `llmApiKey` does not keep working by itself: it needs a manual
  migration to the new setting, to `service.json`, or to `OPENCODE_PASSWORD`, and until then the
  OpenCode flow fails with the configuration error. Clearing a stored field falls back to the
  registration file first and to the environment only when the file does not provide it.
- **Dependencies**: none new.
